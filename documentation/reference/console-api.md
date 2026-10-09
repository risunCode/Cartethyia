# Console API

`src/console/**` is the operator control plane: the HTTP API the React dashboard
talks to. Everything under `/console/api` exists so a browser can read and change
configuration — providers, models, keys, pools, routing, preferences — without
ever importing the backend. The dashboard calls `/console/api` through
`dashboard/src/data/api.ts` and defines no second copy of the wire.

It is not the data plane. `/v1/*` serves clients; `/console/api` serves the
operator who configures them. One Elysia process mounts both, but the console is
compressed on the way out (`src/console/response-compression.ts:216`) while `/v1/*`
is deliberately not, because a streaming completion must not be buffered.

## Anatomy of a domain

A domain is one folder under `src/console/`. The file roles are consistent:

| File | Owns |
|---|---|
| `contracts.ts` | Request/response types, the store interface, validation helpers, and the operations factory. Elysia-free on purpose — `src/console/routing/pools/contracts.ts:3` says so because the dashboard imports these types. |
| `routes.ts` | The only module that touches Elysia: path, body/query schema, `set.status`, and the catch. |
| `store.ts` | Drizzle. The row-to-view mapping lives here; a route never touches the driver. |
| `service.ts` | Behaviour too large for a store but not HTTP — `src/console/backup/service.ts`, `src/console/cli-tools/service.ts`. |

Not every domain has every file, and the split is not uniform. `settings`
declares its operations factory in `contracts.ts:75`; `providers/catalog` splits
operations into `provider-operations.ts` and `model-operations.ts`;
`routing/pools` keeps its operations in `operations.ts`. Follow the folder you are
editing rather than assuming a template.

Two conventions worth keeping because they prevent drift, not because they are
pretty:

- `literalUnion()` (`src/console/shared/elysia-schema.ts:17`) projects an
  Elysia literal union from the canonical tuple. Hand-writing the union at every
  route is how a new enum member reaches the validator but not the schema.
  `t.UnionEnum` is not a substitute — it stamps a default of the first member.
- `parseQueryLimit()` (`src/console/shared/query.ts:16`) is the only `?limit=`
  parser. A non-numeric value is a caller error (400 `invalid_limit`), never a
  silent fallback to the default.

## How a domain is wired

`createConsoleRouter()` (`src/console/console-router.ts:96`) builds the Elysia
instance with `prefix: "/console/api"` (`console-router.ts:129`), installs the
guards and the session resolver, mounts the auth routes itself, then hands the
instance to `registerConsoleDomains()` (`src/console/domain-registration.ts:110`).

`domain-registration.ts` is the single composition root for everything else. It
constructs the concrete Drizzle stores and calls one `console.use(createXRoutes({...}))`
per domain. A new domain is not wired by editing `console-router.ts`; it is wired
by adding one `use()` there with the dependencies the domain's config interface
declares. `ConsoleDomainContext` (`domain-registration.ts:69`) is what the function
receives — the database, the access resolver, the registry, the snapshot
invalidator, the pool selector, and so on.

Dependencies are injected, not imported. `LiveConfig` in
`src/console/observability/live.ts:15` declares its own
`LiveInFlightSource` interface rather than importing from `transport/`, because
the console must not depend on the transport layer. Same reason
`ConsoleApiCompositionDeps.routeSnapshotService` is a structural
`{ invalidate(): Promise<number> }` (`console-router.ts:48`).

## Boundaries

Four boundaries apply before any domain code runs. None of them is optional.

**Session and tenant.** A `beforeHandle` (`console-router.ts:132`) resolves the
session cookie to an `AccessDecision` and caches it per `Request` in a `WeakMap`
scoped to the composition. `/console/api/auth/*` is skipped because the auth
routes resolve their own session. Every domain then calls one of
`requireScope`, `requireAnyScope`, `requireTenantScope`, `requireTenantAnyScope`,
or `requireGlobalAdmin` from `src/console/shared/errors.ts:78-139`.
`requireTenantScope` is the common case: it rejects a `null` tenant id with 403
`tenant_required`, so a platform-admin session cannot accidentally write as a
tenant.

Scopes are not a ladder. A console session holds `dashboard:read`,
`providers:read`, `models:read` and — for a platform admin — the write scopes
plus `platform:admin` (`src/security/access-control.ts:52`). A regular console
user is read-only. `dashboard:write` deliberately does not imply
`providers:write`, because a tenant API key can hold `dashboard:write` and must
not thereby add an upstream.

**API-key access.** With no session cookie, a `Bearer` token is resolved through
`resolveApiKeyAuthorization` — the same path `/v1` uses (`console-router.ts:149-161`).
That is what lets a key register a BYOK provider or read its own telemetry for
remote debugging without a browser. A request with no credential stays
unauthenticated and the route rejects it; nothing falls back to an implicit identity.

