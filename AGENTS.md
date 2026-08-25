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
npm run test:integration   # needs `npm run dev:up`; runs against drem_test, never the live journal
npm run typecheck
```

The crypto suite is the gate. If it is red, nothing else matters.

`accounts.integration.test.ts` contains the assertion the whole design exists
for: seed a real entry, take a real `pg_dump`, and fail if any dream content,
the password, or `MASTER_KEY` appears in it. **If you add a new encrypted
field, add it to that test.** A field silently stored in plaintext is the single
worst bug this project can have, and it will not announce itself.

`journal.integration.test.ts` makes the same assertion over the *application's*
write path rather than hand-built rows, and reads the bytes back out in SQL
instead of shelling out to `pg_dump` — so it runs without Docker access. Add new
encrypted fields to both.

`backup.integration.test.ts` makes the same assertion over the file the app
hands to the browser: export a seeded journal, then fail if a word of dream
content appears in the archive's bytes. **If you add a field to the archive,
add a canary for it there** — an archive is the copy most likely to be carried
around on a USB stick, and a field that ends up in it unencrypted leaks further
than a database column would.

`semantic.integration.test.ts` adds the assertion for the one column that is
readable only by opt-in: under the default `SEARCH_BACKEND=encrypted`,
`embeddings.vector` must stay null. A vector is invertible enough to leak the
gist of an entry, so it filling itself in makes the trade-off for the operator.

`npm run seed -- --email ... --password ...` fills a development journal with
months of plausible nights. Features about shape over time — the heatmap, the
streaks — look fine and prove nothing with four hand-typed entries.

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

7. **Nothing is sent as a side effect of saving unless it stays local.**
   Embeddings are queued automatically on write *only* when the embedding role
   points at this machine — see `queueLocalEmbeddings()`. A remote model has to
   be asked for from a screen that shows the badge and takes an acknowledgement.
   Any future background work that touches a model inherits this rule.

## Layout

```
src/lib/crypto/     aead, kdf, envelope, blind-index, totp, recovery, archive
src/lib/security/   headers, csrf, rate-limit, tokens
src/lib/auth/       accounts, session, key-store, pending, one-shot, actions
src/lib/journal/    nights, dreams, tags, stats + pure: dates, heatmap, streaks,
                    analytics
src/lib/ai/         providers, encrypted config, prompts, insights, job worker
src/lib/capture/    encrypted attachments, stack reading, whisper, import, split
src/lib/semantic/   embeddings, meaning-based search, dream signs + pure:
                    vectors, correlation, text, signs-parse
