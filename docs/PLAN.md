# drem — implementation plan

## Context

A self-hosted dream journal built for lucid dreaming practice, not just dream
recording. The three things a paper journal cannot do, and which this exists to
provide:

1. **Show whether the nightly recall habit is holding** — a GitHub-style
   activity heatmap over months of entries.
2. **Surface recurring dream signs** — the people, places and impossible details
   that repeat across an archive, which are the cues that trigger lucidity.
   Nobody spots these by hand across a year of entries.
3. **Catch a dream before it evaporates** — capture at 4am, on a phone, in the
   dark, offline.

Dream content is closer to a therapy record than a blog: real names, places,
fears, waking-life detail. The security bar is therefore *"a stolen laptop or a
leaked database dump reveals nothing"*, not *"there is a login page"*.

## Decisions

Settled up front with the repository owner; treat these as fixed unless they say
otherwise.

| Decision | Choice |
| --- | --- |
| Stack | Next.js (App Router) + TypeScript + Tailwind |
| Encryption | Envelope encryption at rest, per-user data key |
| Accounts | Single user, TOTP 2FA, no registration route |
| AI providers | Pluggable: Ollama, any OpenAI-compatible endpoint, Anthropic |
| Infrastructure | Docker Compose + Postgres 17/pgvector + faster-whisper |
| Embeddings | `embeddinggemma:300m` (768-dim) |
| Delivery | Phased; each phase ends runnable |

Deviations from the original plan, all deliberate:

- **Next 16, not 15.** Next 15 was superseded during the build; 16 is the same
  App Router architecture.
- **Argon2 cost parameters are stored per account**, not hardcoded. Hardcoding
  them was a latent data-loss bug: raising the work factor later changes the
  derived key and would permanently brick every existing entry. See
  `src/lib/crypto/kdf.ts`.
- **A heatmap cell links to its night, not to a filtered list.** "Click to
  filter" read naturally as filtering the journal list to one day, but that
  makes every unwritten square a dead end. `/night/2026-08-17` shows the day's
  entries *and* offers to start one, which is what clicking an empty square is
  actually for.
- **The heatmap opens on a trailing year, not the calendar year.** A calendar
  grid is mostly blank for most of the year — in January it is one column of
  squares and fifty of nothing, which says something about today's date rather
  than about the practice. The default window ends today and reaches 52 whole
  weeks back, so it is always full and always about the last year of recall.
  The year picker stays, for looking back at a year that is over.
- **A photographed night is copied a page at a time, then split.** The original
  one-call stack reading asked a vision model to transcribe several pages *and*
  carve them into dreams. On real handwriting that produced a paraphrase of
  the night instead of the words on the page, and prompt tweaks made it worse.
  Each page is copied on its own; the copies are joined in photograph order;
  the split role carves the log. The stack still groups the night, so the
  writer does not tick-box join pages. `MAX_STACK_PAGES` is how many
  photographs one job will copy; a longer night is a second stack, not a
  second flow.
- **Entries are indexed automatically only when the embedding model is local.**
  Search is useless if the index lags the journal, but embedding sends the entry
  somewhere, and the rule everywhere else is that nothing leaves the machine
  without the destination being on screen first. Splitting on locality keeps
  both: a local model indexes as you write, a remote one has to be asked for on
  the search page, where the badge and the acknowledgement are.
- **An archive is protected by one factor, and everything else by two.** A
  backup that still needed `MASTER_KEY` would be destroyed by the accident it
  exists to insure against, and would add nothing over a `pg_dump`. So the
  export is sealed by its passphrase alone — the single deliberate weakening in
  the codebase. It is bounded by running the KDF at full cost, refusing a short
  passphrase, and saying so on the screen that writes the file.
- **A restore merges; it never replaces.** The two real restores are "into an
  empty journal" (where merge and replace are identical) and "I want March
  back" (where replacing destroys everything written since). The second has no
  safe destructive version, so it is not offered. Entries are deduplicated on a
  digest of date and text, which makes a restore repeatable rather than
  cumulative — the property that lets it be run without a preview step.
