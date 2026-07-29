# Codebase Merge Optimization Requirements

## Introduction

This specification covers comprehensive codebase optimization focused on **merging duplicates**, **removing unnecessary complexity**, and **simplifying inference processing**. The goal is to make the code more concise while maintaining full functionality.

Key objectives:
1. Consolidate duplicate utility functions across the codebase
2. Inline small single-use helper functions that add cognitive overhead
3. Replace switch statements with O(1) lookup maps
4. Remove unused configuration (OpenCodeFree access modes)
5. Standardize type guards and validators into a unified registry

---

## Requirement 1: Remove OpenCodeFree Access Mode Configuration

**User Story:** As a platform administrator, I want the "OpenCode Free" provider to be accessible by anyone with a valid Cartethyia API key so that it behaves consistently with other models without special gating logic.

#### Acceptance Criteria

1. WHEN admin requests settings configuration THEN system SHALL NOT display opencodeFreeAccess option
2. IF client includes `opencodeFreeAccess` in PATCH request THEN system SHALL reject with invalid_request error
3. WHEN runtime settings are loaded THEN opencodeFreeAccess field SHALL NOT exist in RuntimeSettings interface
4. WHERE database contains legacy opencodeFreeAccess records THEN system SHALL ignore them gracefully

---

## Requirement 2: Consolidate Duplicate Utility Functions

**User Story:** As a developer, I want all utility functions to follow consistent naming conventions so that I can understand their purpose at a glance without searching through multiple files.

#### Acceptance Criteria

1. WHEN `parseBoundedNumber()` function exists in config.ts THEN identical implementations in settings.ts and env.ts SHALL be merged into single centralized version
2. IF `flattenText()` function appears in 5 different locations THEN system SHALL provide one canonical implementation re-exported where needed
3. WHEN `extractModelIds()` is called from providers.ts and custom-providers.ts THEN system SHALL use unified parser from shared utilities
4. WHILE parsing JSON inputs THEN system SHALL reuse typed guards (`asNumber`, `asString`, `field`) from `src/http/jsonGuards.ts` only

---

## Requirement 3: Inline Tiny Single-Use Helper Functions

**User Story:** As an AI inference model, I want minimal wrapper functions so that I can process code faster without excessive indentation and indirection.

#### Acceptance Criteria

1. IF helper function has body less than 6 lines AND called exactly once THEN inline its logic directly at call site
2. WHEN `modelsErrorMessage()` exists ONLY in custom-providers.ts THEN replace with inline switch statement
3. WHEN `credentialHint()` appears twice with identical implementation (`slice(-4)` pattern) THEN remove abstraction entirely
4. WHERE helper adds no additional validation or transformation logic THEN eliminate wrapper and inline logic

---

## Requirement 4: Optimize Switch Statements to Lookup Maps

**User Story:** As system performance analyst, I want fast constant-time lookups instead of if/else chains so that hot path operations complete in O(1) time.

#### Acceptance Criteria

1. WHEN validating `OpenCodeFreeAccess` enum values THEN use object map lookup `{all: "all", local: "local", none: "none"}` instead of if/else chain
2. IF usage periods need validation THEN use `PERIOD_SET.has(value)` pattern with constant array defined centrally
3. WHEN checking proxy auth modes THEN apply same object map approach for consistency
4. WHERE numeric parsing requires bounds checking THEN reuse single `validateNumeric()` utility across all callers

---

## Requirement 5: Consolidate Type Guards Registry

**User Story:** As a testing engineer, I want exhaustive union types documented in one place so that adding new validator patterns requires changes in exactly one file.

#### Acceptance Criteria

1. WHEN defining string literal type guard THEN register in `KNOWN_VALUES_REGISTRY` rather than writing standalone check
2. IF boolean guard checks against known enum THEN implement via `makeValueGuard` factory function
3. WHEN creating new validator for configuration field THEN import from `src/shared/guards.ts` instead of implementing inline
4. WHERE multiple similar type guards exist (`nullableNumber`, `num`, `numberOrZero`) THEN merge into single typed function with defaults