src/lib/backup/     passphrase-sealed export and merge-restore + pure: document
src/db/schema.ts    all 15 tables, with the reasoning in comments
src/app/(auth)/     setup, login, TOTP verify
src/app/(app)/      everything behind a session
src/app/(capture)/  the 3am screen, deliberately outside the app chrome
```

`src/lib/journal/` is split so the parts worth testing can be tested: `dates`,
`heatmap`, `streaks`, `words` and `validation` are pure and have unit suites;
`nights`, `dreams`, `tags` and `stats` touch the database and are covered by
`journal.integration.test.ts`. `src/lib/capture/` follows the same split:
`fields`, `import-parse` and `image` are pure; attachments and the stack
reading worker are covered by `capture.integration.test.ts`.
`src/lib/semantic/` is the same again: `vectors`, `correlation`, `text` and
`signs-parse` are pure and have unit suites; `embeddings`, `search`, `signs`
and the job bodies in `process.ts` are covered by
`semantic.integration.test.ts`. `src/lib/backup/` follows it too: `document`
is pure, and `export`/`restore` are covered by `backup.integration.test.ts`.
The container they use, `crypto/archive.ts`, is part of the crypto gate and has
its own unit suite. `labels.ts` is duplicated from the schema enums
on purpose, so client components do not pull Drizzle into the browser bundle —
`validation.ts` and `signs-parse.ts` hold compile-time guards against the two
drifting.

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
  Next runs its *own* Server Action origin check against the real request host on
  top of ours, so a dev server on a different port fails both — set `APP_ORIGIN`
  to match whatever port it actually bound to.
- **Scripts must run with `--conditions=react-server`.** Anything importing
  `src/db` or `src/lib/journal` transitively imports `server-only`, which throws
  under Node's default resolution and resolves to a no-op under that condition.
  See the `seed` script in `package.json`.
- **A row's id must be resolved before its ciphertext is encrypted.** The AAD
  binds a value to the row it lands in, so an upsert that mints a fresh uuid,
  encrypts under it and then updates an existing row writes a field nobody can
  ever decrypt. `saveNight()` resolves the night first for this reason.
- **De-duplicate tag ids, not tag names.** Normalisation folds Unicode form,
  case and whitespace together, so two names that look different can share one
  fingerprint — attaching both to a dream collides on `dream_tags`' primary key.
  Dream signs share the fingerprint scheme and the same trap.
- **Vectors from two models must never be compared.** `embeddings.model` holds
  `<model>@v<EMBEDDING_TEXT_VERSION>`, and every read filters on it. Changing
  what `embeddingText()` composes without bumping that version silently mixes
  two meanings of "this entry" in one index.
- **A scan's entry indices are validated against the window that was sent.**
  The reply numbers entries from 1; an index outside the window is dropped, not
  clamped. Clamping files a real dream sign against an unrelated entry, and
  nothing downstream can tell that it is wrong. A stack reading's `pages`
  indices are the same rule (`pageList()` in `capture/fields.ts`): a page
  number the stack does not have is dropped, because clamping files a
  photograph against a dream it has nothing to do with.
- **A photographed night is copied a page at a time, then split.** One vision
  call carrying every page and answering with the *dreams* produced a
  paraphrase of the night instead of the words on the page — mixed fragments,
  invented spellings, lost lines — and changing the prompt or the model did
  not recover the copy. Each page is transcribed on its own; the copies are
  joined in photograph order; the existing split role carves the log. The
  stack still groups the night (no tick-box join). `MAX_STACK_PAGES` bounds
  how many photographs one job will copy. Raising it without raising the
  split budget reproduces the failure the split role was already caught by:
  a transcript cut off mid-sentence at the same place every time.
- **A reviewed capture is not a draft.** `isDraft` means "captured, not yet
  written up", which is what 3am capture mode leaves behind because it
  deliberately asks nothing. The review screen has just asked for everything,
  so filing its result as a draft sends the writer to `/drafts` to declare it
  finished a second time.
- **Never hand the key store the keys a test is still using.** `dropKeys` wipes
  the buffers it was given, so `__clearKeyStore()` in an `afterEach` zeroes the
  suite's own `keys` in place. Every later test then encrypts under a zero key
  and fails to decrypt something written before it, several tests away from the
  cause. Put a copy in — see `lendKeysToWorker()` in
  `capture.integration.test.ts`.
- **`<li>` cannot nest.** `DreamRow` *is* the `<li>`; wrapping it in another one
  to hang a similarity score off it is invalid HTML and a hydration error. Pass
  `aside` instead, or use `ScoredDreamList`.
- **Integration tests never share the live journal database.** They create and
  truncate `drem_test`. Pointing them at `drem` (or dumping `drem` from
  `pg_dump`) wipes the owner's account and the app falls back to `/setup`.
- **A client component must not import `crypto/archive.ts`.** It reaches Argon2
  through `kdf.ts`, and the build fails trying to resolve `verify` out of
  `@node-rs/argon2/browser.js`. `MIN_PASSPHRASE_LENGTH` is passed to the export
  form as a prop from the server page for this reason — the same reason
  `journal/labels.ts` exists apart from the schema enums.
- **`crypto.randomUUID()` is secure-context only**, and the offline capture
  queue mints ids on a phone that is very often on a plain-HTTP LAN origin. Use
  `randomUuid()` from `src/lib/random-id.ts`. This is the same trap the stack-id
  fix already paid for once.
- **The service worker caches the capture shell and static assets, nothing
  else.** Every other route renders decrypted dream text, and a cached copy of
  one would be plaintext in the browser's cache directory, surviving lock,
  logout and the restart that is supposed to end every session. Requests that
  are not whitelisted are passed through without a `respondWith` so the worker
  never sees their bodies. If you add a route to that list, be certain it
  renders nothing a person wrote.
- **`sw.js` is excluded from the middleware matcher.** A service worker is
  governed by the CSP delivered with its own script, and the per-request nonce
  policy is meaningless in a worker scope — `'strict-dynamic'` on a script that
  was never loaded from a tag is a way to have it refuse to run. Its headers
  live in `next.config.ts`.
- **A queued offline capture is only ever dropped by a confirmed save.** An
  entry the server rejects stays on the device and is retried forever, which is
  deliberate: discarding it destroys the dream, which is the one thing capture
  mode exists to prevent. The count on screen is what makes a stuck queue
  visible.
- **A restore must stay idempotent.** `dreamFingerprint()` is over the date and
  the text only — deliberately not the ratings, so an entry edited since the
  backup is still recognised as the same dream. Widening it to cover the
  ratings would make every restore after an edit silently duplicate entries,
  and the restore screen offers no preview precisely because it is repeatable.
- **`db.execute(sql\`... ${aDate} ...\`)` does not serialise a `Date`.**
  postgres.js throws `ERR_INVALID_ARG_TYPE` on it. Use the query builder
  (`db.update(...).set({ createdAt })`), which types the parameter properly.
- **A queued job that fails must say so on the screen that asked for it.**
  Every provider message is written to be read by the operator and is already
  safe to persist — that is what `publicModelError` is for — but for a long
  time only the page-reading review screen read `jobs.last_error`. Everywhere
  else a request that could not reach the model spun for the whole retry
  budget under "Generating…" and then reverted to its button with nothing said,
  which is indistinguishable from never having been asked. Any new screen that
  enqueues work reads `latestJobState` / `jobQueueSummary` and renders
  `<JobStatus>`; a spinner with no failure state is not finished.
- **The service worker is registered in production only.** It is cache-first
  over `/_next/static/`, which is right for a build — those paths carry a
  content hash — and wrong for `next dev`, which serves changed bytes at the
  same path. It pins the first stylesheet it sees and no reload can dislodge
  it, because the request never reaches the server: the symptom is new
  Tailwind utilities silently doing nothing while old ones still work.
  `ServiceWorker` unregisters any worker it finds outside production, since a
  worker installed once keeps answering.
- **`VALENCE_LABELS` cannot be iterated for display.** It is keyed -2…2, and
  JavaScript puts an object's integer-like keys first in ascending order and
  the rest in insertion order — so `Object.entries` yields Neutral, Pleasant,
  Blissful, Nightmarish, Unpleasant, and the emotional-tone control shipped in
  that order. Anything ordered reads from an explicit list (`VALENCE_ORDER`).
- **A model's answer is markdown, and is never HTML.** Every chat model writes
  `**Recurring Places:**` and numbered lists whether the prompt asks for it or
  not, so rendering an insight or a report with `whitespace-pre-wrap` puts raw
  asterisks on the page. `<ModelProse>` renders the small grammar they
  actually use — headings, lists, bold, italic, code — as React nodes.
  It must stay that way: the string is derived from something a person wrote
  and has been through a model, so `dangerouslySetInnerHTML` and any markdown
  library that emits HTML are both out, for the same reason the dream body is
  rendered as text. The dream body itself stays plain: it is not markdown and
  must never be read as any.
- **Tailwind breakpoints are viewport-wide, not container-wide.** The sidebar
  takes 14rem out of the middle of the page, so `lg:grid-cols-4` on a card
  inside `<main>` is deciding on a width the cards do not have. Check what the
  container actually gets before picking the breakpoint.

## Style

Match the surrounding code. Comments explain *why*, especially where a choice
trades something away — the codebase is full of deliberate trade-offs that look
like mistakes without the reasoning. Tests are named as behaviour statements
(`"refuses the right password without MASTER_KEY"`), not `test1`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
