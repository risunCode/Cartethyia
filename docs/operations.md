# Operations, Configuration, Docker, and Recovery

This document covers the active Go daemon deployment boundary. The dashboard
(SolidJS + Vite SPA) is built and operated separately, with a small Bun
auxiliary server (`/internal/*` on `:8787`) for browser error reporting.

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
| `CARTETHYIA_ENCRYPTION_KEY` | account secret encryption material | required when PostgreSQL is configured |
| `CARTETHYIA_REQUEST_TIMEOUT` | total request budget | default `2m`; `>0` and at most `24h` |
| `CARTETHYIA_READ_HEADER_TIMEOUT` | inbound header-read budget | default `10s` (capped to request timeout); cannot exceed request timeout |
| `CARTETHYIA_CONNECT_TIMEOUT` | dependency/connect budget | default `10s`; `>0` and at most `24h` |
| `CARTETHYIA_FIRST_BYTE_TIMEOUT` | upstream first-byte budget | default `30s`; `>0` and at most `24h` |
| `CARTETHYIA_IDLE_TIMEOUT` | HTTP idle/default stream-idle budget | default `60s`; `>0` and at most `24h` |
| `CARTETHYIA_STREAM_IDLE_TIMEOUT` | refreshed stream event/write idle budget | defaults to `CARTETHYIA_IDLE_TIMEOUT`; `>0` and at most `24h` |
| `CARTETHYIA_STREAM_TOTAL_TIMEOUT` | absolute stream lifetime budget | defaults to `CARTETHYIA_REQUEST_TIMEOUT`; `>0` and at most `24h` |
| `CARTETHYIA_SHUTDOWN_TIMEOUT` | graceful shutdown budget | default `10s`; `>0` and at most `24h` |
| `CARTETHYIA_USAGE_RETENTION` | telemetry retention | default `720h`; `>0` and at most `8760h` |
| `CARTETHYIA_MAX_BODY_BYTES` | request body bound | default `16777216`; maximum `67108864` |
| `CARTETHYIA_MAX_HEADER_BYTES` | aggregate request-header bound | default `1048576`; range `65536..2097152` |
| `CARTETHYIA_MAX_OUTPUT_TOKENS` | output-token bound | default `1048576`; maximum `16777216` |
| `CARTETHYIA_MAX_CONCURRENT` | global request concurrency bound | default `256`; maximum `100000` |
| `CARTETHYIA_MAX_CONCURRENT_STREAMS` | active stream concurrency bound | default `256`; maximum `100000` |

Legacy `DATABASE_URL`, `REDIS_URL`, `ACCOUNT_ENCRYPTION_KEY`, and `NODE_ENV`
remain compatibility fallbacks in config parsing. They should not be used in
new deployment manifests.

Never put the account encryption key into a Dockerfile, image `ENV`, source
control, dashboard settings DTO, or log line.

Configuration parsing rejects malformed durations/integers, unsupported URL
schemes, an invalid listen address, empty/unbounded environment names, and
values outside the ranges above before runtime construction or listener
startup. PostgreSQL accepts only `postgres`/`postgresql`; Redis accepts only
`redis`/`rediss`.

## 2. Local Laragon stack

The repository root `.env` is configured for the local Laragon services:

```text
PostgreSQL  127.0.0.1:5432  database cartethyia
Redis       127.0.0.1:6379  database 0
Daemon      127.0.0.1:12800
Aux server  127.0.0.1:8787  /internal/* only
```

Run the daemon from the repository or daemon directory:

```powershell
cd daemon
go run ./cmd/cartethyia
```

For hot reload from the repository root, use `bun run dev` (Air config
`daemon/.air.toml`). The dashboard dev server (`bun run dev` from
`dashboard/`, port 5173) and the auxiliary server (`bun run server` from
`dashboard/`, port 8787) are separate processes.

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

The root Dockerfile has these targets:

```bash
docker build --target runtime -t cartethyia:2.1.0 .
docker build --target dashboard -t cartethyia-dashboard:2.1.0 .
docker build --target dashboard-audit -t cartethyia-dashboard-audit:2.1.0 .
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
  -e CARTETHYIA_ENCRYPTION_KEY="$CARTETHYIA_ENCRYPTION_KEY" \
  cartethyia:2.1.0
```

