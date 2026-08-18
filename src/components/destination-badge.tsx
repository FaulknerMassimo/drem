import type { Destination } from "@/lib/ai/types";

/**
 * Names the machine a request is about to go to.
 *
 * Rendered before the Generate button, not after: the whole point is that a
 * dream does not leave without the destination being visible. Remote
 * destinations are the loud ones; local ones still name the host so a
 * mis-aimed OpenRouter URL cannot hide behind "Ollama".
 */
export function DestinationBadge({
  destination,
  what = "the dream text",
}: {
  destination: Destination;
  /** What is about to be sent — a page, a log, or the dream itself. */
  what?: string;
}) {
  if (!destination.configured) {
    return (
      <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-400">
        No model assigned. Choose one in{" "}
        <a href="/settings" className="text-lucid-300 hover:text-lucid-400">
          Settings
        </a>
        .
      </p>
    );
  }

  if (destination.leavesMachine) {
    return (
      <p
        role="status"
        className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-sm text-ink-100"
      >
        This will send {what} to{" "}
        <span className="font-medium">{destination.providerName}</span> at{" "}
        <span className="font-mono text-xs">{destination.host}</span> using{" "}
        <span className="font-mono text-xs">{destination.model}</span>. It{" "}
        <span className="text-warn-500">leaves this machine</span>.
      </p>
    );
  }

  return (
    <p
      role="status"
      className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ink-200"
    >
      This will send {what} to{" "}
      <span className="font-medium">{destination.providerName}</span> at{" "}
      <span className="font-mono text-xs">{destination.host}</span> using{" "}
      <span className="font-mono text-xs">{destination.model}</span>. It stays on
      this machine.
    </p>
  );
}
