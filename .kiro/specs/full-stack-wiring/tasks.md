# Implementation Plan

Task groups 1–4 map 1:1 to the design's four workstreams and touch disjoint
files — dispatch them as one parallel subagent batch. Task group 5 is the
final validation pass, run by the orchestrating agent after the batch
returns, not delegated.

**Status: all tasks complete, re-verified against the actual delivered code
(not just agent self-reports) before checking anything off. Two intentional
deviations from the literal task text below, both justified:**
- 1.1: `handleHealth` does NOT call `migrations.status(...)` as originally
  drafted — doing so would make the unit test read the real
  `dashboard/migrations/` directory from disk (via `discoverMigrations`),
  coupling a "pure fakes, no real I/O" unit test to unrelated repo state.
  No acceptance criterion in `requirements.md` (1.1/1.3/1.6) actually
  requires migration status in the health response — cross-checked.
- 1.3: `runMigrations(pool)` is called with no `directory` override, not
  `{ directory: "dashboard/migrations" }` as drafted — that literal string
  is cwd-relative and would resolve to `dashboard/dashboard/migrations`
  (wrong) when run via `npm run server` from `dashboard/`. Omitting it lets
  `migrations.ts`'s own default (derived from `import.meta.url`) resolve
  correctly instead.

- [x] 1. Bun auxiliary backend — routes and entrypoint
  - [x] 1.1 Define route handler interfaces with injected dependencies
    - In `dashboard/src/server/routes.ts`, write `handleHealth(pg: PgPoolHandle, sqlite: SqliteLogHandle): Promise<Response>`, `handleLogInsert(sqlite: SqliteLogHandle, body: unknown): Promise<Response>`, `handleLogRead(sqlite: SqliteLogHandle, url: URL): Promise<Response>` as pure functions taking their dependencies as parameters (not reading module-level singletons) — this is what makes them unit-testable without a real Postgres/SQLite process.
    - `handleLogInsert` validates the body is a `LogInsert` shape (`level` must satisfy `isLogLevel` from `lib/sqlite.ts`, `message` must be a non-empty string) and returns `400` with a clear message on invalid input before calling `insertLog`.
    - `handleHealth` calls `pg.query("SELECT 1")` and reports `"error"` on rejection rather than throwing; calls `sqlite.stats()`. (`migrations.status(...)` intentionally omitted — see note above.)
    - _Requirements: 1.1, 1.3, 1.6_
  - [x] 1.2 Write unit tests for the route handlers using fake pool/sqlite handles
    - In `dashboard/test/server/routes.test.ts`, build minimal in-memory fakes implementing `PgPoolHandle` and `SqliteLogHandle` (from `lib/postgres.ts`/`lib/sqlite.ts`) — no real database needed.
    - Cover: health reports `"ok"` when the fake pool resolves, `"error"` when it rejects; log insert accepts a valid payload and rejects an invalid `level`; log read returns rows and respects the `limit`/`level` query params.
    - _Requirements: 1.3, 1.4, 1.6_
  - [x] 1.3 Wire the Bun entrypoint
    - In `dashboard/src/server/index.ts`, read `CARTETHYIA_DASHBOARD_SERVER_PORT` (default `8787`), `CARTETHYIA_DASHBOARD_DATABASE_URL`, `CARTETHYIA_DASHBOARD_SQLITE_PATH` (default `data/logs.db`) from `process.env`.
    - Call `getPgPool(...)`, then `runMigrations(pool)` (default directory — see note above) — on rejection, log the error and `process.exit(1)` before `Bun.serve` starts (Requirement 1.2: no serving on a half-applied schema).
    - Call `getSqliteLogPool(...)`, then start `Bun.serve({ port, fetch })` dispatching to the three routes from 1.1 plus a 404 fallback.
    - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - [x] 1.4 Add the `server` script to `dashboard/package.json`
    - `"server": "bun run src/server/index.ts"`.
    - _Requirements: 1.5_

