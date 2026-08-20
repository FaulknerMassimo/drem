# Backing up drem

A dream journal is worth backing up for the same reason it is worth encrypting:
it cannot be reconstructed. There is no copy anywhere else, and nobody can send
you a password reset.

This is the procedure. It takes about five minutes to set up and should be read
before you have a year of entries rather than after.

## What can destroy the journal

Four things, and they need different defences. Most people plan for the first
one only.

| What happens | What saves you |
| --- | --- |
| Disk fails, machine is stolen | A database dump, kept elsewhere |
| `MASTER_KEY` is lost | Nothing. The dump becomes permanently unreadable |
| You forget your password | Nothing, unless you still have a recovery code |
| An entry is deleted by mistake | A dump or an archive from *before* it happened |

The second row is the one that catches people. `MASTER_KEY` is not a
convenience: it is half of the key material, and a database dump without it is
indistinguishable from noise. Backing up the database alone feels like a backup
and is not one.

## The three things to keep

### 1. `MASTER_KEY`

Thirty-two bytes in `.env`. Copy it somewhere that is **not** where your
database backups go — a password manager entry is ideal. Storing both together
collapses the two-factor scheme into one factor, which is exactly what an
attacker with your backup drive is hoping for.

It never changes, so this is a one-time job.

### 2. The database

```bash
docker compose exec db pg_dump -U drem drem > drem-$(date +%F).sql
```

Everything: entries, nights, tags, insights, embeddings, dream signs, sessions,
the audit log. All still encrypted — this file is safe to store on a NAS or a
cloud drive, because without `MASTER_KEY` *and* your password it decrypts to
nothing. That is the whole point of the design.

### 3. The attachments

Photographs of handwritten pages and voice memos are files on disk, not rows, so
`pg_dump` does not include them:

```bash
docker run --rm -v drem_uploads:/data -v "$PWD":/out alpine \
  tar czf /out/uploads-$(date +%F).tar.gz -C /data .
```

These are encrypted with the blob key, so the tarball is as safe as the dump.

## The portable archive

The three files above restore *this instance*. They are tied to it: the dump
needs the same `MASTER_KEY`, and the schema needs a matching migration state.

The **Backup** screen in the app writes something different — a single file
holding every night and every dream, sealed with a passphrase you choose:

- It opens with that passphrase **and nothing else**. No `MASTER_KEY`, no
  database, no drem instance. If the machine, the environment file and the
  backups all burn, this still opens.
- It restores into any drem install, including a brand new one.
- It is a portable format: JSON inside an AES-256-GCM container, documented in
  `src/lib/crypto/archive.ts` well enough to be opened by a script in twenty
  years when this app no longer runs.

The cost of that independence is the thing to understand before you use it:

> **An archive is protected by one factor.** Everything else here needs two.
> Anyone who has the file can attack the passphrase offline, at their own pace,
> with nothing else. Use several words, not a short complicated string, and do
> not store it next to a note saying what it is.

### What it holds

Nights, dreams, tags, ratings, techniques, night notes — everything a person
wrote.

Not included, deliberately:

- **Insights, embeddings and dream signs.** All derived from the entries.
  Re-running the models rebuilds them, and carrying them would roughly double
  the file with data that goes stale the moment you change a prompt or an
  embedding model.
- **Photographs and voice memos.** Files rather than rows, orders of magnitude
  larger than the text, and already covered by the `uploads` tarball above.
- **Your account, password, TOTP secret and audit log.** An archive is a copy of
  the journal, not of the instance.

### Restoring one

Backup → *Restore a backup* → choose the file and enter its passphrase.

Restore **merges**. It never deletes, it leaves a night you have already written
exactly as it is, and it skips any entry the journal already holds — so it is
safe to run against a live journal, and running it twice changes nothing the
second time.

That last property is worth relying on: if you are not sure whether a restore
completed, run it again.

## A routine that works

Weekly, or whenever you remember:

```bash
docker compose exec db pg_dump -U drem drem | gzip > drem-$(date +%F).sql.gz
```

Monthly, and before anything risky (a migration, a server move, a Docker
upgrade): take an archive from the Backup screen and put it somewhere the
machine cannot reach — a USB stick in a drawer counts.

Once, now: put `MASTER_KEY` in your password manager.

## Restoring the instance

Onto a clean machine:

```bash
cp .env.example .env
# put the ORIGINAL MASTER_KEY in .env -- a fresh one restores nothing
docker compose up -d db
cat drem-2026-08-19.sql | docker compose exec -T db psql -U drem drem
docker run --rm -v drem_uploads:/data -v "$PWD":/out alpine \
  tar xzf /out/uploads-2026-08-19.tar.gz -C /data
docker compose up -d
```

Then log in with the password you always used. Nothing needs to be re-encrypted:
the data key was wrapped, not the journal.

**Do not run `npm run keygen` on a restore.** It generates a new `MASTER_KEY`,
and a new `MASTER_KEY` cannot unwrap the old data key — every entry in the dump
you just restored becomes unreadable. `scripts/generate-keys.ts` refuses to run
when `.env` already exists for this reason; do not work around it.

## Checking a backup is real

An untested backup is a belief, not a backup. Once:

1. Take an archive from the Backup screen.
2. On another machine (or the same one with a different `DATABASE_URL`), bring
   up an empty drem, create an account, and restore the archive into it.
3. Confirm your entries are there.

That exercises the only path that matters, and it costs one evening rather than
the year of entries you find out about later.
