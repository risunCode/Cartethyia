# Getting started

This guide is the source of truth for installing, configuring, running, and
checking Cartethyia.

## 1. Requirements

All local installs require:

- Bun 1.4.0 or newer;
- a terminal;
- a writable data directory.

The database requirement depends on the selected mode:

| Mode | Required database infrastructure |
|---|---|
| **Lite** | None. Cartethyia runs embedded PGlite locally. |
| **Full** | A reachable PostgreSQL database configured with `DATABASE_URL`. |

Redis is optional in both modes. Set `REDIS_URL` when coordination must be
shared between processes or instances. If it is unset, Cartethyia uses the
in-memory coordination backend.

## 2. Choose a database mode

Cartethyia exposes the same application features in both modes. Only the
persistence backend and deployment profile change.

| | Lite | Full |
|---|---|---|
| Database | Embedded PGlite | External PostgreSQL |
| Best for | Personal use, local development, one casual process | VPS, sharing, selling, sustained or high workload |
| Extra services | No database service; Redis optional | PostgreSQL required; Redis optional |
| Trade-off | Single-process and lower concurrency ceiling | Requires operating or reaching PostgreSQL |

### Lite

Lite is the default in `.env.example` and is the recommended starting point for
personal or local use. It does not require PostgreSQL or Redis.

PGlite stores the database under:

```text
<CARTETHYIA_DATA_DIR>/pglite
```

When `CARTETHYIA_DATA_DIR` is unset, the default is:

| Operating system | Default data directory |
|---|---|
| Windows | `%APPDATA%\Cartethyia` |
| macOS | `~/Library/Application Support/Cartethyia` |
| Linux | `$XDG_DATA_HOME/Cartethyia`, or `~/.local/share/Cartethyia` |

### Full

Full is recommended for VPS deployments, sharing, selling, and higher workloads.
Set:

```dotenv
CARTETHYIA_DB_MODE=full
DATABASE_URL=postgres://user:password@host:5432/cartethyia
```

The PostgreSQL server must be reachable from the Cartethyia process. Redis is
still optional for a single process; set `REDIS_URL` for shared coordination or
multiple app instances.

Lite is not a reduced feature edition. To move to Full later, export a JSON
backup from Lite and import it into the Full instance. The configuration does
not need to be rebuilt manually.

## 3. Install dependencies

From the repository root, install the Bun dependencies:

```bash
bun install
```

`bun install` installs packages only. It does not create the database, generate
`.env`, or start Cartethyia.

## 4. Configure and validate the installation

Run the unified setup command:

```bash
bun setup
```

`bun setup` does the following:

1. creates `.env` from `.env.example` when it does not exist;
2. generates `CARTETHYIA_ENCRYPTION_KEY` when it is missing or still a placeholder;
3. creates `.env.test` from `.env.test.example` when needed;
4. prepares the Lite data directory, or checks PostgreSQL in Full mode;
5. checks Redis only when `REDIS_URL` is configured;
6. checks Docker Compose when `CARTETHYIA_SETUP_MODE=docker` is selected.

The generated local `.env` defaults to Lite. To use Full, edit `.env` and set
`CARTETHYIA_DB_MODE=full` together with a reachable `DATABASE_URL`, then run:

```bash
bun setup --non-interactive
```

For automation, always use:

```bash
bun setup --non-interactive
```

That mode never prompts. It reads the selected mode and connection values from
`.env` and fails when the required Full-mode configuration is missing.

Check the resulting configuration with:

```bash
bun doctor
```

`bun doctor` checks `.env`, the selected database backend, the Lite data
 directory or PostgreSQL reachability, optional Redis, and application readiness.

## 5. Configure encryption

`CARTETHYIA_ENCRYPTION_KEY` is a required 256-bit secret. It encrypts stored
provider credentials and API keys. Treat it like a password and keep it outside
version control.

The setup command generates it automatically. Manual generation is only needed
when rotating the key or preparing an environment yourself.

```bash
# macOS / Linux
openssl rand -hex 32

# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# Bun / Node on any platform
bun -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

Either a 64-character hexadecimal value or Base64 encoding of 32 bytes is
accepted.

## 6. Start Cartethyia

After setup succeeds, start the development stack:

```bash
bun dev
```

Open the dashboard at:

```text
http://localhost:12800/console
```

For backend and dashboard processes separately:

```bash
bun run dev:backend
bun run dashboard:dev
```

For automatic restart when source, migration, or dependency files change:

```bash
bun run dev:watch
```

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `/health` | Process liveness |
| `/health/ready` | Database, migration, and dependency readiness |
| `/metrics` | Prometheus metrics |
| `/v1/*` | Gateway API routes |
| `/console` | Dashboard |
| `/share/:token` | Public child-key enrollment |

## 7. Docker

Docker Compose defaults to Full mode and bundled Redis coordination:

```bash
docker compose up --build -d
docker compose logs -f app
```

Stop the stack with:

```bash
docker compose down
```

Compose also manages the PostgreSQL and Redis the app connects to: the app reaches
both by service name on the Compose network, and a fresh `postgres` volume is
migrated at first boot. `DATABASE_URL` is therefore set by Compose rather than
read from `.env`. To point the app at an external database instead, override its
`DATABASE_URL` or remove the `postgres` service. Inside Compose the Redis URL is
the Compose-only `CARTETHYIA_REDIS_URL` (`environment` wins over `env_file`), so
a host-oriented `REDIS_URL=redis://localhost:6379` in `.env` for `bun dev` cannot
leak into the container. To run the app container with Lite:

```dotenv
CARTETHYIA_DB_MODE=lite
# DATABASE_URL is not needed in Lite mode.
# CARTETHYIA_REDIS_URL=  # omit or leave empty for in-memory coordination
```

The Compose app stores gateway state and telemetry payloads in the persistent
`/app/data` volume. Redis starts as a helper container in either mode, but the
application uses the in-memory backend when `REDIS_URL` is empty.

## 8. Migrations and backups

Numbered migrations under `migrations/` run automatically at boot and are
recorded in `cartethyia_schema_migrations`.

To move an installation from Lite to Full:

1. open the Lite dashboard;
2. export a backup from **Settings → Backup**;
3. configure and start the Full instance with an empty or new database;
4. wait for `/health/ready` to return HTTP `200`;
5. import the backup in the Full dashboard.

Backups may contain provider credentials and API-key data. Treat them like
passwords and store them securely.

## 9. Test database

Database-backed tests use the isolated URL in `CARTETHYIA_TEST_DATABASE_URL`,
not the development `DATABASE_URL`. The setup command creates `.env.test` from
`.env.test.example` when it is missing.

Check the test database:

```bash
bun run test-db:check
```

If local PostgreSQL is unavailable, use the disposable test database in Compose:

```bash
cp .env.test.example .env.test
bun run test-db:up
bun run test-db:check
bun run test-db:down
```

Never use production data for tests.

## 10. Verification commands

Run the gates relevant to the change:

```bash
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:build
bun run test:backend
bun run dashboard:test
bun run build
```

Typechecking is not runtime proof. For behavior changes, also exercise the real
boundary: a gateway request, a browser surface, a provider flow, or an isolated
database migration.