## 6. Docker Compose

Compose starts PostgreSQL, Redis, the daemon, the nginx dashboard edge, and
the dashboard auxiliary server:

- `postgres` and `redis` start first with healthchecks;
- `cartethyia` (the daemon) is gated on both and stays internal to the
  Compose network on `:12800`;
- `dashboard` is the single published edge (`12800:80`): nginx serves the
  SPA and proxies `/console/`, `/v1/`, `/v1beta/`, and public
  `/share/*/data|stream` to the daemon, and `/internal/` to
  `dashboard-audit`;
- `dashboard-audit` runs the Bun auxiliary server (`:8787`, `/internal/*`
  only) gated on the postgres healthcheck.

```bash
cp .env.example .env
# Set CARTETHYIA_ENCRYPTION_KEY in .env.
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

## 7. API-key admission and token quota

For authenticated dispatch routes, the public boundary owns provider/model
ACLs, requests per minute, and per-key concurrency. Limits use the resolved,
redacted key ID; the presented Bearer or `X-API-Key` secret is never an
admission key and never enters evidence. A configured provider allowlist
requires a provider-qualified model identity; `X-Cartethyia-Provider` cannot
override routing or ACL evaluation.

One-time, daily, and monthly token limits are hard limits when configured. The
middleware fails closed with `503` if such a key has no durable quota authority.
Before each real upstream call, PostgreSQL atomically reserves a bounded input
plus output estimate under `(key_id, request_id, attempt)`. Already exhausted
one-time keys and a reservation that would exceed any window return `429`.
Daily windows use UTC calendar days and monthly windows use UTC calendar
months.

Provider-reported terminal usage reconciles the reservation exactly once. An
attempt proven not accepted is released. When usage is missing or incomplete,
the committed amount remains at least the estimate. If actual usage is larger,
the actual value is committed and future reservations are blocked as needed;
an already successful response is not changed by reconciliation or telemetry
failure. Expired abandoned reservation rows are recovered by bounded cleanup.

Global request and active-stream concurrency are separate dispatch leases. A
stream retains those leases, its account/proxy ownership, and its quota handle
until terminal completion, cancellation, close/abort, truncation, or downstream
write/flush failure.

## 8. Lifecycle and shutdown

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

## 9. Operator CLI

The command runner has stable integer exit codes and never prints a credential,
raw response body, prompt, URL credential, or raw account/proxy ID. `--json` is
command-local and emits a bounded object. JSON failures contain `ok: false`,
the command, one stable code, and a generic message; human failures use generic
stderr text.

| Constant | Value | JSON failure code | Meaning |
| --- | ---: | --- | --- |
| `ExitSuccess` | `0` | — | command completed successfully |
| `ExitConfiguration` | `2` | `configuration_failure` | arguments or daemon configuration invalid |
| `ExitDependency` | `3` | `dependency_failure` | required database/runtime dependency unavailable |
| `ExitRouteUnavailable` | `4` | `route_unavailable` | no read-only route candidate is usable |
| `ExitProtocolFailure` | `5` | `protocol_failure` | probe status/media type/framing is invalid |
| `ExitTimeout` | `6` | `timeout` | command context or probe deadline expired |
| `ExitAuthorizationFailed` | `7` | `authorization_failure` | daemon rejected probe authorization |

### Serve

```bash
cartethyia
cartethyia serve
cartethyia serve --json
```

Providing no subcommand remains exactly equivalent to `serve`: dotenv loading, config
parsing/validation, runtime construction, signal cancellation, and graceful
close are unchanged.

### Doctor

```bash
cartethyia doctor
cartethyia doctor --json
```

`doctor` is read-only. It validates configuration and the dependencies needed
to construct diagnostics, including database/migrations, provider registry,
catalog, account references, proxy configuration, and required runtime
services. It does not call a model endpoint or reveal a DSN/credential.

### Explain a route

```bash
cartethyia route explain --model gpt-5 \
  --surface openai-chat
cartethyia route explain --model claude-sonnet \
  --surface anthropic-messages --json
