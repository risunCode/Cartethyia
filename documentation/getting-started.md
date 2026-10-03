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
cp .env.example .env
```

Set `DATABASE_URL`, `CARTETHYIA_ENCRYPTION_KEY`, and `CARTETHYIA_PUBLIC_ORIGIN`.
Set `REDIS_URL` when using normal coordination. Keep the encryption key safe: it
protects stored provider credentials. Do not paste it into issues, logs, or screenshots.

## Run the installer

```bash
bun run setup:interactive
```

It checks Bun, `.env`, placeholder secrets, PostgreSQL, and Redis when required.
The installer is safe to run again after fixing the reported requirement.

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

PostgreSQL must still be reachable through `DATABASE_URL`. Redis is managed by
Compose when the selected Redis mode requires it.

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
separate from your development database. If PostgreSQL is already running locally
(for example through Laragon), create `.env.test` with a dedicated database and run:

```bash
bun run test-db:check
```

The check reads only `TEST_DATABASE_URL`; it refuses to fall back to `DATABASE_URL`.
Apply migrations before database-backed checks. Never use production data for tests.

If local PostgreSQL is not available, use the disposable Compose database only as an
optional fallback:

```bash
cp .env.test.example .env.test
bun run test-db:up
bun run test-db:check
bun run test-db:down
```

The current checkout does not carry an active test suite, but this isolated database
is the target for restoring or adding integration/contract tests.

## Verification

Run the relevant gates:

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when build or entry contracts change
```

For behavior changes, exercise the real boundary too: a gateway request, browser
surface, provider flow, or isolated database migration. Typecheck alone does not
prove runtime behavior.

For database-backed checks, start the disposable test database first and confirm its
health before running the check.
