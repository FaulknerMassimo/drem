/**
 * Loads .env for integration tests. Hand-rolled rather than pulling in dotenv:
 * the format we generate is trivial, and this keeps a dependency out of a
 * process that handles MASTER_KEY.
 */
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const line of content.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq);
  process.env[key] ??= trimmed.slice(eq + 1);
}