```

Accepted surfaces are `openai-chat`, `openai-responses`, and
`anthropic-messages`. Explain uses the same immutable route-plan builder and
read-only account/proxy health snapshots as dispatch. It does not acquire a
lease, increment in-flight state, refresh credentials, run a probe, or mutate
health. Account/proxy identifiers in output are stable hashes.

### Probe the running daemon

```bash
export CARTETHYIA_PROBE_KEY='...'
cartethyia probe --url http://127.0.0.1:12800 \
  --model gpt-5 --surface openai-chat \
  --credential-env CARTETHYIA_PROBE_KEY

printf '%s' "$CARTETHYIA_PROBE_KEY" | cartethyia probe \
  --url https://router.example \
  --model gpt-5 --surface openai-responses --stream \
  --timeout 30s --credential-stdin --json
```

`--timeout` defaults to `30s`. Exactly one of `--credential-env <ENV_NAME>` or
`--credential-stdin` is required. Secret/token/key/password/authorization/
bearer value flags are rejected before normal flag parsing. The URL must be an
HTTP(S) origin with no userinfo, query, fragment, or non-root path. Probe always
posts a fixed bounded minimal payload to the running daemon's canonical
`/v1/chat/completions`, `/v1/responses`, or `/v1/messages` path; there is no
upstream-provider URL mode. Non-stream probes validate status/media type;
stream probes additionally validate the first frame and explicit surface
terminal framing.

## 10. Health and diagnosis

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
| dashboard cannot load data | dashboard origin/API proxy and `/console/*` auth | dashboard is a separate process/plane |

Do not “fix” unavailable dependencies by enabling synthetic production accounts,
empty success responses, or a second unofficial storage authority.

## 11. Deployment verification checklist

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

## 12. Compatibility inspection and replay

The offline compatibility commands use the daemon's production decoders,
canonical planner, codecs, capability policies, and corpus scorer. They never
send a provider request unless `compat replay` is explicitly selected.

```bash
cartethyia compat detect --input testdata/compatibility/fixture.json --json
cartethyia compat translate --input testdata/compatibility/fixture.json \
  --from openai-chat --to openai-responses --provider openai --model gpt-5.6 \
  --report-json --output ./redacted-target.json
cartethyia compat matrix --corpus testdata/compatibility --json
cartethyia compat replay --input testdata/compatibility/fixture.json \
  --url http://127.0.0.1:12800 --surface openai-responses --model gpt-5.6 \
  --credential-env CARTETHYIA_PROBE_KEY --json
cartethyia cache explain --input testdata/compatibility/cache-fixture.json \
  --provider openai --model gpt-5.6 --surface openai-responses --json
cartethyia accounts readiness --json
```

`detect` reports endpoint/body-authoritative surface, bounded profile evidence,
operation, compaction version, features, confidence, and ambiguities. Profiles
are hints for translation only: Claude Code, Codex CLI, Gemini CLI,
OpenAI-compatible CLI, and unknown-standard clients cannot select a provider,
account, tenant, credential, or model permission. `translate` writes a body
only when `--output` is explicit and reports preserve/translate/clamp/
strip/reject dispositions. It never prints a prompt or provider response by
default.

`matrix` exits `0` on an accepted corpus, `8` when the weighted score is below
the gate, and `9` when any Tier-0 invariant fails. Configuration, dependency,
protocol, timeout, route, and authorization failures retain exits `2`, `3`,
`5`, `6`, `4`, and `7` respectively. A matrix report includes schema and
corpus generation, weighted score, Tier-0 status, grouped failures, and failing
fixture IDs only. The approved gate is score `>=95%`, Tier-0 `100%`, zero
avoidable pool errors, zero false/cross-tenant cache reuse, and at least `90%`
provider-reported second-request hits on eligible prompt-cache fixtures.

`replay` requires exactly one credential input (`--credential-env` or
`--credential-stdin`), a credential-free HTTP(S) origin, and a bounded fixture.
It validates status/media type, first frame, sequence/index order, exactly one
terminal event, semantic digest, usage, compaction item count, timeout, and
cancellation. `cache explain` reports only eligibility, boundary category,
opaque digest prefix, marker location, policy ID/generation, disabled code, and
optional bounded provider usage. `accounts readiness` is read-only: it takes a
safe immutable snapshot and does not acquire, refresh, probe, or mutate state.

## 13. Capability and error-code matrix

The route explanation and compatibility reports distinguish source surface,
provider target surface, model policy generation, and operation. Compact V1 and
V2 are independent capabilities; a bridge is a separate capability. Gemini
native generation and stream support are independent of OpenAI Chat/Responses
support. Anthropic `context_management` is native and distinct from compact
V1/V2.

| Gap | Stable code family | Operator action |
| --- | --- | --- |
| function/custom/computer/hosted/server/MCP tool | `capability.tool_kind_unsupported` | choose a target advertising the required kind |
| image/audio/file/reference or MIME | `capability.media_reference_unsupported` | use a supported URL/inline/file-ID/file-URL alternative |
| document/PDF/context management | `capability.document_unsupported` | use a target with document policy or retain Anthropic native surface |
| remote compaction V1/V2 | `capability.remote_compaction_v1_unsupported`, `...v2_unsupported` | select a version-capable target |
| V1↔V2 bridge | `capability.remote_compaction_bridge_unsupported` | disable the bridge or select same-version support |
| explicit lossy projection | `compat.loss_opt_in_required` | enable both tenant and provider policy; never infer consent |
| malformed/oversized sidecar or canonical body | `transforms.*` / `compat.plan_bounds` | fix fixture/request; do not retry upstream |

Capability errors are pre-dispatch route decisions, not generic `500`/`502`
failures. A later successful candidate hides recoverable earlier failures;
when no candidate succeeds, the final error preserves the most actionable
credential, translation, quota, network, deadline, or budget meaning.

## 14. Metrics, caches, readiness, and retention

`GET /metrics` exposes bounded counters/histograms for source/target/profile
plan actions, capability-code outcomes, operation/compaction/bridge results,
tool-repair dispositions, media/document rejections, plan-cache L0/L1,
token-saver L0/Redis, response-cache L0/Redis, provider-prompt lookup/hit/write/
fallback, provider cache read/write tokens, preparation exclusions, hidden
recovery, avoidable errors, typed exhaustion, hedge outcomes, and dropped
evidence. Labels never contain request/account IDs, cache digests, prompt/tool
content, credentials, URLs with userinfo, or provider response text.

Prompt-cache markers and identities are planned once from the final target wire
tree and are tenant/provider/model/policy-generation scoped. Response-cache
hits validate through the source encoder and perform zero account/provider
calls. Errors, incomplete output, streaming, tools/native actions,
continuations, compact operations, and lossy projections are ineligible.

Redis is advisory. Shared transformed content, when explicitly enabled, is
tenant-scoped AEAD with an opaque namespace, bounded value, generation check,
and a TTL capped at one hour. Expired, malformed, undecryptable, or generation-
mismatched values are misses and fall back to L0/recomputation; plaintext Redis
values and post-one-hour hits are failures. PostgreSQL remains the durable
authority for accounts, credentials, leases, quotas, and retention metadata.

Readiness is a bounded account/provider/model/surface/policy-generation
snapshot. Ready ranks before unknown/stale; permanent reauth/configuration
failures remain unavailable until generation changes. Delayed hedging is
default-off and may add only one prepared, idempotent, pre-commit attempt with
independent reservations and exactly-once loser finalization.

## 15. Permanent exclusions and clean-cutover review

The following remain intentionally absent: dashboard and Share UI changes,
`alegacy/` migration, public-path renames, live fusion/panel/judge, moderation-
evasion rewriting, captured identity-header replay, billable model probes, and
active real-provider survey gates without explicit credentials/budget. These
are permanent exclusions, not degraded fallbacks.

The source-level clean-cutover/authority audit is
`daemon/internal/proxy/runtime/task24_cutover_audit_test.go`; it is a review
report/test and is not run by the normal deployment checklist. It verifies the
single classifier/planner/codec/preparer/router/pool/cache/evidence authorities,
stable error-code families, and absence of the old Chat mutation, raw projection
file, global unknown merge, and adapter-local cache identity helpers. The
pre-prepare transport interface and no-codec StreamBridge constructor are
explicitly retained compatibility shims until all active callers migrate; they
must not acquire new callers or authority.
