/**
 * Generates the secrets a fresh install needs.
 *
 * MASTER_KEY is one of the two factors protecting the journal: without it the
 * database cannot be decrypted even with the right password. It must be backed
 * up separately from the database, and losing it is unrecoverable.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const masterKey = randomBytes(32).toString("base64");

if (existsSync(".env")) {
  console.error(
    "\nRefusing to print a new key: .env already exists.\n" +
      "Replacing MASTER_KEY in an existing install makes every stored entry\n" +
      "permanently unreadable. Delete .env deliberately if that is what you want.\n",
  );
  process.exit(1);
}

console.log(`MASTER_KEY=${masterKey}`);
console.error(
  "\nBack this up somewhere separate from the database.\n" +
    "Lose it and the journal is gone; leak it and one of the two factors is gone.\n",
);
