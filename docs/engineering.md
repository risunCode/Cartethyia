# Engineering Conventions, Contracts, Security, and Testing

## 1. Go request convention

```text
HTTP handler
    -> bounded input contract
    -> validation
    -> service
    -> bounded output or typed error
```

Handlers must:

- register only the supported standard methods;
- bound headers, body, JSON depth/size, and output size;
- validate before side effects;
- pass `context.Context` through all I/O;
- preserve cancellation and deadlines;
- use injected services instead of package-global storage/provider state;
- write stable public envelopes;
- avoid serializing `err.Error()` directly into public responses.

The active package ownership is documented in [Architecture](architecture.md).
The root `internal/proxy` package is a compatibility facade; new code should
import the owning package when it needs a concrete subsystem.

## 2. Closed contracts and unknown values

Public admin resources use closed, bounded DTOs. Unknown fields are discarded
at the boundary. Missing facts remain `null`, `unknown`, `unavailable`, or
`stale` as appropriate; they are not converted into empty success lists.

The external error shape is namespaced and bounded:

```json
{
  "error": {
    "code": "provider.rate_limited",
    "message": "The upstream provider is rate limited.",
    "request_id": "req_abc123",
    "retryable": true,
    "retry_after_ms": 1000
  }
}
```

Internal failures carry typed dimensions:

```text
source: admission | account | provider | network | translation | admin
scope:  client | route | provider | model | account | proxy | global
phase:  pre_dispatch | provider | partial_work
kind:   invalid_request | authentication | rate_limit | quota | transient | fatal
```

Wrapped causes stay internal. Public responses expose stable codes and safe
messages only.

## 3. Secret boundary

```text
opaque credentialRef
        |
        v
late credential resolver
        |
        v
short-lived transport credential
        |
        v
provider call
        |
        v
zero/short lifetime after use
```

Rules:

- account and routing structs carry only opaque references;
- PostgreSQL stores encrypted access/refresh secret material;
- dashboard/API DTOs never return token values;
- authenticated proxy URLs are never rendered;
- credentials are not accepted through custom-provider metadata routes;
- clear sensitive browser form state after success, error, and cancellation;
- URLs with embedded credentials or credential-like query keys are rejected;
- request bodies, prompts, cookies, tool arguments/results, and raw upstream
  messages never enter telemetry evidence.

## 4. Admin and dashboard contract

The dashboard uses the admin plane only:

```text
GET/POST/PATCH/DELETE /v2/admin/*
```

It must not call `/v1/*` for operator resources. `QUERY` is unsupported. GET
requests have no JSON body. Resource responses use closed `{data: ...}` or
bounded `{error: ...}` envelopes.

The daemon and dashboard are separate processes. Dashboard HTML is not served
by the Go daemon; the root Dockerfile can build the dashboard as a separate
image target.

## 5. Observability

Lifecycle evidence follows the request state machine:

```text
incoming
  -> admission
  -> provider/account/network route
  -> attempt
  -> retry/refresh/fallback
  -> completion | failure | cancellation
```

Safe fields include:

```text
request_id
trace_id
method
path
surface
client_family
provider
model
account display
proxy display/source
attempt
latency
stage
outcome
error/rate metadata
cache status
```

There are different evidence purposes:

- **Console Log**: lifecycle and operator-visible events.
- **Request Log**: canonical external client action evidence only.
- **Admin Web Request**: dashboard/admin operation evidence, not client request
  evidence.
- **Telemetry**: bounded aggregate usage, error, upstream, client, and request
  dimensions.

No log category may store raw prompts, full bodies, tokens, cookies, tool
payloads, authenticated proxy URLs, or raw provider error bodies.

## 6. Runtime and operations conventions

- Configuration enters through `daemon.LoadConfig()` and validated internal
  config before dependency construction.
- PostgreSQL is the durable authority when production or a database URL is
  configured.
- Redis is an optional cache dependency; the runtime composes memory fallback.
- Missing required production dependencies fail startup rather than producing a
  fake healthy runtime.
- Shutdown propagates context cancellation, closes listeners, stops workers,
  closes cache/database dependencies, and reports bounded shutdown errors.
- Dependency health is explicit. Offline/unhealthy Redis is not equivalent to a
  durable-store success.
- Docker runtime is non-root and must receive secrets at runtime, never in an
  image layer.

See [Operations](operations.md) for environment, Docker, Compose, health, and
troubleshooting procedures.

## 7. Testing strategy

Test observable behavior and boundary invariants, not implementation text.

### Focused Go tests

```bash
cd daemon
go test ./internal/server/...
go test ./internal/proxy/...
go test ./internal/observability/...
go test ./internal/database/...
```

### Full Go gates

```bash
cd daemon
go test ./...
go vet ./...
go build ./cmd/cartethyia
```

### Live PostgreSQL integration

The durable authority integration is opt-in:

```bash
cd daemon
CARTETHYIA_POSTGRES_URL='postgres://postgres@127.0.0.1:5432/cartethyia?sslmode=disable' \
  go test ./internal/database -run TestPostgreSQLAccountAuthorityIntegration -count=1
```

It covers migrations, account configuration, encrypted secrets, joined
account directory, refresh leases, fence tokens, and atomic refresh commit.

### Dashboard gates

```bash
cd dashboard
bun run test:ci
bun run build
```

### Required behavior cases

Add or preserve coverage for:

- malformed JSON and oversized bodies;
- unsupported methods and surfaces;
- unavailable services and truthful error envelopes;
- account cooldown, quota, reauth, and retry/fallback;
- provider translation and unsupported features;
- stream ordering, cancellation, malformed events, and terminal state;
- cache hit/miss/unknown and generation invalidation;
- secret redaction and SSRF/redirect policy;
- destructive admin confirmation and stale state;
- PostgreSQL/Redis failure and memory fallback.

Race-enabled verification requires a platform with a working C compiler. The
Windows workstation may compile and run normal tests while still being unable
to run `go test -race` when GCC/CGO is unavailable.

## 8. Change checklist

Before a runtime change:

1. Identify the owning package.
2. Check all exported callers and contracts.
3. Preserve standard method and error behavior.
4. Keep secret/raw-payload boundaries intact.
5. Add focused behavior tests for new branches.
6. Run focused package tests, then full Go tests and vet.
7. Smoke the actual daemon path when the change affects startup, routing,
   storage, or HTTP behavior.
8. Update the relevant consolidated document; do not create a one-file doc for
   every small concern.
