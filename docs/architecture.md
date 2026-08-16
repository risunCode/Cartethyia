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
| SDK / CLI / IDE / HTTP     |                 | SolidJS/Vite                |
+-------------+--------------+                 +-------------+--------------+
              |                                              |
              | POST /v1/*                                   | GET/POST/PATCH/DELETE
              v                                              v
+----------------------------+                 +----------------------------+
| External client plane      |                 | Admin control plane         |
| OpenAI / Anthropic shapes  |                 | /console/*                |
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

`/v1/*` adalah ingress client. `/console/*` adalah control plane dashboard.
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
    - API-key ACL, RPM, concurrency, and hard-quota authority
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
    - local RTK pass over eligible older tool-result text
    - same-surface requests (client surface == target surface) take the in-place healing fast path (model suffix, tool-call healing, thinking normalization) without full AST reconstruction
    |
    v
immutable route plan
    - requested model and one catalog generation
    - one member, resolved alias, or ordered fallback members
    - provider/client model/upstream model/surface per member
    |
    v
router-owned attempt coordinator
    - atomically acquire the least-loaded eligible account lease
    - select direct/proxy network path
    - resolve the credential only at the transport boundary
    - execute exactly one transport call for the current attempt
    |
    v
classified result
    - success, stop, refresh, compatibility repair, next account,
      next route member, or a bounded wait
    |
    v
response boundary
    - non-stream JSON, or canonical stream commit gate
    - client-surface encoding and safe response headers
    |
    v
exactly-once finalization
    - release account/proxy/global/stream ownership
    - reconcile durable token reservation when usage is known
    - enqueue bounded, secret-free evidence and metadata
```

The catalog plan is internal data. Client-supplied routing headers are removed
before plan construction and cannot select a provider, account, catalog
generation, or continuation authorization scope.

### 3.1 One attempt budget and failure scopes

The router is the only component allowed to start another upstream call. The
initial call, same-account refresh call, compatibility-repair call,
alternate-account call, and next fallback-member call each consume one slot
from the same request-wide budget. Catalog lookup, account selection, and wait
time do not consume an attempt. Transport performs one HTTP call and never
retries underneath the router.

A classified failure updates only its proven scope:

| Scope | Examples | Router effect |
| --- | --- | --- |
| request/route | invalid input, unsupported surface, content policy | stop without poisoning shared health |
| account | authentication or account quota | refresh once when allowed, cool/exclude that account |
| model on account | model capacity or model-specific quota | lock only that model/account pair |
| proxy | connect, TLS, header/body/stream read failure through that proxy | record one attempt failure in the existing proxy-health coordinator |
| provider | proven provider-wide transient/server failure | apply provider-scoped availability evidence |

Cancellation stops before another attempt and does not mark account, provider,
or proxy health failed. Retry-after waits are capped by the remaining request
deadline and router wait limit.

### 3.2 Stream commit state machine

```text
connecting
    -> classified failure before output: router may retry within budget
    -> valid SSE: pre-commit

pre-commit
    -> bounded start/metadata/usage prelude: buffer and continue
    -> error, malformed event, stall, or early EOF: router may retry
    -> first semantic text/reasoning/tool/image event: committed
    -> explicit successful terminal: terminal (the terminal is replayed)

committed
    -> semantic events: remain committed
    -> explicit terminal: terminal
    -> error, truncation, timeout, client/write/flush failure: failed-after-commit
```

No retry is permitted after semantic commit. Provider SSE is decoded with
bounded line/event sizes and mapped to canonical events before a downstream
surface encoder observes it. EOF without an accepted terminal and scanner/read
errors are failures, never synthesized success. Every complete downstream SSE
frame is flushed.

### 3.3 Lifecycle ownership

Ownership transfers in one direction:

```text
public middleware: API-key admission + durable quota identity
    -> dispatch: global/stream admission lease
        -> router attempt: account lease + proxy selection + response body
            -> returned stream: one sync.Once finalizer owns all live resources
```

Non-stream attempts release their leases before returning. A returned stream
keeps account, proxy, global admission, stream admission, quota reservation,
usage accumulation, and final evidence alive until terminal completion, Close,
Abort, cancellation, truncation, or downstream write/flush failure. Later
Close/Abort calls are harmless. Metadata, history, continuation, and metrics
are post-outcome side effects: their failure is recorded but cannot replace a
successful client result.

### 3.4 Durable token quota

Public API-key middleware owns RPM, per-key concurrency, ACL checks, and
one-time/daily/monthly hard limits. Global and stream concurrency remain owned
by dispatch; there is no second API-key counter below authentication. When a
hard token limit exists, each real upstream attempt reserves a conservative
estimate in PostgreSQL using `(key_id, request_id, attempt)`. Reservation and
window counters are atomic across daemon replicas. Known usage reconciles the
reservation exactly once; a call proven unaccepted releases it. Unknown or
partial usage conservatively commits at least the estimate, and exceeding an
estimate blocks later reservations rather than rewriting an already successful
response.

### 3.5 Safe headers and proxy health

The response boundary copies only normalized upstream request IDs and
documented rate-limit metadata, plus Cartethyia-owned content/cache headers.
Cookies, authorization, hop-by-hop, proxy, provider-private, arbitrary, and
internal routing headers are dropped.

Network-path health uses the existing durable selector and one bounded
coordinator. Connect/TLS/header/body/stream transport failures are attributed
at most once per proxy/request/attempt. Client cancellation and classified
provider responses are not proxy failures. Correlated failures are collapsed,
the configured threshold opens a durable quarantine, and one bounded recovery
probe after expiry either restores the path or extends capped backoff.

### 3.6 Lifecycle evidence

One non-blocking `AttemptObserver` receives a completed record for every actual
upstream call plus bounded candidate-exclusion, repair, request-attempt-count,
and stream-finalization records. Attempt data comes from the route-plan member,
selected account/network path, canonical classification, elapsed time, and
known usage; it is never reconstructed from a routing header or raw provider
payload. The active observability registry owns fixed-cardinality counters and
histograms for attempts, failover/repair success, pre/post-commit failure,
truncation, admission wait, cooldown/quarantine, dropped evidence, attempt
count, and stream duration. Queue/map capacity is fixed: saturation increments
the dropped-evidence counter instead of delaying dispatch. Operational IDs are
bounded/redacted evidence fields, not metric labels.

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
/console/auth/*
/console/accounts*
/console/providers/*/accounts*
/console/keys*
/console/catalog/*
/console/custom-providers*
/console/proxies*
/console/proxy-settings
/console/web-search-routing
/console/settings
/console/backups*
/console/telemetry/*
/console/logs
/console/web-request
/console/tools/*
/console/dashboard
```

Login is the only unauthenticated admin route. Other routes require a valid
session and the scope associated with the operation. Missing services return
truthful `unavailable`; they do not fabricate empty success data.

## 5. Package ownership

```text
daemon/internal/server/api/          external client handlers, wire helpers
daemon/internal/server/apicontracts/ shared API contracts (cycle-breaker)
daemon/internal/server/apierrors/    public error envelopes (cycle-breaker)
daemon/internal/server/admin/        authenticated admin handlers
daemon/internal/server/middleware/   IDs, identity, request boundaries

daemon/internal/proxy/runtime/       dispatch, route loop, pool, streams
 daemon/internal/proxy/runtime/catalog/  model/provider catalog projection
 daemon/internal/proxy/control/admission/ request admission
 daemon/internal/proxy/control/continuation/ continuation state
 daemon/internal/proxy/control/cacheplan/ provider cache boundary planning
 daemon/internal/proxy/protocol/contracts/ normalized domain contracts
 daemon/internal/proxy/protocol/transforms/ protocol translation
 daemon/internal/proxy/protocol/healing/  edge-case healing + same-surface fast-path sanitization
 daemon/internal/proxy/protocol/jsonclone/ shared JSON-shaped clone helpers (CloneMap / CloneMapList / CloneValue)
 daemon/internal/proxy/transport/     provider network I/O
 daemon/internal/proxy/compression/   local RTK token-saver primitives

daemon/internal/accounts/            account/credential lifecycle, store, drivers
daemon/internal/providers/            provider registry and capabilities
daemon/internal/database/            PostgreSQL authority and repositories
daemon/internal/runtime/cache/       L0 memory + optional L1 Redis cache
daemon/internal/observability/       bounded lifecycle evidence
daemon/internal/runtime/             dependency composition and shutdown
```

The dependency direction is deliberately one-way:

```text
server handlers (api, admin)
    |
    v
proxy/runtime
    +--> control
    +--> protocol/contracts
    +--> protocol/transforms
    +--> protocol/healing
    +--> protocol/jsonclone
    +--> transport
    +--> compression
    |
    v
providers / accounts / database / cache
```

`server/middleware` and the lower-level `server/apicontracts` and
`server/apierrors` packages sit beside `server/api`; middleware imports the
cycle-breaker owners directly rather than through `server/api`.

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
- PostgreSQL atomically owns API-key one-time/daily/monthly committed and
  reserved token counters plus idempotent per-attempt reservation rows.
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
9. Every real upstream call consumes one router-visible attempt; transport has
   no hidden retry loop.
10. No retry starts after semantic stream commit.
11. Client-writable headers are not routing or continuation authority, and only
    the response-header allowlist crosses back to clients.

## 8. Current rewrite boundary

The Go daemon is the active core, but this 2.1.0 phase is a rewrite checkpoint,
not a claim of complete provider-production parity. Provider-specific live E2E,
Linux race verification, and additional hardening remain follow-up work.

The local RTK package under `daemon/internal/proxy/compression/` is wired into
normalization for OpenAI Chat, OpenAI Responses, and Anthropic Messages. The
default balanced, synchronous, fail-open pass may shorten only eligible older
tool-result text; it does not rewrite user text, system instructions, tool
schemas, images, reasoning, IDs, or recent turns. Images, Models, and Action do
not independently run an extra token-saver stage. This local transformation is
separate from provider prompt-cache markers and Redis.

## 9. Compatibility architecture (active cutover)

Compatibility has three independent axes. **Source** is the client contract and
profile evidence (`openai-chat`, `openai-responses`, Anthropic Messages, or
native Gemini). **Target** is the provider/model wire contract selected by the
catalog. **Operation** is endpoint/body authoritative and is either ordinary
generation, remote compaction V1, or remote compaction V2. A header or model
name is never allowed to override those three facts.

The active path is:

```text
source decoder + profile hints
        -> canonical request (operation, messages, tool ledger, media refs)
        -> compatibility.Plan(source, target, operation, policy generation)
        -> target request codec (one final validation/marshal)
        -> provider transport
        -> target response decoder / stream event decoder
        -> canonical response/events
        -> source response codec and terminal framing
```

The planner records a bounded disposition for every known feature:
`preserve`, `translate`, verified `clamp`, fixture-backed
`strip-nonsemantic`, `reject`, or same-surface `passthrough-native`. A failed
cross-surface response projection is a coded translation failure; an
incompatible raw provider body is never returned to a strict client. Same-
surface native responses may pass through only when the route plan explicitly
selected that contract.

### 9.1 Gemini and compaction

Gemini is a first-class source/target surface. Its `contents`/parts,
`functionCall`/`functionResponse`, `inlineData`/`fileData`, citations, usage,
and stream terminal events are decoded into the same canonical model without
using an OpenAI-pivot body. Gemini capability failures are planned before
account acquisition and carry bounded alternatives.

Compact V1 is a non-stream endpoint operation; compact V2 is a streamed final
trigger operation. Same-version passthrough is preferred. V1↔V2 bridges are
allowed only when the provider policy explicitly advertises the bridge. Each
accepted request and response contains exactly one typed compaction item,
preserves native history and usage, and validates terminal order. Anthropic
`context_management` remains a distinct native operation and is never silently
treated as OpenAI/Codex compaction.

### 9.2 Tool, media, and unknown fields

The canonical tool occurrence ledger pairs each declaration, call, and result by
occurrence (not merely a reused wire ID), preserving order, parallel groups,
error state, and result media. Function, custom, computer, hosted/server, MCP,
and provider-native tools remain distinguishable. Missing IDs are deterministic
and no empty successful result is fabricated.

Images, audio, files, and PDFs carry typed MIME, detail, order, and reference
kind (URL, inline data, provider file ID, or provider file URL). Unsupported
references fail before dispatch with a specific capability code and bounded
supported alternatives.

Provider-native fields that are not common semantics use the exact-path native
sidecar. Same-surface fields are reapplied only at their original JSON pointer
and stable array identity. Cross-surface fields require an explicit mapping;
there is no recursive/global unknown-field merge.

### 9.3 Ownership and error authority

| Decision | Owner | Subowner | Authority rule |
| --- | --- | --- | --- |
| client profile/evidence | `protocol/compatibility` | `Classify` | endpoint/body are authoritative; headers are hints |
| source/target/operation plan | `protocol/compatibility` | `Plan` | one catalog/policy generation |
| request/response codecs | `protocol/transforms` | `Registry` | one codec per surface; codecs own projection |
| candidate preparation | `proxy/runtime` | `CandidatePreparer` | local failures consume no upstream attempt |
| attempts, retry, hedge, commit | `proxy/runtime` | `Router` | one global budget; no retry after commit |
| account authority | `accounts` + PostgreSQL | leases/reservations | cache is never credential/account authority |
| provider prompt cache | `proxy/control/cacheplan` | `PlanFinalWire` | final target tree, tenant/provider/model scoped |
| lifecycle evidence | `observability` | `Registry` | fixed-cardinality, bounded, secret-free |

The stable error-code registry is shared by compatibility, transforms, runtime,
cache, and CLI boundaries. Capability failures include tool kind, media/
reference, document/PDF, compaction version/bridge, and loss opt-in codes;
invalid/nil state is rejected with a typed code rather than a panic or nil
success. No component below the router owns a second retry, cache planner,
stream commit, or finalizer authority.

### 9.4 Preparation, readiness, hedging, and cache boundaries

When configured, candidate preparation resolves credentials, policy generation,
final target body, endpoint, proxy/network selection, and local quota eligibility
before attempt reservation. Ready accounts rank ahead of unknown/stale accounts;
permanent reauthentication/configuration failures remain unavailable until the
credential/config generation changes. Delayed hedging is default-off, limited
to one extra prepared attempt, pre-commit, idempotent requests, and exactly-once
loser finalization.

The provider prompt-cache planner is the only provider marker/key authority and
consumes the final target-wire tree. Local token-saver, compatibility-plan,
shared-content, and complete response caches remain separate. Shared content
uses an opaque tenant namespace and tenant-scoped AEAD; Redis is advisory and
falls back to L0/recomputation. Compact operations, streaming, tools/native
actions, continuations, errors, incomplete output, and lossy projections are
ineligible for response caching.

### 9.5 Performance and boundedness

All request, response, sidecar, event, disposition, alternatives, evidence
queues/maps, and CLI fixture reads have fixed bounds. Standard same-surface
benchmarks are the gate: a median `ns/op` or `B/op` regression greater than
`+10%` requires measured approval. The 10,000-account load path bounds local
preparation independently from upstream attempts; queue saturation drops
evidence rather than delaying dispatch. No prompt, tool content, credential,
cache digest, account ID, or request ID is a metric label.

### 9.6 Cutover audit and deliberate compatibility shims

`internal/proxy/runtime/task24_cutover_audit_test.go` is the source-level
owner/error-code/obsolete-symbol audit. It is intentionally not part of the
routine operator verification order. The audit confirms that the old Chat
mutation, raw projection file, global unknown merge, and adapter-local cache
identity helpers are absent. The pre-prepare `Transport.Call` interface and the
no-codec `NewStreamBridge` constructor remain documented compatibility shims
because active callers/tests still exercise them; production dispatch uses the
candidate-preparation contract and `NewCodecStreamBridge`. They are not new
authorities and must be removed only after every caller migrates and the focused
tests prove the replacement. Until then, the transport shim remains the active
fallback for callers that have not adopted `CandidatePreparer`.