# Cartethyia Architecture

Dokumen ini menjelaskan arsitektur **active Go daemon**. `src.old/` adalah arsip
historis dan bukan sumber runtime aktif.

## 1. Terminologi

- **Client**: aplikasi yang memanggil Cartethyia, misalnya OpenAI SDK,
  Anthropic SDK, CLI, IDE agent, atau aplikasi HTTP sendiri.
- **Provider**: upstream yang dipanggil Cartethyia setelah routing, misalnya
  OpenAI, Anthropic, Codex, Antigravity, Grok Build, atau adapter lain yang
  terdaftar.
- **Surface**: bentuk kontrak client, bukan nama provider. OpenAI Chat,
  OpenAI Responses, dan Anthropic Messages adalah surface.
- **Account**: identity/credential slot provider yang dipilih untuk satu
  attempt. Secret tidak disimpan di object routing.
- **Network proxy**: jalur egress direct atau proxy yang dipilih setelah
  provider/account routing.

OpenAI-shaped request tidak otomatis harus menuju OpenAI. Surface client,
provider destination, account, dan network path adalah keputusan terpisah.

## 2. Dua API plane

```text
+----------------------------+                 +----------------------------+
| External client            |                 | Operator browser/dashboard |
| SDK / CLI / IDE / HTTP     |                 | React/Vite                  |
+-------------+--------------+                 +-------------+--------------+
              |                                              |
              | POST /v1/*                                   | GET/POST/PATCH/DELETE
              v                                              v
+----------------------------+                 +----------------------------+
| External client plane      |                 | Admin control plane         |
| OpenAI / Anthropic shapes  |                 | /v2/admin/*                |
+-------------+--------------+                 +-------------+--------------+
              |                                              |
              +----------------------+-----------------------+
                                     v
                         +----------------------------+
                         | Go daemon runtime          |
                         | accounts, routing, proxy,  |
                         | providers, storage, ops    |
                         +----------------------------+
```

`/v1/*` adalah ingress client. `/v2/admin/*` adalah control plane dashboard.
Dashboard tidak memakai `/v1/*` untuk operasi admin.

## 3. Request lifecycle

```text
client request
    |
    v
HTTP foundation
    - method/path check
    - request/trace IDs
    - body and header bounds
    - auth boundary
    |
    v
surface handler
    - /v1/chat/completions
    - /v1/responses
    - /v1/messages
    - /v1/images/*
    - /v1/action
    |
    v
normalize
    - client wire shape -> normalized request
    - model/surface/tools/reasoning/stream intent
    |
    v
admission and policy
    - request limits
    - provider capability
    - model/account eligibility
    - concurrency and quota state
    |
    v
route attempt loop
    - provider candidate
    - account candidate
    - network path
    - credential resolution at the late boundary
    |
    v
provider translation and transport
    - normalized request -> provider wire format
    - bounded timeout/body/stream handling
    |
    v
retry, refresh, fallback
    - classify result
    - release slot
    - refresh/reselect when allowed
    |
    v
response translation
    - provider response/events -> client surface
    - usage and terminal outcome
    |
    v
lifecycle evidence
    - completion, failure, or cancellation
    - bounded metadata only
```

At every attempt, the account slot is released on success, failure, and
cancellation. A partial stream is not converted into a successful empty
response.

## 4. Active HTTP surface

### Liveness and metrics

```text
GET /health
GET /metrics
```

`/health` is a GET-only liveness endpoint. Without configured artwork it returns
JSON status; with artwork it returns an operator-facing HTML page. It does not
replace dependency-specific probes.

### External client plane

```text
POST /v1/action
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
POST /v1/images/generations
POST /v1/images/edits
```

Unknown `/v1/*` paths receive a stable not-found error envelope. Unsupported
HTTP methods receive `405` with an `Allow` header.

### Admin plane

The admin registrar groups routes by service. Current groups include:

```text
/v2/admin/auth/*
/v2/admin/accounts*
/v2/admin/providers/*/accounts*
/v2/admin/keys*
/v2/admin/catalog/*
/v2/admin/custom-providers*
/v2/admin/proxies*
/v2/admin/proxy-settings
/v2/admin/web-search-routing
/v2/admin/settings
/v2/admin/backups*
/v2/admin/telemetry/*
/v2/admin/console/logs
/v2/admin/console/web-request
/v2/admin/tools/*
/v2/admin/dashboard
```

