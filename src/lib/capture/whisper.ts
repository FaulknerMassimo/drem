/**
 * Speech-to-text via the local faster-whisper server.
 *
 * The audio never leaves this machine: WHISPER_BASE_URL is loopback in
 * development and the compose service on the private network in production.
 * Error messages name a host, never the recording.
 */
import "server-only";
import { env } from "@/lib/env";
import { describeNetworkError, ProviderError } from "@/lib/ai/providers/errors";
import { joinUrl } from "@/lib/ai/providers/http";

const TRANSCRIBE_TIMEOUT_MS = 180_000;

export interface Transcript {
  text: string;
  confidence: number | null;
}

export async function transcribeAudio(
  bytes: Buffer,
  mimeType: string,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Transcript> {
  const url = joinUrl(env().WHISPER_BASE_URL, "/v1/audio/transcriptions");
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  form.set("model", "Systran/faster-whisper-base");
  form.set("response_format", "verbose_json");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(describeNetworkError(url, error));
  }

  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new ProviderError(`Whisper returned HTTP ${response.status}`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError("Whisper returned a response that was not JSON");
  }

  return readTranscript(payload);
}

function readTranscript(payload: unknown): Transcript {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new ProviderError("Whisper returned an empty transcript");

  let confidence: number | null = null;
  if (Array.isArray(record.segments) && record.segments.length > 0) {
    let total = 0;
    let n = 0;
    for (const segment of record.segments) {
      if (!segment || typeof segment !== "object") continue;
      const logprob = (segment as { avg_logprob?: unknown }).avg_logprob;
      if (typeof logprob === "number" && Number.isFinite(logprob)) {
        // avg_logprob is typically in [-1, 0]; map onto a 0–1 bar.
        total += Math.min(1, Math.max(0, 1 + logprob));
        n += 1;
      }
    }
    if (n > 0) confidence = total / n;
  }

  return { text, confidence };
}
