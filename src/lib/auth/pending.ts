/**
 * Holds a half-finished login between the password step and the TOTP step.
 *
 * The data key is recovered by the password, but the session must not exist
 * until the second factor is proven. Parking the keys here for a few minutes is
 * what lets both be true. Nothing is written to the database: an abandoned
 * login should leave no trace at all.
 */
import { wipeUserKeys, type UserKeys } from "@/lib/crypto/envelope";

/** Long enough to fetch a phone, short enough that an unattended screen is not a key. */
export const PENDING_TTL_MS = 5 * 60 * 1000;
/** Independent of the rate limiter: this caps attempts against one login attempt. */
const MAX_ATTEMPTS = 5;

interface Pending {
  userId: string;
  keys: UserKeys;
  expiresAt: number;
  attempts: number;
}

const globalForPending = globalThis as unknown as {
  dremPendingLogins?: Map<string, Pending>;
};
const store: Map<string, Pending> = (globalForPending.dremPendingLogins ??= new Map());

export function putPending(
  pendingId: string,
  userId: string,
  keys: UserKeys,
  now = Date.now(),
): void {
  const existing = store.get(pendingId);
  if (existing) wipeUserKeys(existing.keys);
  store.set(pendingId, {
    userId,
    keys,
    expiresAt: now + PENDING_TTL_MS,
    attempts: 0,
  });
}

/** Peeks without consuming, so a mistyped code does not restart the login. */
export function getPending(
  pendingId: string,
  now = Date.now(),
): { userId: string; keys: UserKeys } | null {
  const entry = store.get(pendingId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    dropPending(pendingId);
    return null;
  }
  return { userId: entry.userId, keys: entry.keys };
}

/**
 * Records a failed second factor. Returns false once the attempt budget is
 * spent, at which point the pending login is destroyed and the user starts over
 * from the password.
 */
export function registerPendingFailure(pendingId: string): boolean {
  const entry = store.get(pendingId);
  if (!entry) return false;
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    dropPending(pendingId);
    return false;
  }
  return true;
}

/** Hands the keys over to a real session, removing them from the pending store. */
export function consumePending(
  pendingId: string,
  now = Date.now(),
): { userId: string; keys: UserKeys } | null {
  const entry = store.get(pendingId);
  if (!entry) return null;
  store.delete(pendingId);
  if (entry.expiresAt <= now) {
    wipeUserKeys(entry.keys);
    return null;
  }
  return { userId: entry.userId, keys: entry.keys };
}

export function dropPending(pendingId: string): void {
  const entry = store.get(pendingId);
  if (!entry) return;
  wipeUserKeys(entry.keys);
  store.delete(pendingId);
}

export function sweepPending(now = Date.now()): number {
  let swept = 0;
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) {
      dropPending(id);
      swept += 1;
    }
  }
  return swept;
}

export function pendingCount(): number {
  return store.size;
}

/** Test-only helper; never called from application code. */
export function __clearPending(): void {
  for (const id of [...store.keys()]) dropPending(id);
}
