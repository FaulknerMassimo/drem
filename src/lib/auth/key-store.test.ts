import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deriveUserKeys } from "@/lib/crypto/envelope";
import {
  __clearKeyStore,
  activeKeyCount,
  dropKeys,
  dropKeysForUser,
  getKeys,
  putKeys,
  sweepKeys,
} from "./key-store";

const TTL = 60_000;
const keysFor = () => deriveUserKeys(randomBytes(32));

describe("session key store", () => {
  beforeEach(__clearKeyStore);

  it("returns the keys held for a live session", () => {
    const keys = keysFor();
    putKeys("session-1", "user-1", keys, TTL);
    expect(getKeys("session-1", TTL)?.field.equals(keys.field)).toBe(true);
  });

  it("returns null for an unknown session", () => {
    expect(getKeys("never-existed", TTL)).toBeNull();
  });

  it("keeps sessions isolated from each other", () => {
    const a = keysFor();
    const b = keysFor();
    putKeys("session-a", "user-a", a, TTL);
    putKeys("session-b", "user-b", b, TTL);
    expect(getKeys("session-a", TTL)?.field.equals(a.field)).toBe(true);
    expect(getKeys("session-b", TTL)?.field.equals(b.field)).toBe(true);
  });

  it("expires keys once the idle deadline passes", () => {
    // No intervening access, so the deadline is never extended.
    putKeys("session-1", "user-1", keysFor(), TTL, 0);
    expect(getKeys("session-1", TTL, TTL + 1)).toBeNull();
  });

  it("keeps keys available right up to the deadline", () => {
    putKeys("session-1", "user-1", keysFor(), TTL, 0);
    expect(getKeys("session-1", TTL, TTL - 1)).not.toBeNull();
  });

  it("slides the deadline forward on each access", () => {
    putKeys("session-1", "user-1", keysFor(), TTL, 0);
    // Active use at the edge of the window should keep the session alive.
    expect(getKeys("session-1", TTL, TTL - 1)).not.toBeNull();
    expect(getKeys("session-1", TTL, TTL + TTL - 2)).not.toBeNull();
  });

  it("zeroes key material on logout rather than leaving it for the GC", () => {
    const keys = keysFor();
    putKeys("session-1", "user-1", keys, TTL);
    dropKeys("session-1");

    expect(getKeys("session-1", TTL)).toBeNull();
    // The caller's reference is wiped too: nothing usable survives in memory.
    expect(keys.field.equals(Buffer.alloc(32))).toBe(true);
    expect(keys.blob.equals(Buffer.alloc(32))).toBe(true);
  });

  it("zeroes key material when a session expires", () => {
    const keys = keysFor();
    putKeys("session-1", "user-1", keys, TTL, 0);
    expect(getKeys("session-1", TTL, TTL + 1)).toBeNull();
    expect(keys.field.equals(Buffer.alloc(32))).toBe(true);
  });

  it("drops every session for one user without touching others", () => {
    putKeys("s1", "user-1", keysFor(), TTL);
    putKeys("s2", "user-1", keysFor(), TTL);
    putKeys("s3", "user-2", keysFor(), TTL);

    expect(dropKeysForUser("user-1")).toBe(2);
    expect(getKeys("s1", TTL)).toBeNull();
    expect(getKeys("s2", TTL)).toBeNull();
    expect(getKeys("s3", TTL)).not.toBeNull();
  });

  it("wipes the displaced keys when a session id is reused", () => {
    const first = keysFor();
    putKeys("session-1", "user-1", first, TTL);
    putKeys("session-1", "user-1", keysFor(), TTL);
    expect(first.field.equals(Buffer.alloc(32))).toBe(true);
  });

  it("sweeps expired entries so uptime does not accumulate keys", () => {
    putKeys("s1", "user-1", keysFor(), TTL, 0);
    putKeys("s2", "user-1", keysFor(), TTL, 0);
    putKeys("s3", "user-1", keysFor(), TTL * 10, 0);

    expect(sweepKeys(TTL + 1)).toBe(2);
    expect(activeKeyCount()).toBe(1);
  });

  it("holds nothing once cleared", () => {
    putKeys("s1", "user-1", keysFor(), TTL);
    __clearKeyStore();
    expect(activeKeyCount()).toBe(0);
  });
});
