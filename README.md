# drem

A self-hosted dream journal built for lucid dreaming practice: nightly recall
tracking with a GitHub-style activity heatmap, AI dream-sign detection across the
whole archive, handwritten-page OCR, and semantic search — with the journal
encrypted at rest throughout.

## App overview

drem is a single-user journal built around the nightly loop of capturing a
dream before it fades, writing it up later, and finding patterns across months
of entries. The dashboard opens on a trailing year of recall, with current and
best streaks, recent entries, and a heatmap that distinguishes lucid dreams,
ordinary recall, and journalled nights with nothing remembered.

The app is organised by when each part is useful:

| Area | What it is for |
| --- | --- |
| **Write** | Record tonight, capture quickly, finish drafts, or import existing material |
| **Journal** | Chat with the archive, browse every entry, search by meaning, and find similar dreams |
| **Patterns** | Review recurring dream signs, statistics, and longer-period reports |
| **System** | Configure model providers, export or restore backups, and manage recovery codes |

The separate Capture screen removes the normal app chrome and uses a deep-red
palette for the middle of the night. It asks for only the dream text; the result
waits as a draft for the ratings, tags, techniques, and context that are easier
to add in daylight.

## Features

- **Night-centred journalling.** Record several dreams, a no-recall night, night
  notes, lucidity, vividness, control, clarity, emotional tone, techniques, and
  tags without pretending every night is a single entry.
- **Fast and offline capture.** Install drem as a PWA, open Capture from a home
  screen shortcut, and keep unsent captures queued visibly on the device until
  the server confirms each save.
- **Paper, audio, and file import.** Transcribe photographed pages one at a
  time, split a joined night into separate dreams, review everything before it
  is filed, transcribe voice memos locally, or import JSON, Markdown, and CSV.
- **Recall and lucidity trends.** Follow a year-long activity heatmap, recall
  and lucid streaks, technique effectiveness, monthly rates, and changes in
  vividness, control, and clarity.
- **Dream signs and semantic search.** Find entries with similar meaning,
  discover recurring people, places, and impossible details, and compare each
  sign's lucid rate with the archive's baseline.
- **Private journal chat.** Talk naturally with a configured model that can
  inspect dreams, nights, notes, signs, tags, saved reports, exact text matches,
  activity, and technique statistics through validated read-only tools. Only
  the final transcript is saved, encrypted; tool traces stay in memory.
- **Optional AI insights.** Assign local or remote providers separately to
  extraction, coaching, symbolic reading, reports, capture, and semantic roles.
  Every remote request names its destination before any dream leaves the
  machine, and failed queued work reports the reason on the requesting screen.
- **Encrypted attachments and portable backups.** Keep page photographs and
  voice recordings encrypted alongside the journal, export a passphrase-sealed
  archive, and merge-restore it into a fresh or existing installation without
  duplicating entries.

## Security model

The premise is that a dream journal is closer to a therapy record than a blog. A
stolen laptop, a leaked database dump, or a misplaced backup should reveal
nothing.

### Two factors, both required

```
password ──argon2id(salt A, pepper = MASTER_KEY)──> auth hash        (stored)
         └─argon2id(salt B, pepper = MASTER_KEY)──> KEK              (never stored)
                                                     │
DEK (random 32 bytes) ──AES-256-GCM(KEK)──> wrapped data key         (stored)
```

`MASTER_KEY` lives in `.env`, outside the database. Neither half is useful
alone:

| Attacker has | Result |
| --- | --- |
| Database dump | Nothing readable. Cannot even brute-force the password offline — the hash is peppered with `MASTER_KEY`. |
| `.env` file | Nothing readable. No password, no key. |
| Both, no password | Nothing readable, but the password is now brute-forceable at ~0.5s per guess. |
| A live logged-in session | Everything. The threat model does not defend against this. |

**Back up `MASTER_KEY` separately from your database backups.** Storing both in
one place collapses the scheme to a single factor. Losing it is unrecoverable.

### Where the keys live

