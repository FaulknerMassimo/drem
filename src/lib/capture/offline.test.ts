import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_QUEUED,
  OFFLINE_QUEUE_KEY,
  acknowledge,
  clearQueue,
  enqueue,
  readQueue,
  type QueueStorage,
  type QueuedCapture,
} from "./offline";

function fakeStorage(): QueueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function capture(overrides: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    id: "1",
    nightDate: "2026-08-17",
    body: "I was flying over the cathedral.",
    queuedAt: 1_755_000_000_000,
    ...overrides,
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
});

describe("the offline queue", () => {
  it("round-trips a capture", () => {
    enqueue(storage, capture());
    expect(readQueue(storage)).toEqual([capture()]);
  });

  it("keeps captures in the order they were written", () => {
    enqueue(storage, capture({ id: "1", body: "first" }));
    enqueue(storage, capture({ id: "2", body: "second" }));
    expect(readQueue(storage).map((entry) => entry.body)).toEqual(["first", "second"]);
  });

  it("drops only the entry the server confirmed", () => {
    enqueue(storage, capture({ id: "1" }));
    enqueue(storage, capture({ id: "2" }));

    expect(acknowledge(storage, "1").map((entry) => entry.id)).toEqual(["2"]);
    expect(readQueue(storage).map((entry) => entry.id)).toEqual(["2"]);
  });

  it("leaves nothing behind once the last entry is acknowledged", () => {
    enqueue(storage, capture());
    acknowledge(storage, "1");
    // Removed rather than left as "[]": nothing unsent means no key at all.
    expect(storage.map.has(OFFLINE_QUEUE_KEY)).toBe(false);
  });

  it("refuses to queue past the cap rather than growing without limit", () => {
    for (let index = 0; index < MAX_QUEUED; index += 1) {
      expect(enqueue(storage, capture({ id: String(index) })).accepted).toBe(true);
    }

    const overflow = enqueue(storage, capture({ id: "too many" }));
    expect(overflow.accepted).toBe(false);
    expect(readQueue(storage)).toHaveLength(MAX_QUEUED);
    // The rejected capture must not be silently half-stored.
    expect(readQueue(storage).some((entry) => entry.id === "too many")).toBe(false);
  });

  it("treats an unreadable queue as an empty one", () => {
    storage.map.set(OFFLINE_QUEUE_KEY, "{ this is not json");
    expect(readQueue(storage)).toEqual([]);

    storage.map.set(OFFLINE_QUEUE_KEY, '{"not":"an array"}');
    expect(readQueue(storage)).toEqual([]);
  });

  it("discards rows that are not captures instead of handing them on", () => {
    storage.map.set(
      OFFLINE_QUEUE_KEY,
      JSON.stringify([capture(), { id: "2" }, null, "nonsense"]),
    );
    // A malformed row would otherwise be posted as a capture with no body.
    expect(readQueue(storage)).toEqual([capture()]);
  });

  it("survives storage that refuses to be written to", () => {
    const readOnly: QueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    // Private-browsing modes throw on write. The capture screen must still work.
    expect(() => enqueue(readOnly, capture())).not.toThrow();
  });

  it("empties completely on request", () => {
    enqueue(storage, capture({ id: "1" }));
    enqueue(storage, capture({ id: "2" }));
    clearQueue(storage);
    expect(readQueue(storage)).toEqual([]);
  });
});
