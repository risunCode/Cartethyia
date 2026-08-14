# Engineering: Contracts, Conventions, Operations, and Testing

## Coding conventions

### Go

```text
handler -> closed input -> service -> bounded output
```

Handlers must:

- enforce registered methods;
- bound JSON/body size;
- validate before side effects;
- use `context.Context`;
- write stable envelopes;
- preserve cancellation;
- avoid package-global providers/storage;
- never serialize `err.Error()` directly.

Use typed contracts for surfaces, errors, rate source/scope/phase, lifecycle stages, and opaque credential references. Keep wrapped causes internal.

### TypeScript

```text
lib/api.ts          low-level HTTP boundary
lib/daemon-api.ts   V2 helper + closed parsers
lib/daemon-routes.ts route/method matrix
lib/query-keys.ts   invalidation namespaces
features/*/api.ts   resource builders/parsers
features/*/queries  hooks/mutation state
features/*/page.tsx UI states
```

Use `daemonGet`, `daemonPost`, `daemonPatch`, and `daemonDelete` for browser resources. Never use `/v1/*` from dashboard code. Never spread unknown daemon objects into React state.

## Browser V2 contract

```text
+---------------------------+
| Dashboard resource       |
+-------------+-------------+
              | GET/POST/PATCH/DELETE
              v
+---------------------------+
| /v2/admin/*              |
+-------------+-------------+
              v
+---------------------------+
| { data: closed DTO }     |
| or { error: bounded }    |
+---------------------------+
```

`QUERY` is unsupported. GET has no request body. Absolute URLs and `/v1/*` are rejected by the transport boundary.

Success data is closed and bounded. Unknown fields are discarded. Missing facts remain `null`/`Unknown`; errors are not converted into empty success lists.

## Error contract

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

Stable fields:

```text
source: admission | account | provider | network | translation | admin
scope:  client | route | provider | model | account | proxy | global
phase:  pre_dispatch | provider | partial_work
kind:   invalid_request | authentication | rate_limit | quota | transient | fatal
code:   namespaced stable string
```

Never include prompts, bodies, credentials, cookies, authorization, tool arguments/results, raw upstream messages, or wrapped causes.

## Secret boundary

```text
credentialRef
      |
      v
late CredentialResolver
      |
      v
short-lived transport credential
      |
      v
provider call
```

Only the opaque reference may cross dashboard/resource boundaries. Clear sensitive form state after success, error, and cancellation. Probe URLs reject embedded credentials and credential-like query keys.

## Observability

Console Log contains lifecycle evidence:

```text
incoming -> admission -> route -> attempt -> retry/fallback
         -> completion | failure | cancellation
```

Request Log is narrower: it contains only canonical external `POST /v1/action` evidence. Dashboard Web Request is a V2 admin operation and belongs to Console Log/admin evidence, not Request Log.

Safe evidence dimensions:

```text
request_id, trace_id, method, path, surface, client_family,
provider, model, account/proxy display, attempt, latency,
stage, outcome, error/rate metadata, cache status
```

No raw payloads.

## Operations

```text
operator action
      |
      v
scope check + validation
      |
      v
confirmation when destructive
      |
      v
pending lock
      |
      v
V2 action
      |
      v
success | forbidden | unavailable | stale | failed
```

This applies to settings, backups, restore/delete, cache/reindex/probe/restart, and proxy mutations. Binary backup downloads use a bounded raw path and safe filenames.

If a service is not composed, show unavailable. Do not fabricate healthy, zero, empty, or successful data.

## Trusted ingress

Forwarded headers are untrusted by default. Enable trusted forwarded identity only behind an ingress that strips/replaces the headers. Client-family detection is advisory and never authorization.

## Testing

Focused daemon tests:

```bash
cd daemon
go test ./internal/server/...
go test ./internal/proxy/...
go test ./internal/observability/...
```

Focused dashboard tests:

```bash
cd dashboard
bun x vitest run test/lib/api.test.ts
bun x vitest run test/lib/daemon-api.test.ts
bun x vitest run test/lib/legacy-surface.test.ts
```

Full gates:

```bash
cd daemon
go test ./...
go vet ./...
go build ./cmd/cartethyia

cd ../dashboard
bun run test:ci
```

Test behavior, not source text. Cover malformed input, unavailable services, stale responses, cancellation, retry/fallback, redaction, unknown values, and destructive mutation state.

## Browser smoke

Dashboard and daemon are separate processes. Use the project-configured ports:

```text
GET /                 -> landing
GET /console/         -> console entry
session guard         -> login or overview
GET /v2/admin/...     -> valid envelope or truthful unavailable
```

Do not send dashboard browser requests to the daemon port and expect SPA HTML.

## Durable decisions

- `/v1/*` is external client ingress; `/v2/admin/*` is browser/admin.
- Standard HTTP methods only.
- Opaque credentials and closed DTOs.
- Truthful unknown/degraded/unavailable states.
- Provider/account/network selection stays separate.
- Normalize at ingress and translate at protocol edges.
- Cache marking is provider capability-gated and must protect stable prefixes.
- Destructive operations require explicit confirmation and observable failure state.
