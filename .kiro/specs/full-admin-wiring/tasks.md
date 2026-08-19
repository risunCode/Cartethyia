# Implementation Plan

## Phase 1: Admin Password Seeding

- [x] 1.1 Add `ConsolePassword` field to config
  - Add `ConsolePassword string` to `Config` struct in `daemon/internal/config/config.go`
  - Load from `CARTETHYIA_CONSOLE_PASSWORD` env var in `FromEnvironment()`
  - Add validation: warn if empty in production mode
  - _Requirements: 1.1, 1.2_

- [x] 1.2 Implement `seedAdminCredentials` function
  - Create `daemon/internal/runtime/admin_seed.go`
  - Function signature: `func seedAdminCredentials(store database.AdminAPIKeyStore, password string, logger *slog.Logger) error`
  - Check if any admin API key exists via store
  - If none exists and password is set: bcrypt hash password, insert admin key
  - If none exists and password is empty: log warning about dev mode
  - If exists: log "admin credentials already seeded", return nil
  - _Requirements: 1.1, 1.3, 1.4, 1.5_

- [x] 1.3 Wire seeding into bootstrap
  - In `daemon/internal/runtime/bootstrap.go`, call `seedAdminCredentials` after `OpenRuntime()`
  - Pass `config.ConsolePassword` and runtime logger
  - Ensure seeding runs before HTTP server starts
  - _Requirements: 1.1_

- [x] 1.4 Write unit tests for admin seeding
  - Create `daemon/internal/runtime/admin_seed_test.go`
  - Test: no existing key + valid password → creates key
  - Test: no existing key + empty password → logs warning, no key created
  - Test: existing key → skips, logs skip message
  - Test: password is bcrypt hashed before storage
  - _Requirements: 1.1, 1.3, 1.4, 1.5_

## Phase 2: Proxy Management API

- [x] 2.1 Define ProxyAdminService interface
  - Add `ProxyAdminService` interface to `daemon/internal/server/admin/services.go`
  - Methods: `List`, `Create`, `Update`, `Delete`
  - Add `ProxyRecord` and `ProxyInput` types
  - Add `ProxyAdmin` field to `Services` struct
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2.2 Implement proxy repository
  - Create or extend `daemon/internal/database/repositories/proxy_admin.go`
  - Implement `List`: SELECT from proxies JOIN proxy_health
  - Implement `Create`: INSERT into proxies, return record
  - Implement `Update`: UPDATE proxies WHERE id, return record
  - Implement `Delete`: DELETE FROM proxies WHERE id (check no active connections)
  - _Requirements: 2.1, 2.3, 2.4, 2.5_

- [x] 2.3 Create proxy admin handlers
  - Create `daemon/internal/server/admin/proxies.go`
  - `RegisterProxies(mux, services)`: wire GET/POST on `/console/proxies`, PATCH/DELETE on `/console/proxies/:id`
  - `listProxies`: call service.List, return WriteData
  - `createProxy`: decode JSON body, validate, call service.Create, return WriteData
  - `updateProxy`: extract ID from path, decode JSON, call service.Update, return WriteData
  - `deleteProxy`: extract ID, call service.Delete, return WriteOK
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 2.4 Wire RegisterProxies into admin composition
  - In `daemon/internal/server/admin/admin.go`, call `RegisterProxies(internal, services)`
  - Ensure `admin:accounts` scope covers `/console/proxies` paths
  - Update `adminScopeForPath` in `authorization.go` if needed
  - _Requirements: 2.1_

- [x] 2.5 Add proxy validation
  - In `daemon/internal/server/admin/validation.go` or new file
  - Validate proxy type: must be http, https, or socks5
  - Validate host: non-empty, max 255 chars
  - Validate port: 1-65535
  - Validate priority: 0-1000
  - Validate weight: 1-1000
  - Validate maxConcurrency: 1-10000
  - _Requirements: 2.2_

- [x] 2.6 Write proxy handler tests
  - Create `daemon/internal/server/admin/proxies_test.go`
  - Test list returns empty array when no proxies
  - Test create with valid input returns proxy record
  - Test create with invalid type returns 400
  - Test update non-existent proxy returns 404
  - Test delete non-existent proxy returns 404
  - Test delete proxy in use returns 409
  - _Requirements: 2.1-2.7_

## Phase 3: Request Detail Endpoint

- [x] 3.1 Extend TelemetryService interface
  - Add `RequestDetail(ctx, id string) (RequestDetail, error)` to `TelemetryService` in `services.go`
  - Add `RequestDetail` struct with all request fields
  - _Requirements: 4.1, 4.2_

- [x] 3.2 Implement request detail query
  - Extend telemetry repository to fetch single request by ID from `request_history`
  - Return full detail including error field, token counts, latency
  - _Requirements: 4.1, 4.2_

- [x] 3.3 Add request detail handler
  - In `daemon/internal/server/admin/telemetry.go`, add handler for `GET /console/telemetry/requests/:id`
  - Extract ID from path, call service.RequestDetail, return WriteData
  - Return 404 if request not found
  - _Requirements: 4.1, 4.2_

- [x] 3.4 Write request detail tests
  - Test: valid ID returns request detail
  - Test: invalid ID returns 404
  - _Requirements: 4.1, 4.2_

## Phase 4: Dashboard Route Matrix

