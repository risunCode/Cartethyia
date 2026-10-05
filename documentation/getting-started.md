# Getting started

This is the source of truth for installing, running, and checking Cartethyia.

## Requirements

- Bun 1.4.2 or newer.
- **PostgreSQL is required in every setup.** It stores provider accounts, routes,
  usage, health, and configuration. Redis does not replace it.
- A terminal and a Node-compatible environment for tooling.
- Redis is optional for one local gateway with `REDIS_MODE=single_instance_local`.
- Redis is required for `REDIS_MODE=normal` and multi-instance deployments.

## Choose a setup

### Local setup

Use a PostgreSQL server running on your own computer. On Windows, Laragon is the
simplest option: install it, start PostgreSQL with **Start All**, and use the host
and port shown by Laragon (usually `localhost:5432`). On macOS, Homebrew is a
simple option:

```bash
brew install postgresql@16
brew services start postgresql@16
```

On Linux, install PostgreSQL with your distribution package manager and start its
service. For one local gateway, set `REDIS_MODE=single_instance_local` and no Redis
installation is needed.

### Remote or cloud setup

Use a PostgreSQL connection URL supplied by your cloud provider or managed database.
Set that URL as `DATABASE_URL`; it must be reachable from the Cartethyia service.
For `REDIS_MODE=normal` or multiple gateway instances, also set the private Redis
service URL as `REDIS_URL`. Cloud platforms usually inject these values as service
variables, so do not replace them with `localhost`.

## Install the requirements

The installer detects whether the configured PostgreSQL and Redis endpoints are
reachable. If a required service is missing, it stops and shows the next action for
the selected platform or deployment. It never silently installs services or uses a
local fallback for a remote deployment.

For local setup, fix the service first. For remote setup, fix the cloud service
variable or network access first.

## Configure the environment

From the repository root:

```bash
bun install
```

Cartethyia creates `.env` automatically on the next command. `bun run setup`
(non-interactive) and `bun run setup:interactive` both:

- detect whether `.env` exists — if not, create it from `.env.example` keeping
  **only mandatory rows** (`KEY=value` without `#`); commented hashtag defaults
  stay commented because the config layer already applies them,
- auto-generate `CARTETHYIA_ENCRYPTION_KEY` when it is missing or still the
  placeholder in an existing `.env` — no other value is ever overwritten,
- create `.env.test` from `.env.test.example` when the test-database url is
  missing (so `bun run test:backend` has an isolated database).

Check or edit the few mandatory entries:

```bash
cat .env  # contains PORT, DATABASE_URL, CARTETHYIA_ENCRYPTION_KEY, CARTETHYIA_PUBLIC_ORIGIN
```

### CARTETHYIA_ENCRYPTION_KEY

Required 256-bit secret. It encrypts every stored provider credential and API
key at rest — treat it like a password.

Generation (choose ONE; 32 bytes = 256 bits, either encoding is accepted):

```bash
# macOS / Linux:
openssl rand -hex 32

# Windows (PowerShell):
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# Bun / Node (any platform):
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

Paste the output as `CARTETHYIA_ENCRYPTION_KEY` in `.env`. Either 64-char hex
or base64 that decodes to 32 bytes is valid; the helpers (`scripts/internal/env.ts`,
`src/config.ts:decodeEncryptionKey`) validate the length on load. The setup/
install helpers generate one automatically — manual generation is only needed
when you want to rotate the key (use a backup/restore cycle when you do).

`DATABASE_URL` and `CARTETHYIA_PUBLIC_ORIGIN` contain example values — replace
them when your PostgreSQL host/port/database differs; `CARTETHYIA_PUBLIC_ORIGIN`
should be the externally reachable URL for OAuth callbacks/links. `REDIS_URL`
(and the other tunable counters/ceilings) stay commented until you need them;
defaults are commented defaults — deleting the comment would clobber the real
default with an example literal.

## Run the installer

## Start Cartethyia
After the installer completes:

```bash
bun run dev
```

For auto-restart on migrations or dependency changes, run `bun run dev:watch`
instead: source edits still hot-reload, and the supervisor reinstalls deps
(`bun install --frozen-lockfile`) and restarts in place when `migrations/*.sql`,
`package.json`, or `bun.lock` change, so it never needs to be re-run.

Open `http://localhost:12800/console`. Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `/health` | Process liveness |
| `/health/ready` | Database, migration, and readiness status |
| `/metrics` | Prometheus metrics |
| `/v1/*` | Gateway API routes |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

Run the halves separately when needed:

```bash
bun run dev:backend
bun run dashboard:dev
```

## Docker

```bash
docker compose up --build -d
docker compose logs -f app
docker compose down
```

Compose also manages the PostgreSQL and Redis the app connects to: the app reaches
both by service name on the Compose network, and a fresh `postgres` volume is
migrated at first boot. `DATABASE_URL` is therefore set by Compose rather than
read from `.env`. To point the app at an external database instead, override its
`DATABASE_URL` or remove the `postgres` service.

## Commands

```bash
bun run doctor
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run build
bun run start
bun run restart
```

`bun run build` builds the dashboard, prepares the backend with the AOT pass, and
creates `dist/cartethyia`. Docker and the restart command handle graceful shutdown
automatically so active requests get a chance to finish.

## Migrations and backups

Numbered migrations under `migrations/` run automatically at boot and are recorded
in `cartethyia_schema_migrations`.

To move a deployment:

1. Export a backup from **Settings → Backup**.
2. Start the new instance with an empty database.
3. Wait for `/health/ready` to return `200`.
4. Import the backup.

Backups can contain provider credentials and API-key data. Treat them like passwords.

## Test database

PostgreSQL is also the required database for integration and contract checks. Keep it
separate from your development database. The installer creates `.env.test` from
`.env.test.example` when it is missing, so most local setups never have to touch
it. If it already exists it is kept as-is. The suite never falls back to
`DATABASE_URL` — `TEST_DATABASE_URL` is the only URL it reads.

```bash
bun run test-db:check
```

If local PostgreSQL is not available, use the disposable Compose database only as an
optional fallback:

```bash
cp .env.test.example .env.test
bun run test-db:up
bun run test-db:check
bun run test-db:down
```

The repository carries an active test suite (`test/`, `dashboard/test/`, run via
`scripts/ci-run-tests.ts` against the isolated `.env.test` database). Apply
migrations before database-backed checks. Never use production data for tests.

## Verification

Run the relevant gates:

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when build or entry contracts change
bun run test:backend         # or: bun run test / dashboard:test / test:watch
```

For behavior changes, exercise the real boundary too: a gateway request, browser
surface, provider flow, or isolated database migration. Typecheck alone does not
prove runtime behavior.
