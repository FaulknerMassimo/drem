# drem

A self-hosted dream journal built for lucid dreaming practice: nightly recall
tracking with a GitHub-style activity heatmap, AI dream-sign detection across the
whole archive, handwritten-page OCR, and semantic search — with the journal
encrypted at rest throughout.

Status: **Phase 6 — Analytics and polish.** See [Roadmap](#roadmap).

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

### Other hardening

Argon2id at 512 MiB / t=4 / p=4, with the cost parameters **stored per account**
so they can be raised later without rendering existing entries unreadable ·
TOTP with single-use time steps and 128-bit recovery codes · CSP whose
`connect-src 'self'` leaves injected script nowhere to send decrypted text ·
CSRF via Origin check *and* double-submit token · per-IP and per-account rate
limiting with quartic backoff · session tokens stored only as digests · audit
log that records structure, never content · EXIF/GPS stripped from every upload.

## Setup

Requires Docker, and Ollama on the host.

```bash
sudo pacman -S docker docker-compose        # Arch; adjust for your distro
sudo systemctl enable --now docker
sudo usermod -aG docker $USER               # log out and back in

ollama pull embeddinggemma                  # 768-dim embeddings for search

cp .env.example .env
npm run keygen >> .env                      # generates MASTER_KEY
# then set POSTGRES_PASSWORD and DATABASE_URL in .env

docker compose up -d
npm run db:migrate
```

If you serve the app over plain HTTP (localhost, or a LAN hostname), leave
`APP_ORIGIN` matching exactly how you reach it, scheme included. The CSRF origin
check compares against it literally, so `http://localhost:3000` and
`http://127.0.0.1:3000` are *not* interchangeable.

Open http://localhost:3000 and create the single account. TOTP enrolment is
offered immediately; the recovery codes are shown **once**.

Ollama deliberately stays on the host rather than in a container, so it keeps
GPU access. Containers reach it at `host.docker.internal:11434`.

### Search and dream signs

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

### Development

```bash
npm install
npm run dev:up             # postgres + whisper, ports on loopback only
npm run db:migrate
npm run dev

npm test                   # crypto and security suites; needs no infrastructure
npm run test:integration   # end-to-end against a real database; needs dev:up
npm run typecheck
```

`npm run test:integration` includes the assertion this whole design exists for:
it seeds a full entry, takes a real `pg_dump`, and fails if a single word of
dream content, the password, or `MASTER_KEY` appears anywhere in it.

## Roadmap

- [x] **0** — Scaffold, compose, schema, migrations
- [x] **1** — Crypto core, session key store, TOTP, CSRF, rate limiting, headers, audit log,
      setup/login/recovery UI — verified end to end in a browser against a live database
- [x] **2** — Nights and dreams, editor, activity heatmap, streaks, 3am capture mode
- [x] **3** — AI provider layer (Ollama / OpenAI-compatible / Anthropic), insights pipeline
- [x] **4** — Photo OCR with review, bulk import, voice memos, AI split of multi-dream logs
- [x] **5** — Embeddings with backfill, semantic search, "dreams like this", dream-sign
      detection with lucidity correlation
- [x] **6** — Statistics (lucid rate over time, technique effectiveness, vividness trends),
      installable PWA with offline capture, passphrase-sealed export/import, backup docs

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
