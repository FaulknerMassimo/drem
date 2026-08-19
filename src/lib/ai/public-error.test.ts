import { describe, expect, it } from "vitest";
import { RoleNotConfiguredError } from "./chat";
import { describeNetworkError, ProviderError } from "./providers/errors";
import { publicModelError } from "./public-error";

describe("publicModelError", () => {
  /*
   * The regression this function exists for. The split action used to test for
   * a "Timed out" prefix, and the provider layer had already reworded its
   * timeout to name the host and the budget instead -- so the message that
   * says exactly what went wrong was replaced by a shrug. A model that cannot
   * finish inside its budget is the normal failure on local inference, and it
   * is the one the operator can act on.
   */
  it("passes a timeout through however the provider layer words it", () => {
    const timeout = new ProviderError(
      describeNetworkError(
        "http://host.docker.internal:11434/api/chat",
        timeoutError(),
        300_000,
      ),
    );
    const message = publicModelError(timeout, "The split request failed.");
    expect(message).toContain("host.docker.internal:11434");
    expect(message).toContain("300s");
    expect(message).not.toBe("The split request failed.");
  });

  it("passes through a model that spent its budget before answering", () => {
    const spent = new ProviderError(
      "The model used its whole token budget before answering. Try a model that does not think, or a shorter period.",
    );
    expect(publicModelError(spent, "The split request failed.")).toBe(spent.message);
  });

  it("names the unassigned role", () => {
    expect(publicModelError(new RoleNotConfiguredError("split"), "nope")).toBe(
      "No model is assigned for split.",
    );
  });

  it("passes through a reply that was not JSON", () => {
    const error = new Error("The model did not return JSON.");
    expect(publicModelError(error, "nope")).toBe("The model did not return JSON.");
  });

  /*
   * The reason the cascade is an allowlist and not a passthrough: an error
   * from anywhere else may have been built out of the request, and the request
   * is a dream.
   */
  it("flattens an unrecognised error rather than risk quoting the log", () => {
    const leaky = new Error("failed on input: I was flying over the cathedral of bees");
    expect(publicModelError(leaky, "The split request failed.")).toBe("The split request failed.");
  });
});

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}
