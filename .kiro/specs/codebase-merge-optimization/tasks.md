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

- [ ] 9. Create `src/utils/date-utils.ts` — date caching optimization
  - Implement cached `utcDate()` with midnight boundary check
  - Implement `periodStartFromOffset(offsetMs)` helper
  - Define constant `PERIOD_OFFSETS` object for O(1) lookup
  - Update `utcNow()`, `utcDateOf()`, `periodStartUtc()` in db/repos/usage.ts to use new utilities
  - Update `cutoffDate()` in tracking/rotate.ts to reuse same logic
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

- [ ] 12. Inline credential hint functions
  - In `accounts.ts`: replace `credentialHint(value)` call at line 10 with `.slice(-4)` expression
  - In `custom-providers.ts`: replace `credentialHintFor(record)` at line 235 with direct `.slice(-4)`  
  - Delete both helper functions after removing all references
  - _Requirements: 3_

- [ ] 13. Inline `clampTimeoutSeconds()` helper
  - Locate at line 159 in custom-providers.ts
  - Replace entire function body with inline: `value == null || !Number.isFinite(value) ? DEFAULT_TIMEOUT : Math.min(MAX, Math.min(MIN, Math.round(value)))`
  - Delete function definition
  - _Requirements: 3_

- [ ] 14. Inline `sanitizeHeaders()` validator
  - Find at line 76 in custom-providers.ts
  - Merge logic directly into JSON parsing block in `createCustomProvider()` handler (around line 166)
  - Remove function entirely
  - _Requirements: 3_

- [ ] 15. Inline lock management wrappers
  - In accounts.ts: merge `isAccountCooledDown()` and `isModelLocked()` into single `checkLockStatus(accountId, modelId?)` function
  - Inline `releaseLock()` finally block directly in `withModelLock()` usage sites
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

## Phase 5: Error Class System Implementation

- [ ] 18. Create `src/http/error-class.ts`
  - Define `ConsoleErrorCode` union type matching existing console errors
  - Implement `ConsoleApiError extends Error` class with auto-mapped status codes
  - Add static map: `{ unauthorized: 401, forbidden: 403, invalid_request: 400, not_found: 404, conflict: 409, rate_limited: 429, internal: 500 }`
  - Implement `toJSON()` returning exact same envelope format as old `consoleError()`
  - _Requirements: 9_

- [ ] 19. Migrate all routes to throw ConsoleApiError
  - Update ALL occurrences of `set.status = X; return consoleError(...)` pattern:
    - `console/api/access.ts` (~8 instances)
    - `console/api/auth.ts` (~6 instances)
    - `console/api/combos.ts` (~12 instances)
    - `console/api/custom-providers.ts` (~8 instances)
    - `console/api/keys.ts` (~5 instances)
    - `console/api/proxy-pools.ts` (~6 instances)
    - `console/api/settings.ts` (~6 instances)
    - `console/api/usage.ts` (~8 instances)
    - `console/auth/guard.ts` (~4 instances)
  - Pattern: Replace `return consoleError("invalid_request", "msg")` with `throw new ConsoleApiError("invalid_request", "msg")`
  - _Requirements: 9_

- [ ] 20. Wire global error handler to consume ConsoleApiError
  - In `src/app.ts`: update onError handler to detect ConsoleApiError instance
  - Auto-assign `set.status = error.httpStatus` before returning error envelope
  - Remove manual `set.status` assignments from routes (they're now redundant)
  - _Requirements: 9_

---

## Phase 6: Delete Boilerplate Helpers

- [ ] 21. Consolidate database delete patterns
  - Create `src/db/delete-helper.ts` with generic `deleteRecord(db, tableName, id)` function
  - Update all `DELETE FROM X WHERE id = ?` queries to use this helper:
    - `console/db/repos/accounts.ts` (provider_accounts deletion)
    - `console/db/repos/api-keys.ts`
    - `console/db/repos/combos.ts` (alias, combo, filter deletions)
    - `console/db/repos/custom-providers.ts`
    - `console/db/repos/provider-models.ts`
    - `console/db/repos/proxy-pools.ts`
    - `console/db/repos/sanitizer-rules.ts`
  - Wrap result assertion in reusable `assertChanges(result)` helper
  - _Requirements: 8_

---

## Phase 7: Cleanup & Verification

- [ ] 22. Run TypeScript compiler checks
  - Execute `bunx tsc --noEmit -p .`
  - Fix any type errors from removed interfaces/migrations
  - Ensure all imports resolve correctly after refactor

- [ ] 23. Update test expectations
  - Verify `test/console/accounts.test.ts` still validates plaintext credentials
  - Confirm `test/console/custom-providers.test.ts` sync tests pass without hash functions
  - Check `test/console/backup.test.ts` doesn't include deleted settings keys
  - Update snapshot assertions if affected by config removal

- [ ] 24. Full test suite execution
  - Run `bun test` end-to-end
  - Target: All 422+ tests passing
  - Document any regressions immediately

- [ ] 25. Dashboard build verification
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
