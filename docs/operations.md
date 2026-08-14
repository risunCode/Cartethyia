# Operations, Configuration, Docker, and Recovery

This document covers the active Go daemon deployment boundary. The dashboard is
built and operated separately.

## 1. Configuration precedence

The daemon loads configuration from process environment first. The command
entrypoint then reads `.env` from the current working directory or its parent
without overriding variables already supplied by the process.

Use the `CARTETHYIA_*` names for new deployments:

| Variable | Meaning | Production behavior |
| --- | --- | --- |
| `CARTETHYIA_LISTEN_ADDRESS` | HTTP listen address | defaults to `:12800` |
| `CARTETHYIA_ENV` | `development`, `test`, or `production` | production enables durable bootstrap rules |
| `CARTETHYIA_DATABASE_URL` | PostgreSQL DSN | required for production/durable authority |
| `CARTETHYIA_REDIS_URL` | Redis/Redis-compatible DSN | optional cache dependency |
| `CARTETHYIA_ACCOUNT_ENCRYPTION_KEY` | account secret encryption material | required when PostgreSQL is configured |
| `CARTETHYIA_REQUEST_TIMEOUT` | total request budget | duration, e.g. `2m` |
| `CARTETHYIA_CONNECT_TIMEOUT` | dependency/connect budget | duration, e.g. `10s` |
| `CARTETHYIA_FIRST_BYTE_TIMEOUT` | upstream first-byte budget | duration, e.g. `30s` |
| `CARTETHYIA_IDLE_TIMEOUT` | stream idle budget | duration, e.g. `60s` |
| `CARTETHYIA_SHUTDOWN_TIMEOUT` | graceful shutdown budget | duration, e.g. `10s` |
| `CARTETHYIA_USAGE_RETENTION` | telemetry retention | duration, e.g. `720h` |
| `CARTETHYIA_MAX_BODY_BYTES` | request body bound | positive integer |
| `CARTETHYIA_MAX_OUTPUT_TOKENS` | output-token bound | positive integer |
| `CARTETHYIA_MAX_CONCURRENT` | request concurrency bound | positive integer |
| `CARTETHYIA_MAX_CONCURRENT_STREAMS` | stream concurrency bound | positive integer |

Legacy `DATABASE_URL`, `REDIS_URL`, `ACCOUNT_ENCRYPTION_KEY`, and `NODE_ENV`
remain compatibility fallbacks in config parsing. They should not be used in
new deployment manifests.

Never put the account encryption key into a Dockerfile, image `ENV`, source
control, dashboard settings DTO, or log line.

## 2. Local Laragon stack

The repository root `.env` is configured for the local Laragon services:

```text
PostgreSQL  127.0.0.1:5432  database cartethyia
Redis       127.0.0.1:6379  database 0
Daemon      127.0.0.1:12800
```

Run the daemon from the repository or daemon directory:

```powershell
cd daemon
go run ./cmd/cartethyia
```

Verify liveness:

```powershell
curl.exe http://127.0.0.1:12800/health
```

The endpoint is liveness, not a substitute for checking PostgreSQL/Redis
health. PostgreSQL integration tests are opt-in so normal unit tests do not
provision or mutate a database.

## 3. PostgreSQL authority

When PostgreSQL is active, the runtime composes it as the authority for:

- account configuration and provider-account directory;
- encrypted access/refresh secrets;
- OAuth metadata and reauthentication state;
- refresh leases and fence tokens;
- custom providers, catalog/settings data, and runtime repositories;
- bounded metadata/telemetry persistence.

Bootstrap fails closed when production has no database URL or when PostgreSQL is
configured without an account encryption key.

The migration/open path validates the PostgreSQL connection before serving. The
Bun database and SQL pool share lifecycle ownership and close together.

Run the live authority integration explicitly:

```bash
cd daemon
CARTETHYIA_POSTGRES_URL='postgres://postgres@127.0.0.1:5432/cartethyia?sslmode=disable' \
  go test ./internal/database -run TestPostgreSQLAccountAuthorityIntegration -count=1
```

## 4. Redis cache composition

Redis is a cache/coordination dependency, not durable account authority.

```text
configured Redis
      |
      v
L1 Redis backend
      |
      v
advisory cache router
      |
      v
L0 bounded memory fallback
```

The cache router tracks offline/unhealthy/online state, probes Redis, applies
command timeouts, and falls back to memory under its advisory policy. A Redis
miss is a valid cache outcome; it is not automatically a Redis health failure.
Malformed remote records and generation mismatches are rejected as hits.

If Redis is optional and unavailable, repair Redis or continue with the memory
fallback according to deployment policy. Do not write account secrets into a
cache to avoid fixing PostgreSQL.

## 5. Docker image

The root `Dockerfile` has these targets:

