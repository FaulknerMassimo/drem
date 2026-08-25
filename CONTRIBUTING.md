# Contributing to drem

drem is one person's dream journal that also happens to be a codebase. Those two
things want opposite treatment: a journal must never lose an entry, and a
codebase needs someone to truncate the database regularly. This file is
how both happen on the same machine.

Read [AGENTS.md](AGENTS.md) as well — it holds the architecture, the rules about
encryption, and a list of traps that each cost real debugging time. This file is
only about *which journal you are pointed at*, and about testing without
touching the one that matters.

## Three journals

| | production | development | test |
| --- | --- | --- | --- |
| What it holds | someone's actual dreams | generated nights | whatever the last suite wrote |
| Configured by | `.env` (never committed) | `.env.development` (committed, public) | `.env.development` |
| Database | `drem` | `drem_dev` | `drem_test` |
| Cluster | compose project `drem`, port 5433 | compose project `drem-dev`, port 5432 | same cluster as development |
| `MASTER_KEY` | yours, backed up, irreplaceable | published in this repository | published in this repository |
| Attachments | docker volume `drem_uploads` | `./data/dev-uploads` | `./data/dev-uploads` |
| Runs as | `docker compose up -d`, port 43817 | `npm run dev`, port 43818 | `npm run test:integration` |
| Safe to destroy | never | always | always, and often |

They are separate Postgres **clusters** — different containers, different
volumes, different superusers — not two databases in one. `npm run dev:destroy`
deletes the development volume outright and cannot reach the other.

## Getting a development environment

```bash
npm install
npm run dev:up       # the development cluster: postgres + whisper, loopback only
npm run dev:reset    # drop, migrate, create the account, seed ~400 nights
npm run dev          # http://localhost:43818
```

Log in as `dev@drem.local` / `development-journal`. There is no TOTP on that
account, so login is one step.

You do **not** need a `.env` to develop, and you should not make one unless you
are also running a real journal. Everything development needs is in
`.env.development`, which is committed on purpose: a key that decodes to the
ASCII `drem dev key - not a secret ----`, a scratch database, and a password
printed three lines above this one. Nothing in it is worth protecting, which is
exactly why it can be shared.

Personal overrides — a different port, a real model endpoint — go in
`.env.development.local`. It is read first and is ignored by git.

`npm run dev:reset` is the answer to almost every "my dev data is strange"
question. It takes about a minute, most of it Argon2 deriving the account key at
the same cost production uses.

## What actually keeps them apart

Four things, listed in order of how much they would save you.

**Different key material.** The development journal is encrypted under a key
published in this repository; the real one is not. So a development process
pointed at the production database does not read dreams — it fails to unwrap the
data key and cannot even log in. This is the only boundary here that holds
against a mistake nobody notices.

**The database name.** Every process declares which journal it is for, and
refuses a connection string that disagrees:

| `DREM_ENV` | database name must | enforced in |
| --- | --- | --- |
| `production` | not end in `_dev` or `_test` | `src/lib/env.ts`, at boot |
| `development` | end in `_dev` | `src/lib/env.ts`, `scripts/env-file.ts` |
| `test` | end in `_test` | `scripts/env-file.ts`, via `test/load-env.ts` |

The rule is in [`src/lib/db-environment.ts`](src/lib/db-environment.ts) and has
its own unit suite. It is the name rather than a flag because a name travels
inside every connection string, survives being pasted between shells, and shows
up in the error when it is wrong.

The same file refuses to let production start under the published development
key. The reverse — development running under the production key — is not
detectable from inside the repository, and is caught by the database name
instead, since a production key travels in the same file as a production
connection string.

**Different clusters, addressed deliberately.** Development is on the default
Postgres port and production is on 5433, so a command that forgot to say which
journal it meant lands on the scratch one. `psql -h localhost`, a stale
`DATABASE_URL`, a copy-pasted `pg_dump` — all of them hit development first.

**Different ports for the app.** 43818 for `npm run dev`, 43817 for the real
one, so both run at once and a bookmark cannot open the wrong journal.
`APP_ORIGIN` is compared literally by the CSRF check, so if you change a port,
change it in the same file.

What is *not* separated: Ollama, which runs on the host and is shared because it
holds models rather than data, and this working tree. An editor pointed at the
repository is pointed at both journals' source.

## Testing

```bash
npm test                   # unit; no infrastructure at all
npm run typecheck
npm run test:integration   # needs `npm run dev:up`
```

The crypto suite is the gate. If it is red, nothing else matters.

The integration suites create and truncate `drem_test`, in the development
cluster, configured from `.env.development` — so no test process ever holds the
production key, and the truncation has nowhere else to land. Pointing them
anywhere else is a hard refusal rather than a warning: `test/load-env.ts` checks
the connection string it was handed *before* retargeting it, so an exported
`DATABASE_URL` cannot be laundered into a scratch database next to the real
journal.

