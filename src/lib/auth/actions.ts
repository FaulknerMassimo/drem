"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { decryptString } from "@/lib/crypto/aead";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { assertCsrf } from "@/lib/security/csrf-server";
import {
  LOGIN_RULES,
  TOTP_RULES,
  checkRateLimit,
  resetRateLimit,
} from "@/lib/security/rate-limit";
import {
  AuthError,
  checkPassword,
  consumeRecoveryCode,
  consumeTotp,
  createInitialAccount,
} from "./accounts";
import { clientContext, recordAuthEvent } from "./audit";
import {
  consumePending,
  dropPending,
  getPending,
  putPending,
  registerPendingFailure,
} from "./pending";
import { stashOnce } from "./one-shot";
import { createSession, currentSession, destroySession, needsSetup } from "./session";

const PENDING_COOKIE = "drem_pending";

export interface FormState {
  error?: string;
}

async function context() {
  return clientContext(await headers(), {
    // Only honour X-Forwarded-For when the app is actually behind a proxy;
    // otherwise a client could forge its own IP and evade per-IP limits.
    trustProxy: env().APP_ORIGIN.startsWith("https://"),
  });
}

/** Rate-limit keys are coarse on purpose: this instance has exactly one account. */
function accountKey(email: string): string {
  return `login:${email.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

export async function setupAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await assertCsrf(formData);

  if (!(await needsSetup())) {
    return { error: "This instance already has an account." };
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (password !== confirm) return { error: "Passwords do not match." };
  if (!email.includes("@")) return { error: "Enter a valid email address." };

  let sessionId: string;
  let account: Awaited<ReturnType<typeof createInitialAccount>>;
  try {
    account = await createInitialAccount(email, password);
    sessionId = await createSession(account.userId, account.keys, await context());
  } catch (error) {
    if (error instanceof AuthError) return { error: error.message };
    throw error;
  }

  await recordAuthEvent("login_success", {
    userId: account.userId,
    detail: { via: "setup" },
    request: await context(),
  });

  // Handed over out-of-band rather than returned as action state: once the
  // account exists this page redirects on re-render, which would discard the
  // only copy of the codes that will ever exist.
  stashOnce(sessionId, account.recoveryCodes);
  redirect("/recovery-codes");
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function loginAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await assertCsrf(formData);

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const request = await context();

  const perAccount = checkRateLimit(accountKey(email), LOGIN_RULES.perAccount);
  const perIp = checkRateLimit(`ip:${request.ip ?? "local"}`, LOGIN_RULES.perIp);
  if (!perAccount.allowed || !perIp.allowed) {
    const wait = Math.ceil(
      Math.max(perAccount.retryAfterMs, perIp.retryAfterMs) / 1000,
    );
    await recordAuthEvent("lockout", { succeeded: false, request });
    return { error: `Too many attempts. Try again in ${wait} seconds.` };
  }

  let result: Awaited<ReturnType<typeof checkPassword>>;
  try {
    result = await checkPassword(email, password);
  } catch (error) {
    if (error instanceof AuthError) {
      await recordAuthEvent("login_failure", {
        succeeded: false,
        detail: { code: error.code },
        request,
      });
      // Never distinguish "no such account" from "wrong password".
      return { error: "Invalid email or password." };
    }
    throw error;
  }

  resetRateLimit(accountKey(email));

  if (!result.totpEnabled || !result.totpSecret) {
    await createSession(result.userId, result.keys, request);
    await recordAuthEvent("login_success", { userId: result.userId, request });
    redirect("/");
  }

  // Second factor required: park the keys in memory, out of the database, and
  // hand the browser an opaque handle to them.
  const pendingId = randomUUID();
  putPending(pendingId, result.userId, result.keys);

  const store = await cookies();
  store.set(PENDING_COOKIE, pendingId, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });

  await recordAuthEvent("login_success", {
    userId: result.userId,
    detail: { stage: "password" },
    request,
  });
  redirect("/login/verify");
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

export async function verifyTotpAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await assertCsrf(formData);

  const store = await cookies();
  const pendingId = store.get(PENDING_COOKIE)?.value;
  const request = await context();

  if (!pendingId || !getPending(pendingId)) {
    return { error: "That login expired. Please start again." };
  }

  const limit = checkRateLimit(`totp:${pendingId}`, TOTP_RULES.perAccount);
  if (!limit.allowed) {
    dropPending(pendingId);
    store.delete(PENDING_COOKIE);
    await recordAuthEvent("lockout", { succeeded: false, request });
    return { error: "Too many codes tried. Please start again." };
  }

  const pending = getPending(pendingId)!;
  const submitted = String(formData.get("token") ?? "").trim();
  const useRecovery = formData.get("mode") === "recovery";

  const accepted = useRecovery
    ? await consumeRecoveryCode(pending.userId, submitted)
    : await verifyStoredTotp(pending.userId, pending.keys, submitted);

  if (!accepted) {
    const survives = registerPendingFailure(pendingId);
    await recordAuthEvent(useRecovery ? "recovery_used" : "totp_failure", {
      userId: pending.userId,
      succeeded: false,
      request,
    });
    if (!survives) {
      store.delete(PENDING_COOKIE);
      return { error: "Too many incorrect codes. Please start again." };
    }
    return { error: useRecovery ? "That recovery code is not valid." : "That code is not valid." };
  }

  const claimed = consumePending(pendingId);
  if (!claimed) return { error: "That login expired. Please start again." };

  store.delete(PENDING_COOKIE);
  await createSession(claimed.userId, claimed.keys, request);
  await recordAuthEvent(useRecovery ? "recovery_used" : "totp_success", {
    userId: claimed.userId,
    request,
  });
  redirect("/");
}

/**
 * The TOTP secret is itself encrypted, so checking a code requires the data key
 * the password step already recovered — a neat consequence of the design: the
 * second factor cannot even be evaluated without the first having succeeded.
 */
async function verifyStoredTotp(
  userId: string,
  keys: UserKeys,
  token: string,
): Promise<boolean> {
  const [user] = await db
    .select({ totpSecretEnc: users.totpSecretEnc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.totpSecretEnc) return false;

  const secret = decryptString(keys.field, user.totpSecretEnc, {
    table: "users",
    column: "totp_secret_enc",
    id: userId,
  });
  return consumeTotp(userId, secret, token);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logoutAction(formData: FormData): Promise<void> {
  await assertCsrf(formData);
  const session = await currentSession();
  if (session) {
    await destroySession(session.sessionId);
    await recordAuthEvent("logout", {
      userId: session.userId,
      request: await context(),
    });
  }
  redirect("/login");
}
