import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deriveUserKeys } from "@/lib/crypto/envelope";
import {
  PENDING_TTL_MS,
  __clearPending,
  consumePending,
  dropPending,
  getPending,
  pendingCount,
  putPending,
  registerPendingFailure,
  sweepPending,
} from "./pending";

const keysFor = () => deriveUserKeys(randomBytes(32));

describe("pending logins", () => {
  beforeEach(__clearPending);

  it("holds keys between the password and TOTP steps", () => {
    const keys = keysFor();
    putPending("p1", "user-1", keys);
    expect(getPending("p1")?.keys.field.equals(keys.field)).toBe(true);
  });

  it("does not consume the keys on a peek, so a typo is recoverable", () => {
    putPending("p1", "user-1", keysFor());
    expect(getPending("p1")).not.toBeNull();
    expect(getPending("p1")).not.toBeNull();
  });

  it("hands the keys over exactly once", () => {
    putPending("p1", "user-1", keysFor());
    expect(consumePending("p1")).not.toBeNull();
    expect(consumePending("p1")).toBeNull();
  });

  it("expires an abandoned login", () => {
    putPending("p1", "user-1", keysFor(), 0);
    expect(getPending("p1", PENDING_TTL_MS + 1)).toBeNull();
  });

  it("wipes the keys of an expired login rather than leaving them in memory", () => {
    const keys = keysFor();
    putPending("p1", "user-1", keys, 0);
    getPending("p1", PENDING_TTL_MS + 1);
    expect(keys.field.equals(Buffer.alloc(32))).toBe(true);
  });

  it("refuses to hand over keys that expired between the steps", () => {
    const keys = keysFor();
    putPending("p1", "user-1", keys, 0);
    expect(consumePending("p1", PENDING_TTL_MS + 1)).toBeNull();
    expect(keys.field.equals(Buffer.alloc(32))).toBe(true);
  });

  it("destroys the login after too many wrong codes", () => {
    putPending("p1", "user-1", keysFor());
    // Budget is five; the fifth failure ends it.
    expect(registerPendingFailure("p1")).toBe(true);
    expect(registerPendingFailure("p1")).toBe(true);
    expect(registerPendingFailure("p1")).toBe(true);
    expect(registerPendingFailure("p1")).toBe(true);
    expect(registerPendingFailure("p1")).toBe(false);
    expect(getPending("p1")).toBeNull();
  });

  it("wipes keys when abandoned explicitly", () => {
    const keys = keysFor();
    putPending("p1", "user-1", keys);
    dropPending("p1");
    expect(keys.field.equals(Buffer.alloc(32))).toBe(true);
  });

  it("keeps concurrent logins independent", () => {
    const a = keysFor();
    const b = keysFor();
    putPending("p1", "user-1", a);
    putPending("p2", "user-1", b);
    dropPending("p1");
    expect(getPending("p2")?.keys.field.equals(b.field)).toBe(true);
  });

  it("sweeps expired entries", () => {
    putPending("p1", "user-1", keysFor(), 0);
    putPending("p2", "user-1", keysFor(), 0);
    expect(sweepPending(PENDING_TTL_MS + 1)).toBe(2);
    expect(pendingCount()).toBe(0);
  });

  it("leaves no trace once cleared", () => {
    putPending("p1", "user-1", keysFor());
    __clearPending();
    expect(pendingCount()).toBe(0);
  });
});
