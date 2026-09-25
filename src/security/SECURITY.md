# Security

`src/security/` is the layered request-trust boundary: client identity,
gateway API-key authentication, CSRF, per-IP abuse protection, and per-key
admission (quotas, budgets, concurrency). Every layer is fail-closed —
a store outage rejects the request, never bypasses the limit. Console
dashboard sessions have their own DB-persisted lockout
(`src/console/auth/service.ts`); this package covers the `/v1/*` data plane
plus shared crypto/header primitives both planes use.

## Layout

```text
src/security/
  SECURITY.md      this file
  ip-boundary.ts   pure client-identity helpers (resolveClientIdentity, isTrustedProxyPeer)
  api-key-auth.ts  token extraction, HMAC lookup, frozen authorization snapshots, allowlists
  access-control.ts closed AccessScope model + immutable AccessDecision
  csrf.ts           stateless double-submit CSRF + session-cookie name
  abuse.ts          IpAbuseProtectionService + in-memory/Redis stores (/v1/* only)
  admission.ts      ApiKeyAdmissionService + atomic counter stores (reserve/reconcile/release)
  crypto.ts         AES-256-GCM credential encryption + HMAC secret hashing
  outbound-headers.ts API/dashboard CSP builders + BASE_PROTECTED_HEADERS
```

## Layer order on the data plane

Ingress (`src/transport/middleware/ingress.ts`, `pipeline.ts`) applies these
in order; prepare/dispatch consult the snapshot the authentication layer
produces:

1. `ip-boundary.ts: resolveClientIdentity` — `disabled` mode trusts the
   normalized TCP peer; `trusted` mode accepts `CF-Connecting-IP`,
   `True-Client-IP`, `X-Forwarded-For`, then `X-Real-IP`, but only when the
   TCP peer matches a `TRUSTED_PROXY_CIDRS` allowlist entry. Otherwise it
   falls back to the peer. Both the peer and the allowlist entry are
   normalized first, so an IPv4-mapped IPv6 peer (`::ffff:127.0.0.1`) matches
   a plain IPv4 network like `127.0.0.1/32`, and an accepted header value is
   normalized the same way. Pure function; console login reuses the same pair
   for its lockout key.
2. `abuse.ts: IpAbuseProtectionService.checkBeforeAccess` — `/v1/*` only
   (health and non-`/v1` skipped). Defaults 240 req/60 s per (IP, route), ban
   at 480 for 1 h. **Two counters, and the split is load-bearing:** admission
   is per `(IP, route)` so one busy route cannot spend another's budget, while
   escalation is per IP across every route — a single per-route counter let a
   caller rotate paths, keep each count below the threshold, and never be
   banned. Every attempt counts, including rejected and unauthenticated ones,
   so failing requests escalate rather than being exempt (atomic
   `checkAndIncrement`, so concurrent callers cannot race past the limit).
   Fail-closed 503 on store outage. Stores: `InMemoryIpAbuseStore` (per-key
   ring counters, 10 000-key bound, oldest-evicted) and `RedisIpAbuseStore`
   (ZSET sliding window trimmed to the ceiling, separate ban keys). This runs
   before credentials are resolved, so a throttled IP costs no key lookup.

   Mounted at the **root** through the `request` hook, not as a gateway plugin
   stage: a plugin (or root) `beforeHandle` only fires for a request that
   matches a registered route, so an unregistered `/v1/*` path or a real path
   with the wrong method skipped the counter entirely — the cheapest evasion
   available to a client that has decided to hammer the gateway. The hook
   resolves the client identity itself, from the same trusted-proxy boundary
   the identity middleware uses, because it runs ahead of that middleware.
3. `api-key-auth.ts: requestToken` + `resolveApiKeyAuthorization` — exactly one of
   `Authorization: Bearer` / `x-api-key`; both present is 400, neither or
   malformed is 401. The token is HMAC-hashed (`hashSecret`, same key as
   credential encryption) and looked up via
   `DrizzleApiKeyStore.findActiveByHash`; unknown/revoked returns `undefined`
   and the caller must 401 — never a default identity. The result is a frozen
   `ApiKeyAuthorizationSnapshot` (provider/model allow/deny lists, rpm,
   daily/monthly/lifetime budgets, `max_concurrent`, scopes) plus the
   authorization record's optional `model_prefix`. `isModelAllowed` uses
   dual-form bare/qualified matching with denylist-wins semantics;
   `isProviderAllowed` is a plain allowlist membership test (an absent or
   empty provider allowlist permits every provider). The public `/v1/models`
   catalog also applies `model_prefix` so discovery and dispatch expose the
   same policy.
4. `admission.ts: ApiKeyAdmissionService.admit()` — atomic pre-dispatch
   admission returning an idempotent `AdmissionLease`. Limits: sliding-60 s
   RPM, daily/monthly/lifetime token pre-credit with reconcile-to-actual on
   `commitUsage`, per-key + per-tenant concurrency held for the request
   duration, provider/model allowlist gating. Rejections map to stable codes:
   quota 429 (`quota_exhausted`), concurrency 429, tenant capacity 429
   (`tenant_capacity_exhausted`), allowlist 404, store outage 503
   (`admission_unavailable`, fail-closed). Stores:
   `InMemoryAdmissionCounterStore` (mutex-gated, 10 000 terminal-reservation
   ring) and `RedisAdmissionCounterStore` (RESERVE/RECONCILE/RELEASE Lua
   scripts over `admission:<kind>:*` keys with TTLs; `sweepLeases` +
   `releaseAdmissionLease` reap crashed leases; `purgeKey` on key revocation).
   `commitUsage` also persists reconciled lifetime consumption to Postgres via
   an injected persister (COALESCE increment), so budgets survive a Redis
   flush.