- [x] 4.1 Update console-routes.ts
  - Add to `CONSOLE_ROUTE_MATRIX`:
    - `{ route: "/proxies", methods: ["GET", "POST"] }`
    - `{ route: "/proxies/:proxyId", methods: ["PATCH", "DELETE"] }`
  - Verify existing routes cover all telemetry/requests endpoints
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 4.2 Update route matrix tests
  - In `dashboard/test/lib/console-routes.test.ts` or similar
  - Test: `/proxies` with GET is documented
  - Test: `/proxies` with POST is documented
  - Test: `/proxies/abc-123` with PATCH is documented
  - Test: `/proxies/abc-123` with DELETE is documented
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

## Phase 5: Proxy Page Wiring

- [x] 5.1 Create proxy API client functions
  - In `dashboard/src/lib/console-api.ts` or new `dashboard/src/lib/proxy-api.ts`
  - `fetchProxies()`: GET /console/proxies, unwrap envelope
  - `createProxy(input)`: POST /console/proxies
  - `updateProxy(id, input)`: PATCH /console/proxies/:id
  - `deleteProxy(id)`: DELETE /console/proxies/:id
  - _Requirements: 2.1, 2.3, 2.4, 2.5_

- [x] 5.2 Implement proxy list view
  - In `dashboard/src/pages/Proxy/index.tsx`
  - Fetch proxies on mount, display in table (use VirtualTable if >50 rows)
  - Columns: Type, Host, Port, Priority, Health, Active, Actions
  - Status badge for health (healthy=green, degraded=yellow, down=red)
  - Auto-refresh every 30 seconds
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 5.3 Implement proxy create/edit form
  - Add modal or drawer for create/edit
  - Fields: type (select), host (input), port (number), priority (number), weight (number), maxConcurrency (number), active (toggle)
  - Validation: port 1-65535, host non-empty, type in list
  - Submit calls createProxy or updateProxy
  - On success: close form, refresh list, show toast
  - On error: display error from envelope
  - _Requirements: 2.2, 2.3, 2.4, 2.7_

- [x] 5.4 Implement proxy delete
  - Delete button with confirmation dialog
  - Call deleteProxy, refresh list, show toast
  - Handle proxy_in_use error (409) with clear message
  - _Requirements: 2.5, 2.7_

- [x] 5.5 Write proxy page tests
  - Test: page renders proxy list
  - Test: create form submits correctly
  - Test: edit form pre-fills and submits
  - Test: delete with confirmation
  - Test: error display on API failure
  - _Requirements: 2.1-2.7, 3.1-3.4_

## Phase 6: Requests Page Wiring

- [x] 6.1 Implement requests list view
  - In `dashboard/src/pages/Requests/index.tsx`
  - Fetch from `GET /console/telemetry/requests` with time range filters
  - Display in paginated table: Model, Provider, Status, Latency, Tokens, Time
  - Filter controls: time range (1h/24h/7d/30d), model, provider, status
  - Auto-refresh every 15 seconds
  - _Requirements: 4.1, 4.3, 4.4_

- [x] 6.2 Implement request detail view
  - Click row to expand or open drawer with full details
  - Fields: ID, model, provider, status code, latency, input/output tokens, error message, client IP, timestamp
  - Fetch detail from `GET /console/telemetry/requests/:id` if needed
  - _Requirements: 4.2_

- [x] 6.3 Write requests page tests
  - Test: page renders request list
  - Test: filters update query params and re-fetch
  - Test: detail view displays all fields
  - _Requirements: 4.1-4.4_

## Phase 7: Account Creation UI

- [x] 7.1 Add account creation form to Providers page
  - In `dashboard/src/pages/Providers/index.tsx`
  - "Add Account" button in provider detail view
  - Form fields: name (input), credentialKind (select: api_key/oauth), priority (number), active (toggle)
  - For OAuth: "Authorize via OAuth" button that calls `POST /console/auth/oauth/start`
  - Submit to `POST /console/providers/:providerId/accounts`
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 7.2 Handle OAuth flow in account creation
  - When credentialKind is "oauth" and user clicks authorize:
    - Call `POST /console/auth/oauth/start` with providerId
    - Redirect to OAuth provider URL from response
    - Handle callback via existing OAuth session routes
  - _Requirements: 5.3_

- [x] 7.3 Write account creation tests
  - Test: form renders with correct fields
  - Test: API key account creation submits correctly
  - Test: OAuth flow initiates correctly
  - Test: error display on creation failure
  - _Requirements: 5.1-5.4_

## Phase 8: Integration & Validation

- [x] 8.1 Run daemon test suite
  - Execute `go test ./...` in daemon directory
  - Verify all new proxy, request, and seed tests pass
  - Fix any compilation or test failures
  - _Requirements: All_

- [x] 8.2 Run dashboard test suite
  - Execute `bun test` in dashboard directory
  - Verify all new page and route matrix tests pass
  - Fix any test failures
  - _Requirements: All_

- [x] 8.3 Manual integration test
  - Start daemon with `CARTETHYIA_CONSOLE_PASSWORD=test123`
  - Verify admin credentials are seeded on first start
  - Login to dashboard, navigate to Proxy page
  - Create, edit, delete a proxy
  - Navigate to Requests page, verify data displays
  - Navigate to Providers, create an account
  - _Requirements: All_