Four suites are canaries rather than tests, and they are the reason this project
is arranged the way it is:

| Suite | Asserts that |
| --- | --- |
| `accounts.integration.test.ts` | a real `pg_dump` contains no dream text, password or key |
| `journal.integration.test.ts` | the same, over the application's own write path |
| `backup.integration.test.ts` | the same, over the archive file handed to the browser |
| `semantic.integration.test.ts` | `embeddings.vector` stays null under the default backend |

**If you add a column holding something a person wrote, add it to the first
three.** A field stored in plaintext is the worst bug this codebase can have and
it will not announce itself — the app looks perfect, and the damage is only
visible in a dump nobody reads until it leaks. The suffix conventions (`Enc` for
ciphertext, `Bidx` for keyed fingerprints) exist so a reviewer can see the
omission in the schema diff.

## Changing the schema

```bash
npm run db:generate          # writes SQL into drizzle/ — touches no database
npm run db:migrate           # development
npm run db:migrate:prod      # the real journal, spelled out
```

The unsuffixed command is the development one, deliberately: the default should
be the one that cannot lose anything, and reaching the real journal should
require typing that you meant to. Each of them prints the database it resolved
before it runs — read that line.

`npm run db:push` exists for development only. It diffs the schema straight into
the database with no migration file, which is a fine way to iterate and a
terrible way to arrive at a journal you cannot reconstruct.

A migration that will run against a year of encrypted entries deserves the same
suspicion as one that drops a column, because for anything under `Enc` it is the
same operation: the AAD binds each ciphertext to `table:column:row`, so moving a
value between columns or rows makes it permanently undecryptable. See the AAD
rule in AGENTS.md before writing one.

## Running the real journal

```bash
cp .env.example .env
npm run --silent keygen >> .env   # only ever on an install with no data
docker compose up -d
npm run db:migrate:prod
```

Then open http://localhost:43817 and create the single account.

**Never regenerate `MASTER_KEY` on an install that has data.** Every entry
becomes permanently unreadable, and `scripts/generate-keys.ts` refuses to run
when `.env` exists for that reason. Do not work around it.

Backups are [docs/BACKUP.md](docs/BACKUP.md), and they are not optional: there is
no copy of a dream journal anywhere else and no password reset.

## If you are an agent

Assume every command you run lands on a real journal until you have checked
otherwise. The guards above are there because this assumption is often wrong.

Free to use:

- `npm test`, `npm run typecheck`, `npm run lint`
- `npm run dev:up`, `npm run dev`, `npm run dev:reset`, `npm run dev:destroy`
- `npm run test:integration`, `npm run seed`, `npm run db:migrate`, `npm run db:push`
- anything at all against `drem_dev` or `drem_test`

Ask first, every time:

- `npm run db:migrate:prod`, or any `drizzle-kit` invocation naming production
- `docker compose` without `-p drem-dev` — that is the production project, and
  `down -v` there deletes the journal
- reading, dumping or writing the `drem` database
- editing `.env`, and above all anything that rewrites `MASTER_KEY`
- `git commit` and `git push` (see AGENTS.md)

If a command refuses to run and names a database you did not expect, that is the
guard working. Do not route around it by exporting `DATABASE_URL`, editing
`.env.development` to point somewhere else, or passing a connection string
directly to `psql`. Work out which of the two halves is stale first — it is
usually a shell that still has an old export in it.

## When something refuses

```
Refusing to run: this is a development process, so DATABASE_URL must name a
database ending in "_dev" — it points at "drem".
```

Three things produce this, in rough order of likelihood: an exported
`DATABASE_URL` left over in the shell, a `.env.development.local` that was
copied from `.env`, or a command run with `DREM_ENV` set to something the rest
of its configuration does not agree with. Check which one before changing
either half — the refusal is not the problem.

## Style

Match the surrounding code, which is the rule AGENTS.md spends most of its
length on. The short version: comments explain *why*, especially where a choice
trades something away, because this codebase is full of deliberate trade-offs
that look like mistakes without the reasoning. Tests are named as behaviour
statements. Anything a person wrote gets encrypted.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run test:integration
```

and, if you touched the schema, confirm every new column holding written text
appears in the three canary suites above.

## Moving an existing checkout to the split

A checkout from before development and production were separated has one
cluster, one `.env`, and a `drem` database holding both real and seeded entries.
To split it:

```bash
docker compose down                     # stop the old stack
docker compose up -d                    # production, now on db port 5433
npm run db:migrate:prod

npm run dev:up                          # a new, empty development cluster
npm run dev:reset
```

The old cluster keeps whatever `drem` contained, including any `drem_test`
database left behind by the previous arrangement — that one is safe to drop, and
nothing creates it there any more.
