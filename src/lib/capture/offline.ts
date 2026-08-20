/**
 * The offline capture queue.
 *
 * Capture mode exists because a dream survives about ninety seconds after
 * waking. That premise does not care whether the phone has signal, and at 4am
 * it very often does not — so when the save cannot reach the server, the words
 * go into browser storage and are sent when it comes back.
 *
 * **This is the one place dream text is written unencrypted.** Everything else
 * in the app holds to "a stolen laptop reveals nothing"; a queued capture sits
 * in `localStorage` in the clear, readable by anyone holding an unlocked
 * device. It is a deliberate trade, and these are the bounds that make it one:
 *
 *   - it holds only what has *not yet* been saved, and each entry is deleted
 *     the instant the server confirms it;
 *   - the queue is capped, so a long spell offline cannot quietly accumulate a
 *     journal on disk;
 *   - the capture screen shows the count whenever it is not zero, so text
 *     waiting here is never invisible to the person who wrote it.
 *
 * The alternative was to encrypt it, which cannot be done: the keys live in the
 * server's memory, and reaching them is exactly what is impossible here. The
 * real alternative was therefore losing the dream, which is the one outcome
 * this whole screen exists to prevent.
 *
 * Pure, over a storage interface, so the queue's behaviour is unit-testable
 * without a browser.
 */

export const OFFLINE_QUEUE_KEY = "drem.capture.queue.v1";

/**
 * Past this, a capture is refused rather than queued.
 *
 * Fifty is far more than a night's fragments and far less than an archive. The
 * cap is what stops "offline for a fortnight" turning browser storage into a
 * plaintext copy of the journal.
 */
export const MAX_QUEUED = 50;

export interface QueuedCapture {
  /** Minted on the client, so a flush that half-fails can resume precisely. */
  id: string;
  nightDate: string;
  body: string;
  queuedAt: number;
}

/** The slice of `Storage` this needs — enough to fake in a test. */
export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isQueued(value: unknown): value is QueuedCapture {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.nightDate === "string" &&
    typeof row.body === "string" &&
    typeof row.queuedAt === "number"
  );
}

/**
 * Reads the queue, treating anything unreadable as an empty one.
 *
 * Never throws. A corrupted key must not be able to break the capture screen —
 * a screen that fails to load is a dream lost, which is worse than a queue
 * lost, and the queue is only ever the copy that has not been saved yet.
 */
export function readQueue(storage: QueueStorage): QueuedCapture[] {
  try {
    const raw = storage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isQueued) : [];
  } catch {
    return [];
  }
}

function writeQueue(storage: QueueStorage, queue: readonly QueuedCapture[]): void {
  try {
    if (queue.length === 0) storage.removeItem(OFFLINE_QUEUE_KEY);
    else storage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // A full or disabled storage is not something the writer can act on at 4am.
  }
}

export interface EnqueueResult {
  queue: QueuedCapture[];
  /** False when the cap was hit and nothing was stored. */
  accepted: boolean;
}

export function enqueue(
  storage: QueueStorage,
  capture: QueuedCapture,
): EnqueueResult {
  const queue = readQueue(storage);
  if (queue.length >= MAX_QUEUED) return { queue, accepted: false };

  const next = [...queue, capture];
  writeQueue(storage, next);
  return { queue: next, accepted: true };
}

/** Drops one entry, by id, once the server has confirmed it. */
export function acknowledge(storage: QueueStorage, id: string): QueuedCapture[] {
  const next = readQueue(storage).filter((entry) => entry.id !== id);
  writeQueue(storage, next);
  return next;
}

export function clearQueue(storage: QueueStorage): void {
  writeQueue(storage, []);
}
