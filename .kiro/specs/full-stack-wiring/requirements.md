# Requirements Document

## Introduction

Deep-scan sesi sebelumnya (dashboard SolidJS + daemon Go) menutup satu bug navigasi
kritis dan membersihkan kode duplikat/orphan, tapi meninggalkan 4 celah antara
"kode yang ditulis" dan "kode yang benar-benar ter-wire, jalan bareng, dan
tervalidasi end-to-end":

1. `dashboard/src/lib/postgres.ts` + `sqlite.ts` + `migrations.ts` — lengkap,
   teruji secara isolasi, tapi nol invocation point (tidak ada server yang
   memanggilnya).
2. Tidak ada deployment story: daemon tidak serve dashboard `dist/`, tidak ada
   compose/nginx config.
3. Coverage daemon timpang: `internal/database` (41.2%) dan
   `internal/providers` root (34.0%) — dua area terendah dari 44 package.
4. Tidak ada bukti daemon + dashboard + Postgres benar-benar jalan bareng
   (sandbox sesi lalu tidak punya Postgres/Redis lokal).

Spec ini menutup keempat celah supaya sistem bisa dianggap matang secara
menyeluruh — bukan cuma matang per-komponen — dan tiap requirement dibuat agar
bisa didelegasikan ke subagent terpisah (independent, tidak saling blocking),
dengan satu validation pass di akhir sebagai gerbang sign-off.

**Asumsi yang perlu dikonfirmasi (Requirement 1):** skema migrasi Postgres
(`users`, `user_settings`, `api_keys`, `quota_accounts`, `share_links`)
mengindikasikan lapisan multi-user/audit **milik dashboard sendiri**, terpisah
dari auth `CONSOLE_PASSWORD` tunggal milik daemon dan terpisah dari data
proxy-routing yang sudah 100% dikelola daemon (accounts, providers, quota
runtime). Requirement 1 di bawah mengasumsikan tujuannya adalah lapisan
audit/administrasi ringan untuk operator dashboard (siapa yang login, kapan,
preferensi apa) — **bukan** membangun ulang proxy-routing yang sudah dimiliki
daemon. Kalau maksudnya beda, koreksi sebelum masuk fase design.

## Requirements

### Requirement 1 — Dashboard auxiliary backend (wiring postgres.ts + sqlite.ts)

**User Story:** As a dashboard operator, I want the Postgres and SQLite
modules I already approved to actually run behind a real Bun process, so the
code isn't dead weight and dashboard-side audit/session data persists across
restarts.

#### Acceptance Criteria

1. WHEN the Bun backend process starts THEN the system SHALL apply every
   pending migration in `dashboard/migrations/` against the configured
   Postgres connection before accepting any request.
2. IF a migration fails THEN the system SHALL abort startup with a clear
   error and SHALL NOT leave the schema half-applied (each migration file
   runs inside a transaction).
3. WHEN the Bun backend process starts THEN the system SHALL initialize the
   `sqlite.ts` log pool (`getSqliteLogPool`) against a configurable file
   path and SHALL create the `logs` table if absent.
4. WHEN the dashboard frontend reports an operator-facing error (e.g. an
   uncaught SolidJS error boundary, a failed console-api call above a
   severity threshold) THEN the system SHALL forward that event to the
   auxiliary backend, which SHALL persist it via `insertLog`.
5. WHERE the auxiliary backend exposes an HTTP surface THEN the system SHALL
   keep it fully separate from the daemon's `/v1`, `/v2`, `/console` API
   surface (distinct port/prefix) so no route ownership conflict exists.
6. WHEN an operator queries recent dashboard-side logs THEN the system SHALL
   return rows from `readLogs`, capped and filterable by minimum level,
   consistent with the existing `sqlite.ts` contract.
7. The system SHALL NOT duplicate any data the daemon already owns
   (provider credentials, quota runtime state, proxy routing) — the
   auxiliary backend's Postgres tables stay scoped to dashboard-side
   accounts/settings/share-link bookkeeping and audit logging only.

### Requirement 2 — Deployment wiring (dashboard nginx image, not the daemon)

