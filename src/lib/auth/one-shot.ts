/**
 * A one-shot handoff for values that must be displayed exactly once.
 *
 * Recovery codes exist only in the response that created them — they are stored
 * as fingerprints, so they cannot be regenerated or looked up later. Returning
 * them as action state does not survive the re-render that follows setup (the
 * page correctly notices an account now exists and redirects away), so they are
 * parked here instead, keyed by the session that just claimed them.
 *
 * Memory only, like the key store: writing them to the database, even briefly,
 * would defeat the point of hashing them in the first place.
 */

interface Entry {
  values: string[];
  expiresAt: number;
}

/** Long enough to write them down, short enough not to linger. */
const TTL_MS = 30 * 60 * 1000;

const globalForOneShot = globalThis as unknown as {
  dremOneShot?: Map<string, Entry>;
};
const store: Map<string, Entry> = (globalForOneShot.dremOneShot ??= new Map());

export function stashOnce(key: string, values: string[], now = Date.now()): void {
  store.set(key, { values, expiresAt: now + TTL_MS });
}

/** Returns the values and immediately forgets them. */
export function claimOnce(key: string, now = Date.now()): string[] | null {
  const entry = store.get(key);
  if (!entry) return null;
  store.delete(key);
  return entry.expiresAt > now ? entry.values : null;
}

/** Non-destructive check, so a page can decide whether to render at all. */
export function hasOnce(key: string, now = Date.now()): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    store.delete(key);
    return false;
  }
  return true;
}

export function sweepOnce(now = Date.now()): number {
  let swept = 0;
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
      swept += 1;
    }
  }
  return swept;
}

/** Test-only helper; never called from application code. */
export function __clearOneShot(): void {
  store.clear();
}
