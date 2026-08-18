import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { authEvents } from "@/db/schema";
import { masterKey } from "@/lib/env";
import { hashIp } from "@/lib/security/tokens";

type AuthEventType = (typeof authEvents.$inferInsert)["type"];

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Appends to the audit trail.
 *
 * `detail` is stored unencrypted, so it must carry structural facts only —
 * which model was called, how many entries an export covered — and never dream
 * content. The log exists to answer "did someone else get in?", and it would be
 * self-defeating for it to become a plaintext copy of the journal.
 */
export async function recordAuthEvent(
  type: AuthEventType,
  options: {
    userId?: string | null;
    succeeded?: boolean;
    detail?: Record<string, unknown>;
    request?: RequestContext;
  } = {},
): Promise<void> {
  const { userId = null, succeeded = true, detail, request } = options;

  try {
    await db.insert(authEvents).values({
      id: randomUUID(),
      userId,
      type,
      succeeded,
      detail: detail ?? null,
      userAgent: request?.userAgent?.slice(0, 512) ?? null,
      ipHash: request?.ip ? hashIp(request.ip, masterKey()) : null,
    });
  } catch (error) {
    // Auditing must never be the reason a login fails; a lost log line is
    // strictly better than a locked-out user.
    console.error("[audit] failed to record %s: %s", type, error);
  }
}

/**
 * Extracts the client address, trusting proxy headers only when the app is
 * actually behind a proxy — otherwise a client could forge its own IP and
 * sidestep per-IP rate limiting.
 */
export function clientContext(
  headers: Headers,
  options: { trustProxy?: boolean } = {},
): RequestContext {
  const userAgent = headers.get("user-agent");
  if (!options.trustProxy) {
    return { ip: null, userAgent };
  }
  const forwarded = headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? headers.get("x-real-ip");
  return { ip: ip ?? null, userAgent };
}