```bash
docker build --target runtime -t cartethyia:2.1.0 .
docker build --target dashboard -t cartethyia-dashboard:2.1.0 .
```

The daemon image:

- builds with Go 1.26.5;
- uses `CGO_ENABLED=0` and stripped build output;
- copies only the daemon binary into the runtime stage;
- runs as non-root UID 10001;
- exposes port `12800`;
- includes a liveness healthcheck against `/health`;
- does not contain database URLs, provider keys, or account encryption keys.

Run with runtime secrets supplied outside the image:

```bash
docker run --rm -p 12800:12800 \
  -e CARTETHYIA_LISTEN_ADDRESS=:12800 \
  -e CARTETHYIA_ENV=production \
  -e CARTETHYIA_DATABASE_URL="$CARTETHYIA_DATABASE_URL" \
  -e CARTETHYIA_REDIS_URL="$CARTETHYIA_REDIS_URL" \
  -e CARTETHYIA_ACCOUNT_ENCRYPTION_KEY="$CARTETHYIA_ACCOUNT_ENCRYPTION_KEY" \
  cartethyia:2.1.0
```

## 6. Docker Compose

Compose starts PostgreSQL, Redis, and the daemon. It gates the daemon on both
backend healthchecks:

```bash
cp .env.example .env
# Set CARTETHYIA_ACCOUNT_ENCRYPTION_KEY in .env.
docker compose up -d
docker compose ps
docker compose logs -f cartethyia
```

Compose defaults use service DNS names:

```text
postgres://cartethyia:cartethyia@postgres:5432/cartethyia?sslmode=disable
redis://redis:6379/0
```

The daemon reads its encryption key from the configured `env_file` (default
`.env`). Set `CARTETHYIA_ENV_FILE` to use a different secret-bearing file.
Override dependency URLs only with:

```dotenv
CARTETHYIA_COMPOSE_DATABASE_URL=...
CARTETHYIA_COMPOSE_REDIS_URL=...
```

This keeps the Laragon `.env` URLs from accidentally becoming container-local
`127.0.0.1` URLs.

## 7. Lifecycle and shutdown

The daemon receives `SIGINT`/`SIGTERM` through `signal.NotifyContext`.
Shutdown should:

1. stop accepting new work;
2. cancel request/stream contexts;
3. stop background workers;
4. close cache backends;
5. close PostgreSQL repositories and pools;
6. flush/close bounded metadata writers;
7. return before `CARTETHYIA_SHUTDOWN_TIMEOUT` expires.

A shutdown error is logged as bounded metadata. It must not expose a DSN,
credential, provider response, or raw request body.

## 8. Health and diagnosis

### Liveness

```bash
curl -i http://127.0.0.1:12800/health
```

Expected status is `200` while the HTTP server is serving.

### Metrics

```bash
curl -i http://127.0.0.1:12800/metrics
```

Metrics are bounded observability output. They are not a database dump and must
not contain secrets or raw payloads.

### Common failures

| Symptom | Check | Meaning |
| --- | --- | --- |
| daemon exits before listen | startup logs and env names | invalid config or required dependency failure |
| PostgreSQL bootstrap failure | DSN, port, database, encryption key | durable authority unavailable or misconfigured |
| Redis unhealthy | Redis URL and `PING` | cache degraded; memory fallback may remain active |
| `/health` is unreachable | listen address, port mapping, process logs | HTTP process/listener issue |
| no eligible account | admin account state, quota, reauth, cooldown | routing correctly rejected every candidate |
| provider retries exhausted | provider error classification and attempt evidence | no safe retry/fallback remains |
| dashboard cannot load data | dashboard origin/API proxy and `/v2/admin/*` auth | dashboard is a separate process/plane |

Do not “fix” unavailable dependencies by enabling synthetic production accounts,
empty success responses, or a second unofficial storage authority.

## 9. Backup and recovery boundary

Backup/restore is an admin operation with explicit service composition and
bounded raw download handling. It must preserve:

- safe filenames and bounded archive size;
- encryption/upload policy when configured;
- explicit confirmation for destructive restore/delete actions;
- truthful unavailable/forbidden/stale/failed states;
- no credentials or raw request payloads in backup metadata logs.

A backup is not a substitute for PostgreSQL migration testing. Test restore
against an isolated database before treating it as a recovery proof.

## 10. Deployment verification checklist

Before a deployment is considered usable:

```bash
cd daemon
go test ./...
go vet ./...
go build ./cmd/cartethyia
```

Then verify:

- image builds with the intended target;
- runtime user is non-root;
- image contains no `.env` or provider secrets;
- PostgreSQL and Redis healthchecks pass;
- daemon `/health` returns `200`;
- one authenticated admin request returns a bounded envelope;
- one client route returns a provider or truthful upstream error;
- shutdown on `SIGTERM` completes within the configured budget;
- logs contain lifecycle evidence but no raw payloads or credentials.