**CSRF.** `createConsoleCsrfMiddleware()` (`src/console/console-router-guards.ts:21`)
is stateless double-submit: `x-csrf-token` header against the readable
`csrf_token` cookie, no database I/O. It applies to unsafe methods under
`/console/api/` when a session cookie is present. Four paths are exempt —
`/auth/login`, `/auth/setup`, `/auth/setup/restore`, `/auth/session` — because a
login has no session yet to forge.

**Mutation throttle.** `createConsoleMutationLimiterMiddleware()`
(`console-router-guards.ts:77`) allows 240 unsafe requests per 10-second sliding
window per session, keyed by the SHA-256 of the session cookie. It exists to bound
what a stolen cookie can do at full request rate; the limit sits well above
legitimate bulk operations (a bulk model delete fires one DELETE per model).
Over-limit requests get 429 `quota_exceeded` with a measured `retry-after`.

**Re-authentication.** Backup export, restore, and delete-all require the
operator's password in the body or query, not merely a session
(`src/console/backup/routes.ts:1-13`). An export is the whole configuration in the
clear; a stolen cookie should not be enough to walk away with it. The service is
built per request (`backup/routes.ts:34`) so one request's identity cannot leak
into the next.

## Feature inventory

| Area | Surface | Notes |
|---|---|---|
| `auth/` | `/console/api/auth/*` | Login with lockout, first-boot setup and setup-restore, session, logout |
| `providers/catalog`, `providers/detail` | `/console/api/providers/*` | Catalog CRUD, models, accounts, per-provider routing; `/connection-test` is declared before `/:providerId` so it is never captured as an id |
| `providers/oauth` | `/console/api/providers/:id/oauth/*` | Device/authorization flows; `OAuthCallbackListener` binds loopback so the redirect delivers itself |
| `routing/model` | `/console/api/routing/aliases|combos` | Aliases and combos, plus reorder and clone |
| `routing/pools` | `/console/api/network/pools/*` | Egress pools, health checks, speed tests, batch probe, cooldown clearing, strategy, hosted-relay deploy |
| `api-keys/` | `/console/api/api-keys/*` | Keys, share links, share popups, per-key spend |
| `share/` | `/share/:token/*` | Public enrollment, mounted separately by `createShareRouter` (`src/boot/app.ts:531`), not under `/console/api` |
| `cli-tools/` | `/console/api/cli-tools/*` | Per-tool status, per-(tenant, tool, key) slot mappings, download, apply |
| `settings/` | `/console/api/settings/runtime` | Per-tenant preferences: telemetry payloads, privacy mode, RTK prune, PonyTail |
| `backup/` | `/console/api/backup/*` | Export, import, delete-all. `nine-router.ts` converts a foreign router export, never guessing a provider id |
| `studio/` | `/console/api/studio/*` | Model lab sessions, bounded to 50 per tenant with oldest-first eviction |
| `quota/` | `/console/api/quota/*`, `/accounts/*`, `/global/accounts/*` | Quota windows, refresh, check-in, resets; tenant routes and platform-admin routes are separate modules onto one instance |
| `observability/` | `/console/api/system/*`, `/telemetry/*`, `/logs/*`, `/live/*` | File-log reads, log ring SSE, live in-flight gauge, pool health streams |
| `audit/` | `/console/api/audit` | Cursor-paginated `admin_audit_log` read, `platform:admin` only |
| `admin/model-abuse` | `/console/api/model-bans` | Lift a model-abuse ban early; mounted only when `ctx.modelStrikes` exists (`domain-registration.ts:231`) |

That table is the index. Four areas carry their own feature page — data,
ownership, the routes behind the row, and where to change what:

[CLI model mapping](../features/cli-model-mapping.md) ·
[Share keys](../features/share-keys.md) ·
[Network pools](../features/network-pools.md) ·
[Routing aliases and combos](../features/routing-aliases-combos.md)

## Route snapshot

A console write that changes where traffic goes must invalidate the route
snapshot, or the data plane keeps dispatching the old catalog until some
unrelated write happens to invalidate. Domains that do this: provider catalog
model operations (`providers/catalog/model-operations.ts:135` and neighbours),
routing, pools, CLI tools (mapping saves and remote routes), and backup restore.

## Where to change what

| Change | Start here |
|---|---|
| New console endpoint | The domain's `contracts.ts` (types + operations), then `routes.ts` |
| New domain | `src/console/<domain>/`, then one `console.use()` in `domain-registration.ts` |
| New response field | The domain contract, then `dashboard/src/data/contracts.ts`, then the hook |
| New access rule | `src/console/shared/errors.ts` guards; do not hand-roll a check in a route |
| New list endpoint | `parseQueryLimit`, then the store query |
| Egress/SSRF behaviour | `src/console/routing/pools/contracts.ts:344` `validateEndpoint` |
| Error envelope | `src/console/shared/errors.ts` `errorResponse` |
| Compression, CSRF, throttle | `console-router-guards.ts`, `response-compression.ts` |
| Dashboard mirror of a payload | `dashboard/src/data/contracts.ts` — never a second hand-written type |
