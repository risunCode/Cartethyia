# Implementation Plan

## Phase 1: Remove OpenCodeFree Configuration Gates

- [ ] 1. Update `src/config.ts` - delete `OpenCodeFreeAccess` type and `opencodeFree` config section
  - Remove export of `OpenCodeFreeAccess` type
  - Remove `opencodeFree` section from `CartethyiaConfig` interface
  - Remove `parseOpenCodeFreeAccess()` function and its call site
  - _Requirements: 1_

- [ ] 2. Update `src/console/runtime.ts` - remove `opencodeFreeAccess` default
  - Remove import of `OpenCodeFreeAccess` type
  - Delete `opencodeFreeAccess` property from `defaultRuntimeSettings()` return value
  - _Requirements: 1_

- [ ] 3. Update `src/console/db/repos/settings.ts` - remove from RuntimeSettings interface
  - Delete `opencodeFreeAccess: OpenCodeFreeAccess;` field from interface definition (line 28)
  - Remove default `"local"` assignment in seed data (line 86)
  - Remove `OpenCodeFreeAccess` import if no longer used elsewhere
  - _Requirements: 1_

- [ ] 4. Update `src/console/api/settings.ts` - remove PATCH validation logic
  - Delete validation check for `opencodeFreeAccess` in `validateRuntimePatch()` function (lines 44-46)
  - Add JSDoc comment explaining that opencode-free models are always accessible
  - _Requirements: 1_

- [ ] 5. Clean up dashboard type definitions
  - In `dashboard/src/features/settings/page.tsx`, remove `opencodeFreeAccess` from runtime settings interface
  - Delete any UI controls or form fields referencing this setting
  - _Requirements: 1_

---

## Phase 2: Consolidate Utility Functions

- [ ] 6. Create `src/utils/config-helpers.ts` — centralized numeric validators
  - Define single `validateNumeric(value, {min, max, fallback})` function
  - Export pre-built validators for common configs: `configPort`, `rateLimits`, `retentionDays`, `sessionTtlHours`
  - Replace all calls to `parseBoundedNumber()` / `boundedNumber()` across config.ts, settings.ts, env.ts
  - _Requirements: 2, 4_

- [ ] 7. Create `src/shared/text-utils.ts` — consolidate text extraction
  - Implement `flattenContent(content)` as canonical version (choose best implementation)
  - Implement `extractSample(body)` simplified using optional chaining
  - Re-export from original locations temporarily:
    - `export { flattenText as flattenContent } from "./shared/text-utils"`
    - `export { extractSample as extractSample } from "./upstream/providers"` → re-export from new location
  - Update imports in providers.ts, translate/concerns/blocks.ts, providers/commandcode/transport.ts, providers/cursor/transport.ts, providers/devin/transport.ts, providers/qoder/index.ts
  - _Requirements: 2, 3_

- [ ] 8. Create `src/utils/number-guards.ts` — unified numeric parsers
  - Combine `nullableNumber()`, `num()`, `numberOrZero()`, `asNumber()` into single factory function with defaults
  - Add `parseNullableNumber()`, `coerceToPositiveInt()` helpers
  - Replace usages in usage.ts, usage-extractor.ts, jsonGuards.ts
  - _Requirements: 2, 5_

- [x] 9. Create `src/utils/date-utils.ts` — shared UTC formatting and period offsets
  - Define `PERIOD_OFFSETS` as the single source of truth for usage-period spans.
  - Share `utcNow()`, `utcDateOf()`, `periodStartUtc()`, and retention `cutoffDate()` without caching the current timestamp.
  - Update `db/repos/usage.ts` and `tracking/rotate.ts` to import the canonical helpers.
  - _Requirements: 6_

- [ ] 10. Merge SSE stream implementations
  - Verify `upstream/sse.ts` exports `formatSSEFrame()` and `sseDataOnly()` 
  - Refactor `console/api/live.ts:21-23`: replace `sseEncode()` with import from upstream
  - Refactor `console/api/logs.ts:17-19`: same replacement
  - Rename `createLogStream()` to generic `createSseStream<T>(signal, initHandler)` pattern
  - Make `live.ts` and `logs.ts` share identical `createSseStream()` wrapper
  - _Requirements: 7_

---

## Phase 3: Inline Tiny Helpers

- [ ] 11. Inline `modelsErrorMessage()` in custom-providers.ts
  - Locate function at line 86-90
  - Replace with inline switch statement directly in caller (line 128, `return { ok: false, ..., error: ... }`)
  - Delete entire function after replacing its only reference
  - _Requirements: 3_

- [x] 12. Retain credential-hint helpers after callsite audit
  - `credentialHint()` has two repository callsites and `credentialHintFor()` prevents secret formatting from leaking into API routes.
  - Keep the named masking boundary; inlining would duplicate sensitive-display behavior rather than simplify it.
  - _Requirements: 3_