`csrf.ts: isCsrfValid` is not a data-plane layer: it guards unsafe
`/console/api/*` mutations only (session-cookie present: the readable
`csrf_token` cookie must timing-safe-equal the `x-csrf-token` header).
Stateless, no DB.

## Shared API-key enrollment

A share template is non-authenticating: the database shape constraint requires
its `key_hash` and `key_encrypted` to be null. A child has a hash, parent id,
and canonical issued-client-IP identity, but no recoverable secret. Public
enrollment resolves the client only through `resolveClientIdentity`; forwarded
headers are ignored unless the trusted-proxy boundary accepts them. The
database partial unique index enforces one active child per canonical IP
globally, so concurrent requests cannot issue duplicates. The plaintext child
secret is returned only by the successful issue response and is never returned
by owner summary or activity endpoints. Issued and request IPs are masked unless
the tenant explicitly enables full IP display; metadata endpoints do not expose
request or response payloads.

## Shared primitives

- `access-control.ts`: closed `AccessScope` (`routing:invoke`,
  `routing:cli_mapping` (opt-in use of persisted CLI source→target mappings),
  `dashboard:read`, `dashboard:write`, `platform:admin` — `platform:admin` is
  never assignable to tenant keys); `createAccessDecision` (frozen; empty
  tenant scopes default to `routing:invoke`; `tenantId: null` = cross-tenant
  operator).
- `crypto.ts`: AES-256-GCM (`iv12 || tag16 || ciphertext`, key from
  `CARTETHYIA_ENCRYPTION_KEY`, no fallback, cached after first decode) +
  `decryptCredentialToString` (used by the pool loader and credential service)
  + `hashSecret` (HMAC-SHA256 with the same key; API-key lookup). Postgres
  never sees plaintext.
- `outbound-headers.ts`: `API_CONTENT_SECURITY_POLICY` (deny-all for JSON/API),
  `X_FRAME_OPTIONS = "DENY"`, `GATEWAY_SECURITY_HEADERS` (the single list every
  `/v1` response spreads, so a hardening cannot reach one response path and
  miss the others), dashboard/inline-script CSP builders (hash-based,
  no `unsafe-inline` for scripts), `BASE_PROTECTED_HEADERS`
  (credential/transport/proxy-identity/gateway-identity + all `x-forwarded-*`;
  consumed by `filterProviderCustomHeaders` in protocol primitives),
  `HEADER_TOKEN`/`HEADER_CONTROL`, `isProtectedHeader`.

## Defaults and Redis keys

- 240 RPM/IP per 60 s window, ban at 480 for 1 h (`IP_RATE_MAX_PER_WINDOW`).
  The in-memory store's key ceiling (10 000) and per-key preallocation (64) are
  constructor-option defaults in `abuse.ts` with no env binding: they bound
  memory for a Redis-less deployment, not operator policy.
- Admission: 60 s RPM window; lease TTL 1 h; lifetime reconciled to Postgres.
- Redis keys: `admission:rpm|daily|monthly|lifetime|concurrent:<key>[:bucket]`,
  `admission:lease:<reservationId>`, `admission:tenant_concurrent:<tenant>`,
  `admission:inflight:<provider:model:account>`,
  `cartethyia:ip:<identity>:<route>`, `cartethyia:ip:ban-count:<identity>`,
  `cartethyia:ip:ban:<identity>`, `proxy:inflight:<poolId>`,
  `proxy:cooldown:<poolId>:<providerId>`, `proxy:cooldown:providers:<poolId>`.
  Every one carries a TTL. The per-IP admission step is a single static Lua
  script over its three keys, so an admitted `/v1` request costs one round trip
  and a banned one costs one; the two counters stay separate (admission per
  route for fairness, escalation per identity so rotating the path cannot dodge
  the ban). All scripted calls are static Lua (no dynamic eval) with
  finite-number result guards (`redisEvalNumber` / `redisEvalTuple`).

## How to extend

- New scope: extend `AccessScope` + `isValidTenantKeyScope`, thread through
  `requireTenantScope`/`requireScope` in `src/console/shared/errors.ts`.
- New protected header: add to `BASE_PROTECTED_HEADERS` — protocol custom
  headers, the compatibility-profile validator, and the Claude adapter pick it
  up automatically. Cross-origin redirect stripping uses its own
  `CREDENTIAL_HEADERS` list in `network/outbound-fetch.ts`, so a new name must
  be added there too if it must be stripped on redirect.
- New admission limit: extend `AdmissionReserveRequest` + both stores'
  reserve/reconcile/release paths + the Lua scripts + `reasonToGatewayError`
  mapping together; a limit enforced in only one store is a split-brain.
