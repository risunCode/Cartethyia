# Implementation Plan

- [x] 1. Remove custom concurrency layers
  - [x] 1.1 Remove worker-pool source, protocol, parser-worker, and worker-specific tests.
  - [x] 1.2 Remove worker configuration and worker health documentation.
  - [x] 1.3 Preserve the direct asynchronous request and streaming path.

- [x] 2. Keep the runtime single-process
  - [x] 2.1 Keep `src/main.ts` starting `src/middleware/server.ts` directly.
  - [x] 2.2 Keep OAuth, quota, recovery, retention, and GC maintenance owned by the existing runtime.
  - [x] 2.3 Remove the abandoned application-level cluster launcher and empty concurrency directory.

- [x] 3. Verify compatibility
  - [x] 3.1 Run TypeScript validation and backend regression coverage.
  - [x] 3.2 Run dashboard test/build coverage.
  - [x] 3.3 Run single-process health smoke and verify the removed worker route remains absent.

## Requirements mapping

- Requirements 1–4: direct Bun async path and worker-pool removal.
- Requirements 5–6: existing runtime/storage and health contracts.
- Requirement 7: deployment-level scale-out remains outside the application runtime.
