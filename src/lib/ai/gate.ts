/**
 * Server-side check that a model role is assigned, and that a remote
 * destination was acknowledged, before any dream (or page, or log) is sent.
 *
 * Shared by insight requests, OCR, and split so a crafted POST cannot skip
 * the badge that the UI shows.
 */
import "server-only";
import type { ActiveSession } from "@/lib/auth/session";
import { loadAiConfig } from "./config";
import { destinationFor } from "./destination";
import type { ModelRole } from "./types";

export async function gateDestination(
  session: ActiveSession,
  role: ModelRole,
  formData: FormData,
): Promise<{ error: string } | null> {
  const config = await loadAiConfig(session.userId, session.keys);
  const destination = destinationFor(config, role);
  if (!destination.configured) {
    return { error: "No model is assigned for this. Choose one in Settings." };
  }
  if (destination.leavesMachine && formData.get("acknowledge") !== "1") {
    return {
      error: `Confirm that you want this to be sent to ${destination.host}.`,
    };
  }
  return null;
}
