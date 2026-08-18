/**
 * Names shared between the edge middleware and the Node server routes.
 *
 * Kept dependency-free on purpose: middleware runs on the edge runtime, so
 * anything it imports must not reach node:crypto.
 */
export const CSRF_COOKIE = "drem_csrf";
export const CSRF_HEADER = "x-drem-csrf";
export const CSRF_FIELD = "csrfToken";