Login is the only unauthenticated admin route. Other routes require a valid
session and the scope associated with the operation. Missing services return
truthful `unavailable`; they do not fabricate empty success data.

## 5. Package ownership

```text
daemon/internal/server/api/v1/       external client handlers
daemon/internal/server/admin/        authenticated admin handlers
daemon/internal/server/middleware/   IDs, identity, request boundaries
daemon/internal/server/api/wire/     bounded JSON and stream writing
daemon/internal/server/api/errors/   public error envelopes

daemon/internal/proxy/proxy.go       historical import compatibility facade
 daemon/internal/proxy/runtime/      dispatch, route loop, pool, streams
 daemon/internal/proxy/runtime/catalog/  model/provider catalog projection
 daemon/internal/proxy/control/admission/ request admission
 daemon/internal/proxy/control/continuation/ continuation state
 daemon/internal/proxy/control/cacheplan/ provider cache boundary planning
 daemon/internal/proxy/protocol/contracts/ normalized domain contracts
 daemon/internal/proxy/protocol/transforms/ protocol translation
 daemon/internal/proxy/transport/     provider network I/O
 daemon/internal/proxy/compression/   local RTK token-saver primitives

daemon/internal/accounts/            account and credential lifecycle
daemon/internal/providers/            provider registry and capabilities
daemon/internal/database/            PostgreSQL authority and repositories
daemon/internal/runtime/cache/       L0 memory + optional L1 Redis cache
daemon/internal/observability/       bounded lifecycle evidence
daemon/internal/runtime/             dependency composition and shutdown
```

The dependency direction is deliberately one-way:

```text
server handlers
    |
    v
runtime/proxy
    +--> control
    +--> protocol/contracts
    +--> protocol/transforms
    +--> transport
    +--> compression
    |
    v
providers / accounts / database / cache
```

Protocol packages do not import runtime orchestration. Transport does not own
routing policy. PostgreSQL owns durable authority; the cache package never
becomes an account or credential source of truth.

## 6. Storage and dependency planes

```text
+-----------------------+       +-----------------------+
| PostgreSQL             |       | Redis                 |
| durable authority     |       | optional L1 cache     |
| accounts/secrets      |       | generation entries   |
| leases/metadata       |       | health/probe state    |
+-----------+-----------+       +-----------+-----------+
            |                               |
            +---------------+---------------+
                            v
                 +-------------------------+
                 | Go runtime composition  |
                 | L0 memory fallback     |
                 | repositories/services  |
                 +-------------------------+
```

- PostgreSQL is opened when production or a database URL requires durable
  authority. The account encryption key is required with PostgreSQL.
- Redis is optional. The runtime composes Redis as a remote backend with an
  in-memory fallback and bounded advisory behavior.
- The in-memory cache is not a replacement for PostgreSQL account authority.
- Credential references remain opaque until transport needs a short-lived
  credential.

## 7. Invariants

1. One normalized request model crosses the proxy hot path.
2. Provider, account, and network path remain separate routing decisions.
3. Account objects contain opaque credential references, never plaintext secrets.
4. Raw prompts, request bodies, cookies, credentials, tool payloads, and
   provider bodies do not enter lifecycle evidence or dashboard DTOs.
5. Unknown, empty, unavailable, degraded, and stale are distinct states.
6. Only standard HTTP methods are exposed; `QUERY` is unsupported.
7. Every external request has bounded IDs, timeouts, body size, and output size.
8. `src.old/` is historical and must not be imported by the active daemon.

## 8. Current rewrite boundary

The Go daemon is the active core, but this 2.1.0 phase is a rewrite checkpoint,
not a claim of complete provider-production parity. Provider-specific live E2E,
Linux race verification, and additional hardening remain follow-up work.

The local RTK package under `daemon/internal/proxy/compression/` is preserved as
an isolated token-saver pipeline. It is not automatically inserted into the
active dispatch path yet; documentation must not describe it as an automatic
request transformation until that wiring is implemented and verified.
