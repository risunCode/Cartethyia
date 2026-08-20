# Cartethyia Proxy Router — Cleanup, Cutoff, and Dashboard Wiring Roadmap

Status: implemented in code for the current cutover, with a small amount of historical documentation still pending refresh.

This document supersedes the earlier restructure notes for the current phase. It is the review artifact for the **proxy router cleanup**, **dashboard backend cutoff**, and **dashboard wiring** workstream.

## 0) Scope

What this phase covers:

- cut off the dashboard's separate Bun backend;
- wire browser error reporting directly into the Go daemon;
- keep the dashboard as a pure SPA / control plane;
- preserve console route parity and method discipline;
- keep ownership boundaries explicit;
- keep the root tree small and boring.

Reference repositories used only as behavior references:

- `Public/Cartethyia-107` — legacy Cartethyia behavior source;
- `Public/etteum-pool` — router / pool / batch behavior source.

Neither reference repository is a runtime dependency.

---

## 1) Executive summary

The product is still a **proxy router**.

The dashboard is **not** a second backend anymore.
The browser error sink moved into the Go console contract.
The dashboard now reports client errors with a single POST into the daemon:

- `POST /console/client-errors`

That route is handled by Go, stored in the console log pipeline, and displayed back through the existing console log views.

The main structural cut happened in three places:

1. **Dashboard backend removed** — no `src/server/`, no `bun run server`, no SQLite sink, no dashboard audit service.
2. **Console ingest wired into Go** — browser errors now land in the daemon console logs.
3. **Route parity tightened** — console route registration and dashboard contract tests are explicit again.

---

## 2) Before vs after

### 2.1 Before

```text
root/
├─ dashboard/
│  ├─ src/server/
│  │  ├─ index.ts          # Bun aux server
│  │  └─ routes.ts         # /internal/health + /internal/logs
│  ├─ src/lib/sqlite.ts    # local browser-error sink
│  ├─ migrations/          # dashboard-owned DB schema
│  └─ package.json         # `server` script
├─ deploy/docker/
│  ├─ Dockerfile           # dashboard-audit target
│  ├─ compose.yaml         # dashboard-audit service
│  └─ nginx.conf           # /internal proxy to dashboard-audit
└─ router/
   └─ internal/console/
      └─ logs route only; browser errors still external
```

### 2.2 After

```text
root/
├─ dashboard/
│  ├─ src/lib/error-reporter.ts   # browser -> daemon console ingest
│  ├─ src/lib/log-types.ts        # source fallback now includes scope/origin
│  ├─ src/lib/console-routes.ts   # explicit console route matrix
│  └─ package.json                # SPA-only
├─ router/
│  └─ internal/console/
│     ├─ api/console.go           # /console/client-errors
│     ├─ api/batches.go           # explicit collection methods
│     └─ services/admin_console_logs.go
│         # writer-backed browser error insert into console logs
├─ deploy/docker/
│  ├─ Dockerfile                  # runtime + dashboard only
│  ├─ compose.yaml                # no dashboard-audit service
│  └─ nginx.conf                  # no /internal proxy
└─ PROXY_ROUTER_CLEANUP_CUTOFF_WIRING_ROADMAP.md
```

### 2.3 What was merged / cut off

| Item | Before | After | Decision |
|---|---|---|---|
| Browser error sink | dashboard Bun backend + SQLite | Go console ingest route | Merged into daemon |
| Dashboard server | separate runtime | removed | Cut off |
| Dashboard SQLite | local sink file | removed | Cut off |
| Dashboard migrations | dashboard-owned schema | removed | Cut off |
| `/internal/*` dashboard proxy | Vite + nginx | removed | Cut off |
| Console logs display | `source`-only normalization | `source -> scope -> origin` fallback | Wired so browser errors render correctly |
| Batch route registration | implicit/methodless collection registration | explicit HTTP methods on collection route | Tightened parity |

---

## 3) Ownership map

### 3.1 Top-level ownership

| Area | Owner | Sub-owning / scope boundary | Notes |
|---|---|---|---|
| `router/internal/console/api/` | Go console API | route registration, auth scoping, contract parity | Owns HTTP surfaces |
| `router/internal/console/services/` | Go console services | persistence, log ingestion, sink behavior | Owns the console log writer path |
| `router/internal/router/` | Router engine | hot path request routing / failover | Not touched by this cutoff |
| `dashboard/src/lib/` | Dashboard transport + helpers | error reporter, route matrix, log normalization | Frontend-only helpers |
| `dashboard/src/pages/` | Dashboard UI | page rendering and operator workflow | No server ownership |
| `deploy/docker/` | Deployment packaging | image targets, compose topology, nginx proxying | Only runtime packaging |
| root `*.md` | Review / roadmap docs | analysis and current-state notes | No runtime code |