Unwrapped keys exist **only in the memory of a live session** — never in the
cookie (an opaque token), never in the session row (only that token's SHA-256),
never on disk. Consequences, by design:

- Restarting the server logs you out.
- Queued AI jobs run only while you are logged in, unless you opt into
  `ALLOW_BACKGROUND_PROCESSING` (which stores a second copy of the data key
  wrapped under `MASTER_KEY` alone — read the note in `.env.example` first).
- The app assumes a **single process**. Multiple replicas would each hold their
  own store.

### What is encrypted, and what is not

Encrypted with AES-256-GCM (columns suffixed `Enc`): dream titles and bodies,
night notes, AI insights, OCR and speech transcripts, attachment blobs, provider
API keys, the TOTP secret. Every ciphertext is bound by its GCM additional data
to the exact `table:column:row` it belongs to, so values cannot be relocated
between rows or fields.

Deliberately **not** encrypted, with the reasoning:

| Stored in the clear | Why | What it leaks |
| --- | --- | --- |
| Dates, lucidity, vividness, technique | The heatmap, streaks and statistics are built on them | That you dreamt, and how lucid — never what |
| `wordCount` | Length statistics without decrypting the archive | How much you wrote |
| Tag and dream-sign fingerprints | Grouping and filtering must run in SQL | That two entries share a tag, not which |
| Embedding vectors *(only if `SEARCH_BACKEND=pgvector`)* | ANN indexing | Vectors are partially invertible. The default `encrypted` backend avoids this |
| Which entries share a dream sign | Counting a sign and correlating it with lucidity must run in SQL | That two entries share a cue, not which cue |

Chat titles, user messages, and model answers are encrypted. Tool calls and
their results are never stored: they can contain complete decrypted entries and
exist only for the duration of the model request. Chat is also subject to the
same destination badge and explicit acknowledgement as every other remote model
feature.

### Other hardening

Argon2id at 512 MiB / t=4 / p=4, with the cost parameters **stored per account**
so they can be raised later without rendering existing entries unreadable ·
TOTP with single-use time steps and 128-bit recovery codes · CSP whose
`connect-src 'self'` leaves injected script nowhere to send decrypted text ·
CSRF via Origin check *and* double-submit token · per-IP and per-account rate
limiting with quartic backoff · session tokens stored only as digests · audit
log that records structure, never content · EXIF/GPS stripped from every upload.

## Installation

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the production setup,
including Docker, environment and key configuration, host Ollama networking,
model migration and cleanup, verification, and troubleshooting.

## Search and dream signs

Assign a model to the **Embedding** role in Settings before searching —
`embeddinggemma` in Ollama is the default the schema is dimensioned for. The
journal is encrypted, so nothing can search it for a word; search compares each
entry as a vector instead, and the comparison runs in the app process rather
than in Postgres.

New entries are indexed **as you write them, only while the embedding model is
on this machine**. A remote embedding model is never used as a side effect of
saving — indexing it would send every dream you write to a third party without
asking — so with one assigned you index from the search page, where the
destination and the acknowledgement are. The same page reports how much of the
archive is indexed, since a search that silently misses half your entries still
returns results.

Entries written before you assigned a model (and anything imported) need one
backfill pass from that page. Changing the embedding model re-indexes from
scratch: vectors from two models are not comparable.

## Development

Development runs against a **separate Postgres cluster, under a separate key**,
so working on drem cannot reach the journal it is for. Nothing below touches the
real one, and none of it needs your `.env`:

```bash
npm install
npm run dev:up             # the development cluster; ports on loopback only
npm run dev:reset          # drop, migrate, create the account, seed ~400 nights
npm run dev                # http://localhost:43818

npm test                   # crypto and security suites; needs no infrastructure
npm run test:integration   # end-to-end against a real database; needs dev:up
npm run typecheck
```

[CONTRIBUTING.md](CONTRIBUTING.md) is the full guide: what separates the three
journals, what each command is allowed to touch, and what to check before a
change to the schema.

`npm run test:integration` includes the assertion this whole design exists for:
it seeds a full entry, takes a real `pg_dump`, and fails if a single word of
dream content, the password, or `MASTER_KEY` appears anywhere in it.

## Backups

Three things, kept apart. **[docs/BACKUP.md](docs/BACKUP.md) is the procedure**;
this is the short version.

```bash
docker compose exec db pg_dump -U drem drem > drem-$(date +%F).sql
docker run --rm -v drem_uploads:/data -v "$PWD":/out alpine \
  tar czf /out/uploads-$(date +%F).tar.gz -C /data .
```

...and `MASTER_KEY`, somewhere else entirely. A backup of the database without
it restores nothing — it is half the key material, not a configuration value.

Both files above are still encrypted, so they are safe to store anywhere. What
they are not is *portable*: they restore this instance, with this `MASTER_KEY`,
at this migration state.

For a copy that outlives the instance, the **Backup** screen writes a single
passphrase-sealed archive of every night and dream, which opens with that
passphrase alone and restores into any drem install. That independence is
bought by dropping to **one factor** — anyone holding the file can attack it
offline — so it takes a real passphrase and belongs somewhere separate again.
Restoring merges: it never deletes, never overwrites a night you have since
rewritten, and skips entries already present, so running it twice is a no-op.
AI-derived data and conversation transcripts are not included; insights, signs,
embeddings, and chats can be rebuilt or started again from the restored journal.

## Installing it as an app

The manifest and service worker make drem installable, which matters for one
screen: capture. A home-screen icon and a long-press shortcut are the difference
between catching a dream at 4am and losing it to finding a browser tab.

Once installed, capture works with no connection. A save that cannot reach the
server is held in browser storage and sent when one is available, with the count
kept on screen so nothing waits invisibly. Note the trade-off, which is the one
place in the app plaintext touches disk outside the database: a queued capture
sits unencrypted in `localStorage` until it is sent. It is capped, it is
deleted the moment the server confirms it, and the alternative was losing the
dream — see the reasoning in `src/lib/capture/offline.ts`.

**Both need HTTPS.** Service workers require a secure context, so on a plain
`http://` LAN origin the app still works but does not install and has no offline
capture. `localhost` is the exception browsers make, and is enough to try it.
