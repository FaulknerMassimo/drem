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

Three deviations from the original plan, all deliberate:

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
- [ ] **4 — Capture.** Encrypted attachments, photo OCR with side-by-side review
      (image left, extracted fields right, per-field confidence, nothing saved
      unconfirmed), bulk multi-page import, voice memo → faster-whisper,
      JSON/Markdown/CSV import.
- [ ] **5 — Semantic layer.** Embedding pipeline and backfill, meaning-based
      search, "dreams like this", AI dream-sign detection with per-sign frequency
      and lucidity correlation.
- [ ] **6 — Analytics and polish.** Stats dashboards (lucid rate over time,
      technique effectiveness, vividness trends), period reports, installable PWA
      with offline capture, encrypted export/import, backup docs.

## Data model notes

`nights` is the primary unit, **not** `dreams`. A night with zero recall still
matters for streaks and technique statistics, and a heatmap that cannot
distinguish "no dream" from "did not journal" is dishonest. Dreams hang off
nights; `dreams.dreamDate` is denormalised so heatmap queries stay single-table.

`insights.promptVersion` exists so a prompt can be revised later and its outputs
regenerated cleanly, rather than silently mixing results from two prompts.

## Verification

- `npm test` — unit suites, no infrastructure required. The crypto suite is the
  gate; nothing ships if it is red.
- `npm run test:integration` — needs `npm run dev:up`. Includes the assertion
  this whole design exists for: seed a full entry, take a real `pg_dump`, and
  fail if a single word of dream content, the password, or `MASTER_KEY` appears
  anywhere in it.
- Manual, per phase: setup → 2FA enrol → write entry → heatmap updates →
  generate insight → photograph a real journal page → confirm the drafted entry
  → semantic search finds it.

## Out of scope

Federation and sharing, native mobile apps, calendar/wearable sync, multi-user
(the schema is user-scoped so it stays possible), and public deployment beyond
documenting the reverse-proxy/TLS setup.
