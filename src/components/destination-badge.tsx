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
  compact = false,
}: {
  destination: Destination;
  /** What is about to be sent — a page, a log, or the dream itself. */
  what?: string;
  /**
   * Shortens the *local* badge to one line, for screens that would otherwise
   * repeat the same sentence three or four times over.
   *
   * Deliberately ignored when the destination leaves this machine: that
   * sentence is the one thing standing between a dream and somebody else's
   * server, and it is never the thing to shorten for tidiness.
   */
  compact?: boolean;
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

  if (compact) {
    return (
      <p role="status" className="flex flex-wrap items-center gap-1.5 text-xs text-ink-400">
        <span className="inline-block size-1.5 rounded-full bg-ok-500" aria-hidden />
        <span className="font-mono text-ink-300">{destination.model}</span>
        <span>on {destination.providerName},</span>
        <span className="text-ok-500">this machine</span>
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