- [x] 2. Frontend error reporter
  - [x] 2.1 Implement `reportError` with a test
    - Create `dashboard/src/lib/error-reporter.ts` exporting `reportError(level: LogLevel, message: string, context?: Record<string, unknown>): void` — fire-and-forget `fetch("/internal/logs", ...)`, `.catch(() => undefined)`, never throws.
    - Test in `dashboard/test/lib/error-reporter.test.ts`: mock `global.fetch`, assert the request shape (method, path, JSON body); assert a rejected fetch does not throw out of `reportError`.
    - _Requirements: 1.4_
  - [x] 2.2 Wire global error listeners in `main.tsx`
    - Add `window.addEventListener("error", ...)` and `("unhandledrejection", ...)` calling `reportError("error", ...)` with the caught message/reason.
    - _Requirements: 1.4_

- [x] 3. Dashboard nginx Docker wiring
  - [x] 3.1 Write `docker/nginx.conf`
    - `location /console/api/` proxying to `http://cartethyia:12800/` (prefix-stripped, mirroring `vite.config.ts`'s rewrite), `location /v1/` and `location /v2/` proxying with the prefix kept (mirroring the vite proxy's passthrough), `location /internal/` proxying to `http://dashboard-audit:8787/internal/` using `resolver 127.0.0.11 valid=10s;` + a `set $upstream ...;` variable so nginx starts even if that service doesn't exist, `location /` doing `try_files $uri $uri/ /index.html;`.
    - Post-implementation fix (caught in final review, not by the drafting agent): a bare `set $var ...; proxy_pass $var;` disables nginx's automatic prefix-stripping entirely — every location now uses an explicit `rewrite ... break;` (for `/console/api/` only) plus `proxy_pass $upstream$uri$is_args$args;` so the forwarded path is always intentional. `/v2/` also got `proxy_buffering off;` + `proxy_http_version 1.1;` for the SSE console-log/telemetry streams, which the original draft didn't account for.
    - _Requirements: 2.1, 2.2_
  - [x] 3.2 Wire the config into the `dashboard` build stage
    - In `Dockerfile`, add `COPY docker/nginx.conf /etc/nginx/conf.d/default.conf` to the `dashboard` stage, after the existing `COPY --from=dashboard-build` line. No other stage changes.
    - _Requirements: 2.4_
  - [x] 3.3 Add the `dashboard` service to `docker-compose.yml`
    - New service building `target: dashboard`, `ports: ["8080:80"]`, `depends_on: cartethyia: condition: service_healthy`. Leave `postgres`, `redis`, `cartethyia` services untouched.
    - _Requirements: 2.3, 2.5_

- [x] 4. Daemon coverage hardening — `internal/database`
  - [x] 4.1 Identify coverage gaps
    - Run `go test -coverprofile=cov-database.out ./internal/database/...` then `go tool cover -func=cov-database.out | sort -k3 -n` to list the lowest-covered functions; note file:line for each candidate before writing any test.
    - _Requirements: 3.1_
  - [x] 4.2 Write additive tests closing the identified gaps
    - Add `_test.go` cases in the same package/file convention already used (table-driven, `httptest` where applicable). Zero production-code edits unless a genuine bug is found — if one is, fix it in a separate, clearly-labeled change and note it explicitly rather than folding it into the coverage commit.
    - Re-run the coverage command from 4.1 and confirm the percentage rose from the 41.2% baseline. Result: 74.0% (re-verified independently, not just trusting the agent report).
    - _Requirements: 3.1, 3.3, 3.4_