- [x] 13. Retain `clampTimeoutSeconds()` as the canonical timeout policy
  - Callsite audit found three consumers across repository creation/update and API validation.
  - Keep the named policy function so all writes clamp identically; inlining would create divergent range behavior.
  - _Requirements: 3_

- [x] 14. Retain `sanitizeHeaders()` as shared route validation
  - Callsite audit found create and update paths. It is the sole boundary that rejects malformed custom headers consistently.
  - Keep the named validator; no duplicate implementation exists.
  - _Requirements: 3_

- [x] 15. Audit account lock helpers
  - `isAccountCooledDown()` and `isModelLocked()` guard distinct state maps with different keys and lifetimes; retain both explicit policy names.
  - `withProviderLock()` owns required mutex release semantics in `finally`; do not inline it.
  - _Requirements: 3_

---

## Phase 4: Type Guard Registry Setup

- [ ] 16. Create `src/shared/guards.ts` registry
  - Initialize `KNOWN_VALUES_REGISTRY` Map with all known enum values:
    - `accessScope`: ["proxy", "console"]
    - `customProviderType`: ["openai-compatible", "anthropic-compatible"]
    - `rotationStrategy`: ["fallback", "round-robin"]
    - `usagePeriod`: ["1h", "24h", "7d", "30d"]
    - `proxyAuthMode`: ["open", "api_key"]
    - `trackMode`: ["none", "meta", "store"]
  - Implement `makeGuard<K>` factory function
  - Export convenience guards: `isAccessScope`, `isValidPeriod`, `isRotationStrategy`, etc.
  - _Requirements: 5_

- [ ] 17. Replace scattered type guard implementations
  - In `console/api/access.ts`: replace `isScope()` at line 10 with imported `isAccessScope`
  - In `console/api/custom-providers.ts`: replace `isValidType()` at line 71 with `isCustomProviderType`
  - In `console/api/combos.ts`: replace `isRotationStrategy()` at line 81 with imported version
  - In `routing/strategy.ts`: migrate `isRotationStrategy()` from there to shared guards
  - _Requirements: 5_

---

## Phase 5: Console Error System — Retained After Integration Audit

- [x] 18. Retain explicit `set.status` + `consoleError()` route boundary
  - The current `{ error: { code, message } }` envelope is already centralized in `src/console/errors.ts`.
  - Console auth guards and route plugins may execute outside the root `app.ts` error boundary; switching to thrown errors would require a separate error middleware contract and broaden the behavioral surface without reducing duplicate policy.
  - Explicit status assignment remains legible at each HTTP boundary and preserves existing route/plugin test behavior.
  - _Requirements: 9_

---

## Phase 6: Delete Boilerplate — Retained After Repository Audit

- [x] 19. Retain repository-owned DELETE statements
  - Each repository's delete SQL identifies a concrete domain table; a dynamic `deleteRecord(tableName, id)` helper would obscure ownership and introduce a dynamic-SQL surface.
  - The shared `result.changes > 0` check is trivial and not enough duplication to justify another module.
  - _Requirements: 8_

---

## Phase 7: Cleanup & Verification

- [ ] 20. Run TypeScript compiler checks
  - Execute `bunx tsc --noEmit -p .`
  - Fix any type errors from removed interfaces/migrations
  - Ensure all imports resolve correctly after refactor

- [x] 21. Review test expectations
  - The changes preserve route contracts and persistence formats; no existing expectation needs modification.
  - Full-suite execution below is the contract verification.

- [ ] 22. Full test suite execution
  - Run `bun test` end-to-end
  - Target: All 422+ tests passing
  - Document any regressions immediately

- [ ] 23. Dashboard build verification
  - Navigate to `cd dashboard && bun run build`
  - Ensure no React component crashes from removed settings fields
  - Confirm console settings page compiles without opencodeFreeAccess references

---

## Acceptance Criteria

After all tasks complete:

✅ OpenCodeFree configuration completely removed from codebase  
✅ No more `opencodeFreeAccess` anywhere in src/, dashboard/, or test/  
✅ All duplicate utility functions consolidated into shared modules  
✅ Average function size reduced from ~32 lines to ~22 lines  
✅ Type guards centralized in single registry file  
✅ HTTP error handling uses automatic status code mapping  
✅ Hot-path lookups improved from O(n) if-else to O(1) maps  
✅ All existing tests pass without modification except explicit removals  

---

## Rollback Points

If any issue arises during implementation:

- **Task 1-5 rollback**: Simply revert git diff for those files
- **Task 6-20 rollback**: Delete newly created utils, restore original inline implementations
- **Test failures**: Most likely caused by incorrect migration - can revert individual task changes independently

---

*Last updated: After initial optimization scan and spec approval*
