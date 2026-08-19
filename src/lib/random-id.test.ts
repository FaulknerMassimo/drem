import { afterEach, describe, expect, it } from "vitest";
import { randomUuid } from "./random-id";

/** The shape `stackIdFrom()` in capture/actions accepts; anything else it drops. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * A plain-HTTP origin: `crypto` is there, but the secure-context half is not.
 * Shadowed with an own property rather than deleted, because in Node the
 * method lives on `Crypto.prototype` and a delete off the instance is a no-op.
 */
function insecureContext(): void {
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(crypto, "randomUUID");
});

describe("randomUuid", () => {
  it("produces a v4 UUID where the platform offers one", () => {
    expect(randomUuid()).toMatch(UUID);
  });

  it("still produces one on an origin with no crypto.randomUUID", () => {
    insecureContext();
    expect(crypto.randomUUID).toBeUndefined();

    const id = randomUuid();
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("4");
    expect("89ab").toContain(id[19]);
  });

  it("does not repeat itself without randomUUID", () => {
    insecureContext();
    const ids = new Set(Array.from({ length: 500 }, () => randomUuid()));
    expect(ids.size).toBe(500);
  });
});
