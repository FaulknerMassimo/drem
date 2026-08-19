/**
 * A v4 UUID that also exists on a plain-HTTP origin.
 *
 * `crypto.randomUUID()` is secure-context only. drem is routinely served over
 * `http://` on a LAN address — see the HSTS gating in `security/headers` — and
 * on such an origin the method is simply not there. Calling it during a client
 * render therefore threw in the browser and took the whole screen down to the
 * global error boundary, with nothing in the server log to say so, because the
 * server render had succeeded: Node has the method regardless.
 *
 * `crypto.getRandomValues()` carries no secure-context restriction, so the
 * fallback lays the same 122 random bits out by hand. It must stay a *valid*
 * UUID and not merely a unique string: these ids land in `uuid` columns, and
 * `stackIdFrom()` in `capture/actions` drops anything that fails its regex —
 * which would silently scatter one night's pages across a stack each.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
