# Implementation Plan

## Phase 1: Baseline and boundaries

- [x] 1. Capture daemon package and import baseline
  - Record `go list ./...` package inventory and current production import fan-in.
  - Add or extend architecture checks only where the repository has an existing convention for package-boundary assertions.
  - Record the current proxy alias, public API package, account driver package, and database model references before migration.
  - _Requirements: 2.1, 9.5, 11.6_

- [x] 2. Add request-path performance benchmark seams
  - Add deterministic benchmarks for router ordinary success, one retry, exhaustion, and stream preflight using existing test transport patterns.
  - Add deterministic benchmarks for protocol decode/normalize/encode, response-cache hit/miss, memory-cache hit/miss/coalescing, and representative stream frame encoding where an existing benchmark package is appropriate.
  - Keep benchmark fixtures bounded and free of credentials, prompt logging, or provider network calls.
  - _Requirements: 6.1, 7.1, 8.5, 11.6_

## Phase 2: Remove duplicate package authority

- [x] 3. Migrate callers from the proxy alias façade
  - Use symbol-aware references for every alias exported by `internal/proxy/proxy.go`.
  - Migrate production callers to `internal/proxy/runtime` without changing public behavior or type semantics.
  - Keep compatibility shims only where an actual remaining caller requires them and document the remaining reference in the cutover audit.
  - _Requirements: 1.4, 3.1, 3.3, 9.5_

- [x] 4. Delete the proxy alias façade after reference proof
  - Confirm production references to `internal/proxy/proxy.go` reach zero.
  - Delete the obsolete alias file and remove obsolete imports/re-exports.
  - Add or update a cutover check that prevents a second proxy authority from returning.
  - _Requirements: 3.2, 3.4, 9.5, 11.1_

- [x] 5. Flatten account driver package scaffolding
  - Move concrete driver files from nested provider directories into `internal/accounts/drivers` with responsibility-based filenames.
  - Preserve each driver type, constructor, registry entry, endpoint, credential mode, token parsing, refresh behavior, and error mapping.
  - Consolidate only genuinely provider-neutral helper logic.
  - _Requirements: 1.2, 5.1, 5.2, 5.3, 5.4_

- [x] 6. Merge account contract and store wrappers into the accounts owner
  - Move the contract and store interfaces/implementations into `internal/accounts` without changing method contracts.
  - Migrate all callers and remove empty wrapper packages after reference proof.
  - Preserve opaque credential references, secret zeroing, OAuth leases, and invalidation semantics.
  - _Requirements: 1.2, 5.2, 9.5, 11.1_

## Phase 3: Consolidate public API orchestration

- [x] 7. Create the unified public API package boundary
  - Consolidate the current public API leaf packages into `internal/server/api`.
  - Preserve all endpoint registrations, route paths, request/response types, status codes, headers, streaming content types, and error codes.
  - Keep admin and middleware packages separate.
  - _Requirements: 1.3, 2.1, 4.1, 4.5_

- [x] 8. Unify shared generation request orchestration
  - Implement one API-owned lifecycle for request extraction, context/deadline handling, codec lookup, compatibility planning, dispatch, response projection, stream writing, and error mapping.
  - Keep Chat, Messages, Gemini, Responses, Images, Models, and Actions as explicit handler methods.
  - Keep OpenAI, Anthropic, and Gemini wire-specific behavior in their existing codec implementations.
  - _Requirements: 1.1, 4.2, 4.3, 4.4_

- [x] 9. Remove obsolete public API package wrappers
  - Use symbol-aware references to prove the old API subpackages have no remaining callers.
  - Remove empty packages and stale imports only after endpoint registration and contract checks pass.
  - Ensure no raw provider response bypass or generic wire projection was introduced.
  - _Requirements: 1.4, 3.4, 4.5, 9.5_

## Phase 4: Dedupe request-path orchestration

- [x] 10. Compare Route and RouteStream attempt transitions
  - Identify identical candidate acquisition, preparation, reservation, bookkeeping, failure classification, refresh, availability, and retry transitions.
  - Document the exact transition contract in code comments or focused internal types, without introducing an exported abstraction.
  - Preserve stream-specific preflight, acceptance, terminal, cancellation, and finalization paths.
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 11. Share only proven-equivalent router attempt state
  - Introduce bounded internal attempt state/helpers only for transitions proven equivalent by focused behavioral tests.
  - Preserve maximum attempts, refresh/repair/hedge budgets, account exclusions, model-scoped failure updates, quota reservation, and attempt evidence.
  - Verify ordinary success, retry, refresh, repair, failover, hedge, exhaustion, and availability outcomes remain unchanged.
  - _Requirements: 1.2, 6.4, 6.5, 11.4_

