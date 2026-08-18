/**
 * The in-memory home of every unlocked data key.
 *
 * This module is the reason a stolen database is inert. Decryption keys exist
 * here and nowhere else: not in the cookie (which holds only an opaque token),
 * not in the session row (which holds only that token's hash), not on disk.
 *
 * Consequences worth being explicit about:
 *
 *   - Restarting the server logs everybody out. That is by design, not a bug.
 *   - Queued AI jobs can only run while a session is live, unless
 *     ALLOW_BACKGROUND_PROCESSING is enabled.
 *   - This assumes a single application process. Running multiple replicas
 *     would give each its own store and sessions would appear to flap between
 *     them; a shared store would mean keys leaving process memory, which is
 *     exactly what this design refuses to do.
 */
import { wipeUserKeys, type UserKeys } from "@/lib/crypto/envelope";

interface Entry {
  userId: string;
  keys: UserKeys;
  /** Sliding deadline, pushed forward on each access. */
  expiresAt: number;
}

/** Survives dev-mode hot reloads, which would otherwise log you out on save. */
const globalForKeys = globalThis as unknown as {
  dremKeyStore?: Map<string, Entry>;
};
const store: Map<string, Entry> = (globalForKeys.dremKeyStore ??= new Map());

export function putKeys(
  sessionId: string,
  userId: string,
  keys: UserKeys,
  ttlMs: number,
  now = Date.now(),
): void {
  // Replacing an entry must not orphan the previous key material.
  const existing = store.get(sessionId);
  if (existing) wipeUserKeys(existing.keys);
  store.set(sessionId, { userId, keys, expiresAt: now + ttlMs });
}

/**
 * Returns the keys for a live session, extending its lifetime. Returns null for
 * unknown or expired sessions — the caller must treat that as "locked" and force
 * a fresh login rather than falling back to any other source.
 */
export function getKeys(
  sessionId: string,
  ttlMs: number,
  now = Date.now(),
): UserKeys | null {
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    dropKeys(sessionId);
    return null;
  }
  entry.expiresAt = now + ttlMs;
  return entry.keys;
}

/**
 * Keys for a user who has any live session in this process.
 *
 * Used by the job worker: queued work carries identifiers, not keys, and
 * re-reads them here. Does not slide the session deadline — a long model call
 * must not keep someone logged in past their idle timeout.
 */
export function peekKeysForUser(userId: string, now = Date.now()): UserKeys | null {
  for (const entry of store.values()) {
    if (entry.userId === userId && entry.expiresAt > now) return entry.keys;
  }
  return null;
}

export function dropKeys(sessionId: string): void {
  const entry = store.get(sessionId);
  if (!entry) return;
  wipeUserKeys(entry.keys);
  store.delete(sessionId);
}

/** Used by "sign out everywhere" and by password changes. */
export function dropKeysForUser(userId: string): number {
  let dropped = 0;
  for (const [sessionId, entry] of store) {
    if (entry.userId === userId) {
      dropKeys(sessionId);
      dropped += 1;
    }
  }
  return dropped;
}

/** Zeroes expired key material rather than waiting for the GC to get round to it. */
export function sweepKeys(now = Date.now()): number {
  let swept = 0;
  for (const [sessionId, entry] of store) {
    if (entry.expiresAt <= now) {
      dropKeys(sessionId);
      swept += 1;
    }
  }
  return swept;
}

export function activeKeyCount(): number {
  return store.size;
}

/** Test-only helper; never called from application code. */
export function __clearKeyStore(): void {
  for (const sessionId of [...store.keys()]) dropKeys(sessionId);
}
