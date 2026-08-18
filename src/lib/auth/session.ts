import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import type { UserKeys } from "@/lib/crypto/envelope";
import { env, masterKey } from "@/lib/env";
import {
  dropKeys,
  dropKeysForUser,
  getKeys,
  putKeys,
} from "./key-store";
import { generateToken, hashToken, hashIp } from "@/lib/security/tokens";

export const SESSION_COOKIE = "drem_session";

export interface ActiveSession {
  sessionId: string;
  userId: string;
  /** Present only while the session is unlocked in this process. */
  keys: UserKeys;
}

function idleTtlMs(): number {
  return env().SESSION_IDLE_TIMEOUT * 1000;
}

/**
 * Starts a session.
 *
 * The database row records that a session exists and when it dies; the key
 * store holds what makes it useful. Neither half is sufficient alone, which is
 * what makes a stolen database replay-proof.
 */
export async function createSession(
  userId: string,
  keys: UserKeys,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const sessionId = randomUUID();
  const token = generateToken();
  const now = Date.now();

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now + idleTtlMs()),
    absoluteExpiresAt: new Date(now + env().SESSION_ABSOLUTE_TIMEOUT * 1000),
    userAgent: context.userAgent?.slice(0, 512) ?? null,
    ipHash: context.ip ? hashIp(context.ip, masterKey()) : null,
  });

  putKeys(sessionId, userId, keys, idleTtlMs(), now);

  const store = await cookies();
  store.set(SESSION_COOKIE, `${sessionId}.${token}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: env().SESSION_ABSOLUTE_TIMEOUT,
  });

  return sessionId;
}

/** The cookie carries the session id and its secret, joined by a dot. */
function parseCookie(value: string): { sessionId: string; token: string } | null {
  const separator = value.indexOf(".");
  if (separator <= 0) return null;
  return {
    sessionId: value.slice(0, separator),
    token: value.slice(separator + 1),
  };
}

/**
 * Resolves the current request's session, or null.
 *
 * Returns null in three distinct situations that callers should treat
 * identically: no cookie, a cookie whose session row is dead, and a live
 * session whose keys are no longer in memory (the usual cause being a server
 * restart). In every case the only correct response is to ask for the password
 * again — there is no way to recover the keys otherwise.
 */
export async function currentSession(): Promise<ActiveSession | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  const parsed = parseCookie(cookie);
  if (!parsed) return null;

  const keys = getKeys(parsed.sessionId, idleTtlMs());
  if (!keys) return null;

  const now = new Date();
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, parsed.sessionId))
    .limit(1);

  if (!row || row.revokedAt || row.expiresAt <= now || row.absoluteExpiresAt <= now) {
    dropKeys(parsed.sessionId);
    return null;
  }

  // Constant-time equality via the digest: the presented token must hash to the
  // stored value, so a guessed session id alone gets nowhere.
  if (!row.tokenHash.equals(hashToken(parsed.token))) {
    return null;
  }

  // Slide the idle deadline, but never past the absolute ceiling.
  const nextExpiry = new Date(
    Math.min(now.getTime() + idleTtlMs(), row.absoluteExpiresAt.getTime()),
  );
  await db
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt: nextExpiry })
    .where(eq(sessions.id, row.id));

  return { sessionId: row.id, userId: row.userId, keys };
}

/** Throws rather than returning null, for routes that require a session. */
export async function requireSession(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  return session;
}

/**
 * For pages: sends the visitor to the login screen instead of throwing.
 *
 * The gate in the app layout is not sufficient on its own, because Next renders
 * layouts and pages concurrently — a page must not assume the layout's redirect
 * has already happened.
 */
export async function sessionOrRedirect(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

export async function destroySession(sessionId: string): Promise<void> {
  dropKeys(sessionId);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));

  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Signs out everywhere. Used on password change and on explicit request. */
export async function destroyAllSessions(userId: string): Promise<number> {
  const dropped = dropKeysForUser(userId);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return dropped;
}

/**
 * Deletes dead session rows. The key store expires independently in memory, so
 * this is only housekeeping for the table.
 */
export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date();
  await db
    .delete(sessions)
    .where(or(lt(sessions.absoluteExpiresAt, now), lt(sessions.expiresAt, now)));
}

/** True when no account exists yet, which is what gates the setup route. */
export async function needsSetup(): Promise<boolean> {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  return !existing;
}