- [x] 5. Daemon coverage hardening — `internal/providers` (root package only)
  - [x] 5.1 Identify coverage gaps
    - Run `go test -coverprofile=cov-providers.out ./internal/providers` (root package, not `./internal/providers/...` — the subpackages `adapters`/`apikey`/`builtin`/`oauth`/`policies` are already 65–100% and out of scope) then rank lowest-covered functions the same way as 4.1.
    - _Requirements: 3.2_
  - [x] 5.2 Write additive tests closing the identified gaps
    - Same constraints as 4.2: additive tests only, existing conventions, isolated bug fixes called out separately.
    - Re-run the coverage command from 5.1 and confirm the percentage rose from the 34.0% baseline. Result: 61.0-61.1% (re-verified independently).
    - _Requirements: 3.2, 3.3, 3.4_

- [x] 6. Full-stack validation harness script
  - [x] 6.1 Define the check result type and reporting shell
    - Create `scripts/validate-fullstack.ts` with `interface ValidationCheck { readonly name: string; readonly passed: boolean; readonly detail?: string; }`, a `checks: ValidationCheck[]` accumulator, and a final print routine that lists every check with PASS/FAIL and exits `1` if any failed (Requirement 4.6 — no rounding up).
    - _Requirements: 4.5, 4.6_
  - [x] 6.2 Implement the compose bring-up step
    - Shell out to `docker compose up -d postgres redis cartethyia dashboard --wait`; on non-zero exit, record one failed `ValidationCheck` and stop (nothing else can be checked without the stack up) rather than crashing uncaught.
    - _Requirements: 4.1_
  - [x] 6.3 Implement the Tier A HTTP/SSE checks
    - `GET http://localhost:8080/` → `200` + body contains `<title>Cartethyia`.
    - `POST http://localhost:8080/console/api/auth/login` with the compose `CONSOLE_PASSWORD` → `200` + session cookie captured for subsequent requests.
    - `GET` each of `/console/api/dashboard`, `/console/api/telemetry/usage`, `/console/api/telemetry/providers` with that cookie → `200` + parses as JSON.
    - Open the console-log SSE endpoint and wait up to 10s for at least one `data:` frame or keep-alive comment; time out counts as failed, not hung indefinitely.
    - Each check appends its own `ValidationCheck`; one failing does not stop the remaining checks from running.
    - Verified by full read of the finished file (not a spot-check): every listed check exists, argument shapes match, SSE reader uses `AbortController` with a 10s timeout, none of the checks can hang indefinitely. NOT executed against a live stack — no `docker` binary in this sandbox (see 7.2).
    - _Requirements: 4.2, 4.3, 4.4_

- [x] 7. Final validation pass (orchestrating agent, not delegated)
  - [x] 7.1 Run everything that doesn't require Docker
    - `dashboard`: `npm run test:ci` (vitest + `tsc --noEmit` + `vite build`) — must stay green including the new `server/`, `error-reporter.ts`, and their tests.
    - `daemon`: `go test -cover ./...` — confirm `internal/database` and `internal/providers` coverage rose from the 41.2%/34.0% baseline and every other package still passes with no regression.
    - Static review of `docker/nginx.conf`, the `Dockerfile` diff, and the `docker-compose.yml` diff for syntax correctness and consistency with the existing `vite.config.ts` proxy semantics.
    - Also ran a stricter `-count=1` (no-cache) full suite, which surfaced one pre-existing flaky test (`TestRefresherRenewsLeaseDuringLongRefresh`, unrelated to any coverage-hardening batch — timing margins too tight for scheduler jitter). Fixed as a separate, explicitly-flagged test-only change; re-verified 10x back-to-back plus two more full `-count=1` runs, all green.
    - _Requirements: 1.1–1.7, 2.1–2.5, 3.1–3.4_
  - [x] 7.2 Report Docker-dependent scope honestly
    - State explicitly that `scripts/validate-fullstack.ts` and any Tier B browser-driven page checks were written/reviewed but not executed against a live `docker compose` stack in this sandbox (no `docker` binary available) — no claim of full end-to-end proof beyond what was actually run.
    - Reported in every relevant turn of this session, not just here.
    - _Requirements: 4.1–4.6_