- [x] 12. Consolidate dispatch side-effect seams without changing lifecycle
  - Keep `DispatchService` as the request lifecycle owner.
  - Isolate only duplicate or independently testable response-cache, continuation, usage, metadata, or stream-finalization helpers where this reduces repeated work or dependency fan-out.
  - Preserve fail-open side-effect behavior and panic/cancellation finalization.
  - _Requirements: 1.2, 6.3, 7.6, 11.4_

## Phase 5: Measure and optimize verified hot paths

- [x] 13. Optimize stream frame allocation only when benchmark evidence justifies it
  - Compare dynamic map/JSON frame construction against a typed or bounded encoding implementation for representative text, tool, reasoning, usage, and terminal events.
  - Apply the optimization only if it improves the measured target without increasing incorrect frames, allocations elsewhere, or synchronization risk.
  - Preserve surface-specific event names, terminal semantics, cancellation, and downstream framing.
  - _Requirements: 1.1, 6.3, 7.2, 11.5, 11.6_

- [x] 14. Remove only redundant protocol conversion work
  - Profile decode, canonical validation, defensive copy, sidecar handling, and response projection for representative surfaces.
  - Define byte/slice ownership before removing any copy.
  - Preserve tool, media, document/PDF, reasoning, compaction, context-management, strict projection, and native-sidecar semantics.
  - _Requirements: 1.1, 4.4, 7.3, 11.5_

- [x] 15. Optimize cache key/value or lock paths only when measured
  - Benchmark memory hit/miss/coalescing, response-cache hit/miss, key/fingerprint creation, and relevant fallback paths.
  - Change copies, serialization, or lock scope only when the benchmark/profile identifies a material cost and the ownership invariant remains explicit.
  - Preserve close publication, waiter wakeup, one-loader coalescing, bounded capacity, generation safety, tenant scope, and zero provider calls on hits.
  - _Requirements: 7.4, 8.1, 8.2, 8.3, 8.4, 8.5_

## Phase 6: Import and ownership cleanup

- [x] 16. Enforce final import direction
  - Verify the composition root owns concrete dependency wiring.
  - Prevent proxy runtime from importing HTTP handlers or the application composition package.
  - Prevent protocol transforms from importing database, server, transport, or provider HTTP implementations.
  - Prevent database persistence from becoming a protocol or retry-policy dependency.
  - _Requirements: 2.4, 9.1, 9.2, 9.3, 9.4, 9.6_

- [x] 17. Keep provider and database functionality intact during cleanup
  - Verify all provider definition registries, adapters, builtin/custom materialization, OAuth definitions, policies, repositories, migrations, backup/restore services, token-budget persistence, and telemetry persistence remain registered and reachable.
  - Do not merge provider definitions or move database models unless a separate approved migration is added.
  - _Requirements: 1.3, 10.1, 10.2, 10.4_

- [x] 18. Remove stale aliases, wrappers, and imports
  - Use symbol-aware references and package listing to prove obsolete package paths have no callers.
  - Delete only dead compatibility wrappers, re-exports, and imports introduced by the completed migrations.
  - Keep any remaining compatibility shim documented and covered until its caller migration is complete.
  - _Requirements: 1.4, 3.2, 9.5, 11.1_

## Phase 7: End-to-end verification

- [x] 19. Run full functional and structural verification
  - Run `go test ./...`, `go build ./...`, and `go vet ./...`.
  - Run the full race suite with the verified LLVM-MinGW CGO configuration on Windows.
  - Run the compatibility acceptance matrix and confirm 19/19 scenarios, 15/15 Tier-0 scenarios, and 10000 basis points for both scores.
  - Verify all public, admin, CLI, provider, account, cache, stream, protocol, database, security, and observability contracts relevant to changed areas.
  - _Requirements: 1.5, 8.5, 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 20. Record measured optimization results and cleanup scope
  - Record before/after benchmark or profile evidence for every claimed runtime improvement.
  - Distinguish runtime improvements from package/import/build improvements and navigation-only changes.
  - Confirm no functionality was removed and no unverified performance claim remains in the audit/spec.
  - _Requirements: 1.1, 2.5, 7.5, 7.6, 11.6_