---

## Requirement 6: Deduplicate Date/Time Utilities

**User Story:** As memory profiler, I want fewer Date object allocations so that garbage collection pressure decreases during high-throughput operation.

#### Acceptance Criteria

1. WHEN calculating period start times THEN use `Date.now() - offsetMs` arithmetic rather than constructing full ISO strings repeatedly
2. IF `utcNow()` creates fresh Date every call AND returns same format THEN cache singleton timestamp until day boundary
3. WHERE date subtraction occurs (>3 locations) THEN implement single `addDays(date, days)` utility

---

## Requirement 7: Streamline SSE Stream Handling

**User Story:** As concurrency engineer, I want unified SSE stream creation so that heartbeat logic runs identically across all real-time endpoints.

#### Acceptance Criteria

1. WHEN creating `/live/in-flight/stream` endpoint THEN use shared `createSseStream()` generic utility
2. IF `/console-logs/stream` uses near-identical boilerplate THEN refactor to reuse same streaming implementation
3. WHEN sending SSE events THEN export and reuse `formatSSEFrame()` from `upstream/sse.ts` exclusively

---

## Requirement 8: Reduce Database Boilerplate Patterns

**User Story:** As maintenance lead, I want consistent delete/update patterns across all repositories so that query errors are caught centrally.

#### Acceptance Criteria

1. WHERE database delete queries follow `DELETE FROM X WHERE id = ?` pattern THEN provide generic `deleteRecord(tableName, id)` helper
2. WHEN updating records THEN wrap `update` queries with same error handling pattern  
3. WHERE result.changes > 0 returned after DELETE THEN extract this pattern as reusable assertion

---

## Requirement 9: Unify Error Class System

**User Story:** As debugging specialist, I want HTTP status codes automatically mapped to error codes so that route handlers require zero manual set.status calls.

#### Acceptance Criteria

1. WHEN throwing `ConsoleApiError(code, message)` THEN system SHALL automatically apply correct HTTP status via error class constructor
2. IF global error handler detects ConsoleApiError subclass THEN skip manual set.status assignment
3. WHERE current code writes `set.status = 400; return consoleError("invalid_request", ...)` THEN replace with `throw new ConsoleApiError("invalid_request", ...)`

---

## Requirement 10: Clean Up Hashing/Crypto Redundancy

**UserStory:** As security auditor, I want single canonical implementation of cryptographic primitives so that vulnerabilities cannot be introduced through algorithm variants.

#### Acceptance Criteria

1. WHEN UUID generation needed THEN use `crypto.randomUUID()` consistently across codebase
2. IF SHA-256 hashing required FOR stable record IDs THEN use centralized hashing module
3. WHERE MD5 computation used exactly ONCE THEN inline the hash calculation directly
4. WHERE DJB2 fingerprint algorithm used ONLY IN traffic tracking THEN keep as-is but document rationale

---

## Technical Constraints

- **Runtime**: Must work on Bun >= 1.3.x (Node.js not supported for backend)
- **Breaking Changes**: None acceptable for public API routes
- **Database Schema**: Existing migrations must remain backward compatible
- **Performance**: Optimizations must not degrade any throughput benchmarks
- **Test Coverage**: All existing tests must pass without modification unless explicitly tied to removed features

---

## Success Metrics

| Metric | Before | After | Target Change |
|--------|--------|-------|---------------|
| Total LOC in src/ | ~10,500 | ~9,000 | -15% reduction |
| Average function size | 32 lines | 22 lines | -31% simpler |
| Duplicate utility counts | 18 functions | 8 unique functions | -55% duplication |
| Route handler complexity | 45 lines avg | 30 lines avg | -33% boilerplate |
| Hot-path lookup speed | O(n) if/else | O(1) map lookup | +30% faster |
| Type guard definitions | scattered across 15 files | 1 unified file | +100% maintainability |