- **The archive carries the journal, not what was derived from it.** Insights,
  embeddings, dream signs and chat transcripts are rebuilt or started again
  from restored entries. Carrying them would roughly double the file with data
  that is stale as soon as a prompt or model changes.
- **Statistics divide by nights journalled, not nights recalled.** The
  dashboard's headline lucid rate answers "when I remembered a night, how often
  was it lucid"; a technique has to answer "when I did WBTB, did it work", and a
  WBTB night you remembered nothing from is a night it did not work. Excusing
  those would flatter every technique in proportion to how badly it wrecked
  recall. The two numbers therefore disagree, and the page says so.
- **A bucket with no nights in it has no rate, not a rate of zero.** A month you
  did not journal is drawn as a gap; putting it on the floor of the chart says
  you tried and failed, which is a different and untrue statement.
- **Development runs against a separate cluster under a published key.** The
  first arrangement had one database and one `MASTER_KEY` for both the real
  journal and the seeded one, which meant the commands that make development
  bearable — truncate, re-seed, drop and migrate — were all one stale
  environment variable away from the entries the project exists to protect. The
  split is by cluster rather than by database, so `down -v` cannot cross it, and
  by key rather than by convention, so a process pointed at the wrong journal
  fails to decrypt rather than succeeding quietly. The development key is
  committed in the clear: a checkout that runs without a setup step is worth
  more than a secret protecting fabricated dreams, and a key nobody could mistake
  for a real one is safer than one that looks real. See `CONTRIBUTING.md`.
- **Offline capture keeps plaintext in `localStorage`.** The only place in the
  app dream text is written unencrypted outside the database. The keys live in
  the server's memory, so reaching them is exactly what is impossible when
  offline; the real alternative was losing the dream. Bounded by a cap, by
  deleting each entry the moment the server confirms it, and by showing the
  count on screen.
- **A model call that fails says so where it was asked for.** The queue always
  recorded why — `jobs.last_error` holds a sentence written for the operator,
  naming a host or a status and never a prompt — but only the page-reading
  review screen ever read it. Everywhere else three attempts over about five
  minutes ran behind the word "Generating…" and then put the button back with
  nothing said, so an unreachable Ollama, a model tag with a typo in it and a
  role nobody had assigned all looked identical to each other and to nothing
  happening at all. That, rather than anything about the models, is what "the
  AI features are broken" meant.
- **Roles are picked from the models the provider has.** Assigning eight roles
  by typing exact model tags from memory was the whole of the setup, and a typo
  did not fail at the point of typing — it failed inside a job, silently, per
  the entry above. A local provider is asked what it has installed when the
  page renders, and the roles become lists; free text stays for anything that
  cannot be listed. Only *local* providers are asked without being told to,
  which is the same rule the embedding role already follows: listing a remote
  provider's models on every visit is an unprompted request to somebody else's
  server.
- **Navigation is grouped by when it is reached for.** Ten links of equal
  weight with no current-page marker put "write up last night" beside "restore
  a backup". The sidebar groups them Write / Journal / Patterns / System, which
  is the journal's own rhythm, and marks where you are.
- **The badge shortens only when the dream stays here.** One entry showed the
  same sentence about the same local model four times over. A local
  destination collapses to one line; a destination that leaves the machine
  ignores `compact` entirely and keeps the full sentence and its
  acknowledgement, because that is the sentence the whole scheme exists for.
  `destination-badge.test.tsx` pins it.

## Security model

Read `README.md` for the full write-up. In brief:

```
password ──argon2id(salt A, pepper = MASTER_KEY)──> auth hash        (stored)
         └─argon2id(salt B, pepper = MASTER_KEY)──> KEK              (never stored)
                                                     │
DEK (random 32 bytes) ──AES-256-GCM(KEK)──> wrapped data key         (stored)
```

Unwrapped keys live **only in the memory of a live session**. Restarting the
server logs everybody out; that is the design working, not a bug.

## Phases

Each phase must end in a state that runs. Do not start the next one until the
current one's tests pass.

- [x] **0 — Scaffold.** Next.js + TS + Tailwind, Drizzle, Docker Compose,
      `.env.example`, `MASTER_KEY` generator, migrations.
