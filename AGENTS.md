# Working on drem

Instructions for coding agents. Read this before touching anything.

`docs/PLAN.md` holds the roadmap and which phase is next. `README.md` holds the
security model. This file holds the rules and the traps.

## What this is

A self-hosted, single-user dream journal for lucid dreaming practice, with the
journal encrypted at rest. It is not a CRUD app with a login bolted on: the
encryption is the architecture, and most of the non-obvious code exists because
of it.

## Getting it running

```bash
npm install
npm run keygen >> .env       # only on a fresh install; see the warning below
npm run dev:up               # postgres + whisper, loopback ports only
npm run db:migrate
npm run dev
```

Ollama runs on the **host**, not in a container, so it keeps GPU access.

**Never regenerate `MASTER_KEY` on an install that has data.** Every entry
becomes permanently unreadable. `scripts/generate-keys.ts` refuses to run when
`.env` exists — do not work around that.

## Testing

```bash
npm test                   # unit; no infrastructure needed
npm run test:integration   # needs `npm run dev:up`
npm run typecheck
```

The crypto suite is the gate. If it is red, nothing else matters.

`accounts.integration.test.ts` contains the assertion the whole design exists
for: seed a real entry, take a real `pg_dump`, and fail if any dream content,
the password, or `MASTER_KEY` appears in it. **If you add a new encrypted
field, add it to that test.** A field silently stored in plaintext is the single
worst bug this project can have, and it will not announce itself.

## Rules

1. **Anything a person wrote gets encrypted.** Dream text, titles, night notes,
   insights, transcripts, attachment blobs, API keys. Columns holding ciphertext
   are suffixed `Enc`; keyed fingerprints are suffixed `Bidx`. If you add a
   column without a suffix, you are asserting it is safe in a stolen dump —
   be sure that is true.

2. **Every ciphertext is bound to its slot.** `encrypt(key, value, { table,
   column, id })`. The AAD is what stops an attacker with write access moving a
   ciphertext between rows or columns. Never pass a constant or a guess.

3. **Never log or serialise plaintext.** Not to `console`, not into the audit
   log's `detail`, not into a job payload, not into an error message. Jobs carry
   identifiers only; the worker re-reads and decrypts. `global-error.tsx`
   deliberately says nothing about what failed.

4. **Keys never leave process memory.** They are not in cookies, the database,
   or any cache. If you find yourself wanting to persist a key to make something
   easier, that thing is supposed to be hard — see `ALLOW_BACKGROUND_PROCESSING`
   in `.env.example` for the one sanctioned, opt-in exception.

5. **Do not change the KDF or blind-index rules casually.** Argon2 parameters
   are stored per account and replayed on unlock; changing
   `DEFAULT_KDF_PARAMS` is safe, changing how they are *applied* is not.
   `normalizeForIndex()` must stay stable forever — changing it orphans every
   stored index and needs a reindex migration.

6. **No new outbound network calls.** CSP is `connect-src 'self'` precisely so
   an injected script has nowhere to send decrypted text. Model calls go through
   `src/lib/ai/`, are opt-in per role, and are surfaced in the UI before a dream
   leaves the machine.

## Layout

```
src/lib/crypto/     aead, kdf, envelope, blind-index, totp, recovery
src/lib/security/   headers, csrf, rate-limit, tokens
src/lib/auth/       accounts, session, key-store, pending, one-shot, actions
src/db/schema.ts    all 15 tables, with the reasoning in comments
src/app/(auth)/     setup, login, TOTP verify
src/app/(app)/      everything behind a session
```

Auth is hand-rolled rather than NextAuth because the session must hold an
unwrapped data key in memory, which no off-the-shelf adapter models.

## Traps

Every one of these cost real debugging time. They are fixed; do not reintroduce
them.

- **`Referrer-Policy: no-referrer` breaks CSRF.** Browsers then send
  `Origin: null` on native form POSTs, defeating both Next's Server Action check
  and ours. It must stay `same-origin`.
- **Never put `NODE_ENV` in `.env`.** Next sets it per command; forcing
  `development` into a production build mixes React's dev and prod bundles and
  breaks prerendering with an opaque `useContext of null`.
- **`upgrade-insecure-requests` and HSTS are gated on the real request scheme**,
  not on `NODE_ENV`. A production build on plain HTTP must not emit them or it
  rewrites its own requests to `https`.
- **Relative imports carry no `.js` extension.** Vitest tolerates it; Turbopack
  does not.
- **Middleware runs on the edge runtime** and must never transitively import
  `node:crypto`. That is why `src/lib/security/constants.ts` exists.
- **`output: "standalone"` excludes static assets.** `npm run build` copies them
  in via `build:assets`; the Dockerfile does the same. Without it you get an
  unstyled page with no JavaScript, and forms fall back to native POSTs.
- **`APP_ORIGIN` is compared literally.** `http://localhost:3000` and
  `http://127.0.0.1:3000` are different origins and CSRF will reject the mismatch.

## Style

Match the surrounding code. Comments explain *why*, especially where a choice
trades something away — the codebase is full of deliberate trade-offs that look
like mistakes without the reasoning. Tests are named as behaviour statements
(`"refuses the right password without MASTER_KEY"`), not `test1`.