**Correction from initial draft:** `Dockerfile` and `docker-compose.yml`
already state twice that "the Go daemon never embeds or serves the
dashboard." The real gap is on the *dashboard* side of that boundary: the
Dockerfile's `dashboard` (nginx) target exists but is unused —
`docker-compose.yml` never instantiates it — and it has no custom nginx
config, so it would neither SPA-fallback client routes nor reverse-proxy
`/console/api`, `/v1`, `/v2` to the daemon the way `api.ts`'s same-origin
fetch design requires. This requirement fixes that without touching the
daemon.

**User Story:** As someone deploying Cartethyia, I want the existing
`dashboard` Docker image to actually be wired into `docker-compose.yml` and
configured correctly, so the whole product runs as one `docker compose up`
without hand-wiring a reverse proxy every time.

#### Acceptance Criteria

1. WHEN the `dashboard` Docker target builds THEN nginx SHALL be configured
   to serve static assets from `dist/` and SHALL fall back unmatched,
   non-API paths to `/index.html` so deep links like `/usage` or
   `/share/:id` load correctly on direct navigation or refresh.
2. WHEN a request path starts with `/console/api/`, `/v1/`, or `/v2/` THEN
   nginx SHALL reverse-proxy it to the `cartethyia` daemon service,
   preserving the same-origin contract `api.ts`/`console-api.ts` already
   assume.
3. WHEN `docker-compose.yml` is updated THEN it SHALL add a `dashboard`
   service built from that target, network-wired to `cartethyia`, exposed
   on its own host port, with `depends_on: cartethyia (service_healthy)`.
4. The system SHALL NOT modify the Go daemon (`runtime`/`daemon` build
   target or any `internal/server` route) — the documented "daemon never
   serves dashboard" boundary stays exactly as-is.
5. WHEN `docker compose up` runs `postgres`, `redis`, `cartethyia`, and
   `dashboard` together THEN the dashboard SHALL be reachable on its
   exposed port and a request through it to `/console/api/auth/session`
   SHALL reach the real daemon (proving the reverse-proxy wiring, not just
   that each container starts independently).

### Requirement 3 — Daemon coverage hardening (`database`, `providers` root)

**User Story:** As a maintainer, I want the two lowest-covered daemon
packages tested closer to the project's own baseline, so regressions in
connection pooling and provider registry wiring surface before they reach
production.

#### Acceptance Criteria

1. WHEN new tests are added to `internal/database` THEN statement coverage
   SHALL increase from the current 41.2% baseline without editing any
   production logic purely to make it "more testable" (behavior stays
   identical; only test files change unless a genuine bug is found).
2. WHEN new tests are added to `internal/providers` (root package) THEN
   statement coverage SHALL increase from the current 34.0% baseline under
   the same additive-only constraint.
3. IF a genuine bug is discovered while writing coverage tests THEN the
   system SHALL fix it in a clearly isolated change and call it out
   separately from the coverage work (not silently folded in).
4. WHEN coverage work is complete THEN `go test -cover ./...` SHALL still
   report 43+ packages passing with zero regressions in any other package.

### Requirement 4 — Full-stack validation harness

**User Story:** As the person signing off this work, I want one repeatable
way to prove daemon + Postgres + dashboard actually work together, so
"it builds and unit-tests pass" isn't the only evidence of correctness.

#### Acceptance Criteria

1. WHEN the validation harness runs THEN the system SHALL start Postgres,
   the daemon (pointed at that Postgres and at the built dashboard dist per
   Requirement 2), and SHALL wait for both to report ready.
2. WHEN the harness's login flow runs THEN the system SHALL authenticate
   against the real daemon session endpoint and land on the authenticated
   shell (Sidebar/Header/Footer visible), not a mocked response.
3. WHEN the harness visits each of Overview, Usage, Providers, Quota,
   Console Log, Settings, and Share THEN the system SHALL confirm each page
   renders real data from the daemon (no client-side exceptions, no stuck
   loading state).
4. WHEN the harness exercises an SSE-backed surface (console log live
   stream or in-flight telemetry) THEN the system SHALL confirm at least
   one event is received over the live connection within a bounded timeout.
5. WHEN the harness completes THEN the system SHALL produce a pass/fail
   summary readable by the orchestrating agent, listing exactly which
   checks passed or failed.
6. IF any checked surface fails THEN the harness SHALL NOT be reported as
   passing — partial success is reported explicitly, not rounded up.