- [x] **1 — Security foundation.** Crypto core, session key store, TOTP with
      single-use time steps, recovery codes, CSRF, rate limiting, security
      headers, audit log, and the setup/login/recovery UI. Verified end to end
      in a browser against a live database.
- [x] **2 — Journal core.** Nights and dreams CRUD, entry editor with full
      metadata, list/filter/sort, tags, **activity heatmap** (53×7 grid, year
      picker, lucid nights visually distinct, click-to-filter), recall and lucid
      streaks, **3am capture mode** (deep-red/black single-field screen feeding a
      draft queue). Verified end to end over HTTP against a live database.
- [x] **3 — AI insights.** Provider layer with adapters and per-role model
      config, settings UI with connection test, the four insight kinds
      (extraction → lucidity coach → symbolic reading → period reports), job
      queue, and a visible badge naming where a request is about to go before
      any dream leaves the machine.
- [x] **4 — Capture.** Encrypted attachments, photo OCR with side-by-side review
      (pages left, entries right, per-field confidence, nothing saved
      unconfirmed), bulk multi-page import, voice memo → faster-whisper,
      JSON/Markdown/CSV import, and AI splitting of a log that contains several
      dreams into separate entries.
- [x] **5 — Semantic layer.** Embedding pipeline with backfill and staleness
      tracking, meaning-based search, "dreams like this", AI dream-sign detection
      with per-sign frequency and lucidity correlation against the archive's own
      lucid rate. Verified end to end over HTTP against a live database and a
      local `embeddinggemma`.
- [x] **6 — Analytics and polish.** Statistics page (lucid rate and recall over
      time, technique effectiveness against the archive's own baseline, vividness
      /control/clarity trends), installable PWA with offline capture,
      passphrase-sealed export and merge-restore, `docs/BACKUP.md`. Period
      reports already shipped in phase 3. Verified end to end over HTTP against
      a live database seeded with 400 days of nights.
- [x] **7 — Make it usable daily.** Queue failures surfaced on every screen
      that enqueues work, model roles assigned from the provider's own list,
      grouped sidebar navigation with a current-page marker, the entry editor's
      six ratings as one-click rows instead of six dropdowns, and the
      explanatory prose folded behind `<Why>` on the screens that opened with
      several paragraphs of it. Verified end to end over HTTP against a live
      database and a local Ollama, including the failure path with the model
      server stopped.
- [x] **8 — Journal chat.** Encrypted conversation history and a bounded,
      provider-native tool loop over dreams, nights, notes, signs, tags,
      reports, exact text search, activity and technique statistics. Tools are
      read-only, validated server-side, and their decrypted results are never
      persisted.

## Data model notes

`nights` is the primary unit, **not** `dreams`. A night with zero recall still
matters for streaks and technique statistics, and a heatmap that cannot
distinguish "no dream" from "did not journal" is dishonest. Dreams hang off
nights; `dreams.dreamDate` is denormalised so heatmap queries stay single-table.

`insights.promptVersion` exists so a prompt can be revised later and its outputs
regenerated cleanly, rather than silently mixing results from two prompts.

`embeddings.model` holds a *key*, not a bare model name: vectors from two models
are not comparable, and neither are vectors built from two different compositions
of the same entry, so both the model and `EMBEDDING_TEXT_VERSION` go into it and
every search filters on it. Staleness is `embeddings.created_at <
dreams.updated_at` — the entry is encrypted, so when each was written is the only
honest comparison SQL can make.

## Verification

- `npm test` — unit suites, no infrastructure required. The crypto suite is the
  gate; nothing ships if it is red.
- `npm run test:integration` — needs `npm run dev:up`. Includes the assertion
  this whole design exists for: seed a full entry, take a real `pg_dump`, and
  fail if a single word of dream content, the password, or `MASTER_KEY` appears
  anywhere in it.
- Manual, per phase: setup → 2FA enrol → write entry → heatmap updates →
  generate insight → photograph a real journal page → confirm the drafted entry
  → semantic search finds it → scan a period and read the dream signs.

## Out of scope

Federation and sharing, native mobile apps, calendar/wearable sync, multi-user
(the schema is user-scoped so it stays possible), and public deployment beyond
documenting the reverse-proxy/TLS setup.