### 3.2 Sub-owning clarity

The important ownership split now is:

- **Go owns truth**: console ingest, persistence, contract validation, scope enforcement.
- **Dashboard owns presentation**: the SPA, fetch helpers, and client-side sanitization.
- **Dashboard no longer owns runtime storage**: no SQLite file, no PostgreSQL health probe, no Bun backend.

That removes the old ambiguity where the dashboard looked like a second authority.

---

## 4) Wiring to the dashboard

### 4.1 Error flow

```text
window.onerror / unhandledrejection
        ↓
reportError(level, message, context)
        ↓
redact + sanitize payload
        ↓
POST /console/client-errors
        ↓
router/internal/console/api/console.go
        ↓
ConsoleLogService.Insert(...)
        ↓
console_logs persistence
        ↓
GET /console/logs or /console/logs/stream
        ↓
dashboard log normalizer
        ↓
operator sees browser errors in the console UI
```

### 4.2 Files that now carry the wiring

| File | Role |
|---|---|
| `dashboard/src/main.tsx` | browser error hooks (`error`, `unhandledrejection`) |
| `dashboard/src/lib/error-reporter.ts` | fire-and-forget POST to `/console/client-errors` |
| `dashboard/src/lib/api.ts` | message sanitization helper |
| `dashboard/src/lib/console-api.ts` | secret redaction helper |
| `dashboard/src/lib/log-level.ts` | shared level enum for browser reporting |
| `dashboard/src/lib/log-types.ts` | log normalization fallback for `source`, `scope`, `origin` |
| `router/internal/console/api/console.go` | ingest route handler |
| `router/internal/console/services/admin_console_logs.go` | writer-backed insert and message composition |
| `router/internal/console/contracts/types.go` | `ClientErrorInput` contract |
| `contracts/openapi/console.yaml` | documented request body and route |

### 4.3 Why the log normalizer changed

The dashboard log UI historically assumed a `source` field.
The Go console log entries use `scope` / `origin` fields.
Browser errors are now inserted with `scope=browser`.

So `dashboard/src/lib/log-types.ts` now normalizes:

- `source` first,
- then `scope`,
- then `origin`,
- then falls back to `system`.

That makes the new browser error rows visible in the same log widgets without inventing a second log pipeline.

---

## 5) Cutoff decisions

### 5.1 Explicit cuts

| Cutoff | Result | Why |
|---|---|---|
| `dashboard/src/server/` | deleted | the separate dashboard backend is gone |
| `dashboard/src/lib/sqlite.ts` | deleted | the local browser error sink is gone |
| `dashboard/migrations/` | deleted | dashboard no longer owns runtime DB schema |
| `dashboard-audit` Docker/compose target | deleted | no second backend authority |
| `/internal` nginx proxy | deleted | no upstream to proxy anymore |
| `bun run server` script | deleted | no server entrypoint remains |

### 5.2 Kept intentionally

| Kept | Why it still exists |
|---|---|
| `dashboard/src/lib/postgres.ts` | migration utility / test support still uses the connection handle type |
| `dashboard/src/lib/migrations.ts` | generic migration helper and test fixture logic |
| `router/internal/console/api/batches.go` | batch API is still a Go console responsibility |
| `dashboard/src/lib/console-routes.ts` | browser route contract stays explicit |
| `dashboard/test/lib/transport-contract.test.ts` | keeps the route contract honest |

### 5.3 Merge policy used here

- browser error reporting was **merged upward** into the Go daemon;
- storage concerns were **cut off** from the dashboard;
- route contracts stayed **explicit** instead of implicit;
- no new runtime abstraction was introduced just to hide the cutover.

---

## 6) Utility / helper map

| Helper | File | Responsibility |
|---|---|---|
| `reportError()` | `dashboard/src/lib/error-reporter.ts` | sanitize + redact + send browser errors |
| `sanitizeErrorMessage()` | `dashboard/src/lib/api.ts` | bounded human message cleanup |
| `redactOperatorValue()` | `dashboard/src/lib/console-api.ts` | remove secret-shaped fields from context |
| `normalizeLogEntry()` | `dashboard/src/lib/log-types.ts` | normalize historical and live log payloads |
| `requireMethods()` | `router/internal/console/api/middleware.go` | explicit method table for literal routes |
| `clientErrorMessage()` | `router/internal/console/services/admin_console_logs.go` | compose bounded server-side browser error text |
| `ConsoleLogService.Insert()` | `router/internal/console/api/services.go` | write console/browser errors through the log pipeline |

### 6.1 Notes on helper boundaries

- `reportError()` must never throw into the app shell.
- `sanitizeErrorMessage()` keeps accidental garbage and secrets out of the browser payload.
- `redactOperatorValue()` keeps the context payload operator-safe before it leaves the client.
- `clientErrorMessage()` keeps the persisted server row bounded and readable.

