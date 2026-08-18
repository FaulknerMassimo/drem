import "server-only";
import { z } from "zod";

/**
 * Validated server configuration.
 *
 * Fails loudly at boot rather than at first use: a misconfigured MASTER_KEY
 * discovered halfway through writing a dream would mean unrecoverable data.
 */
const MASTER_KEY_BYTES = 32;

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /**
   * 32 random bytes, base64. Required alongside the password to decrypt
   * anything. Generate with `npm run keygen`.
   *
   * Rotating this invalidates every stored password hash and wrapped data key,
   * so it must be backed up with the same care as the database itself.
   */
  MASTER_KEY: z
    .string()
    .min(1, "MASTER_KEY is required - run `npm run keygen`")
    .refine(
      (value) => Buffer.from(value, "base64").length === MASTER_KEY_BYTES,
      `MASTER_KEY must decode to exactly ${MASTER_KEY_BYTES} bytes of base64`,
    ),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Public origin, used for strict Origin checks on every mutation. */
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),

  /**
   * Lets queued embedding/insight/OCR jobs run while nobody is logged in, by
   * storing a second copy of the data key wrapped under MASTER_KEY alone.
   * Weakens the threat model: MASTER_KEY plus the database then suffices to
   * decrypt the journal. Off by default.
   */
  ALLOW_BACKGROUND_PROCESSING: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * "encrypted" keeps embedding vectors encrypted at rest and runs cosine
   * similarity in memory - correct for a personal journal, where the whole
   * vector set is a few megabytes. "pgvector" trades that privacy for an ANN
   * index, and is only worth it past roughly 20k entries.
   */
  SEARCH_BACKEND: z.enum(["encrypted", "pgvector"]).default("encrypted"),

  /** Ollama runs on the host; containers reach it via host.docker.internal. */
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  WHISPER_BASE_URL: z.string().url().default("http://127.0.0.1:8000"),

  /** Where encrypted attachment blobs are written. */
  UPLOAD_DIR: z.string().default("./data/uploads"),

  /** Idle and absolute session lifetimes, in seconds. */
  SESSION_IDLE_TIMEOUT: z.coerce.number().int().positive().default(60 * 60 * 8),
  SESSION_ABSOLUTE_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

let cached: ReturnType<typeof load> | null = null;

export function env() {
  cached ??= load();
  return cached;
}

/** The decoded pepper. Kept out of `env()` so it is never logged wholesale. */
export function masterKey(): Buffer {
  return Buffer.from(env().MASTER_KEY, "base64");
}
