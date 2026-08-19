/**
 * Turns a failed model call into one sentence that is safe to show.
 *
 * Four call sites needed this and each grew its own copy, which is how the
 * split action ended up sniffing for a "Timed out" prefix that the provider
 * layer had long since reworded: the copies drifted, and the one that drifted
 * swallowed the message its users most needed to read.
 *
 * The test is the error's type, never its wording. `ProviderError` and
 * `RoleNotConfiguredError` are both built to be read by the operator -- they
 * name a host, a status code, or a role, and never a prompt or a completion.
 * Anything else is flattened to the caller's fallback, because an error this
 * does not recognise may have a dream inside it.
 */
import "server-only";
import { RoleNotConfiguredError } from "./chat";
import { ProviderError } from "./providers/errors";

export function publicModelError(error: unknown, fallback: string): string {
  if (error instanceof RoleNotConfiguredError) return error.message;
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && error.message === "The model did not return JSON.") {
    return error.message;
  }
  return fallback;
}