---

## 7) Route / contract cleanup

### 7.1 New route

| Route | Method | Purpose | Scope |
|---|---|---|---|
| `/console/client-errors` | `POST` | browser/client error ingest | `usage` |

### 7.2 Route parity fixes

| Fix | Why it mattered |
|---|---|
| explicit `POST /console/client-errors` in Go | browser reporter now has a real sink |
| `ConsoleRouteInventory` + OpenAPI parity | contract drift is visible immediately |
| `dashboard/test/lib/transport-contract.test.ts` updated | the dashboard contract knows about the new route and the batch dispatcher gap |
| `router/internal/console/api/batches.go` now uses `requireMethods` | literal `/console/batches` registration is no longer methodless |
| `DISPATCHER_SUBROUTES` now includes `/console/batches/` | dispatcher expansion stays honest |
| `KNOWN_UNCOVERED_DAEMON_ROUTES` now includes batch pairs | intentional non-dashboard routes stay declared, not accidental |

### 7.3 Batch route note

The batch API is still a Go console responsibility.
It is not dashboard-owned.
The dashboard contract test now knows about the dispatcher shape so the daemon route map stays honest even though the SPA does not directly use those routes.

---

## 8) Reference repository mapping

### 8.1 `Public/Cartethyia-107`

Used as behavior reference for:

- earlier Cartethyia structure and control-plane intent;
- legacy dashboard/backend split;
- compatibility expectations around console surfaces.

Not used as runtime code.

### 8.2 `Public/etteum-pool`

Used as behavior reference for:

- pool / batch / routing behavior;
- the style of separation between control-plane helpers and hot-path execution;
- boundary discipline around dispatcher-style routes.

Not used as runtime code.

### 8.3 What not to carry forward

Do not reintroduce:

- dashboard-owned runtime DBs;
- dashboard-owned local log sinks;
- a second backend server just for browser error reporting;
- implicit HTTP method handling when a route can declare its methods explicitly.

---

## 9) Current size / percentage view

These percentages are engineering estimates for the cleanup/cutoff workstream, not test coverage.

| Domain | Before | After | Estimate |
|---|---:|---:|---:|
| Dashboard backend removal | 0% | 100% | 100% |
| Browser error wiring to daemon | 0% | 100% | 100% |
| Console contract parity | 80% | 100% | 100% |
| Batch route explicitness | 60% | 100% | 100% |
| Docker / compose cleanup | 40% | 100% | 100% |
| Root runtime tree simplification | 35% | 85% | 85% |
| Historical docs refresh | 30% | 70% | 70% |
| Overall cleanup / cutoff / wiring | 45% | 88% | 88% |

### 9.1 Why docs are not 100%

A few historical artifacts still mention the removed dashboard backend conceptually:

- older restructure reports;
- generated visualization docs;
- legacy roadmap notes.

Those are historical references, not runtime dependencies, but they should be refreshed if you want the repo documentation fully aligned.

---

## 10) Verification performed

The following checks passed after the cleanup:

| Command | Result |
|---|---|
| `go test ./internal/console/...` | passed |
| `bunx vitest run test/lib/error-reporter.test.ts test/lib/transport-contract.test.ts` | passed |
| `bunx tsc --noEmit` | passed |
| `bun run build` | passed |

### 10.1 What those checks proved

- the Go console API still builds and its contract tests pass;
- the dashboard error reporter now posts to the daemon route;
- the dashboard route contract still matches the daemon route inventory;
- the dashboard SPA bundle still builds after removing the backend files.

---

## 11) Remaining roadmap

If you want the next cleanup pass, do it in this order:

1. **Refresh historical docs**
   - update the older restructure report;
   - update any generated visualization docs that still mention `src/server` or `dashboard-audit`.

2. **Decide whether to create one extra root folder for artifacts**
   - if you want generated audits separated from runtime code, add exactly one folder, e.g. `reports/`;
   - keep it documentation-only;
   - do not add more root folders unless they own real runtime boundaries.

3. **Wire dashboard batch UI only if needed**
   - the daemon batch routes are now explicit and contract-safe;
   - the SPA does not currently claim them, which is fine until the product needs them.

4. **Keep ownership boundaries boring**
   - Go owns ingest / persistence / authorization;
   - dashboard owns rendering / transport helpers;
   - deployment owns packaging only.

---

## 12) Bottom line

The cleanup goal for this phase is met:

- the dashboard is now a pure SPA;
- browser errors go straight into the Go console log path;
- route parity is explicit again;
- the separate dashboard backend is gone;
- the root tree is smaller and easier to reason about.

The remaining work is documentation refresh and any optional root-folder reshaping you still want for generated artifacts.
