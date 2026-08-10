# Dashboard Cleanup Implementation Plan

- [x] 1. Establish route and entrypoint characterization tests
  - Add tests for canonical `/advanced`, `/advanced/cli-tools`, and `/advanced/token-saver` registrations.
  - Add tests proving `/customization` redirects to `/advanced` and `/token-saver` redirects to `/advanced/token-saver`.
  - Preserve the existing auth guard, basename, and lazy-import recovery contracts.
  - _Requirements: 1.1, 1.2, 5.2_

- [x] 2. Remove no-op page entrypoint wrappers
  - [x] 2.1 Route customization directly to `CustomizationPage`
    - Update `src/app/router.tsx` to use the canonical customization export without the `AdvancedPage` wrapper.
    - Use TypeScript references to confirm `AdvancedPage` has no remaining caller before deleting its wrapper file.
    - _Requirements: 1.3, 1.4, 2.1_
  - [x] 2.2 Route CLI tools directly to `CliToolsPage`
    - Update the route import to `src/features/advanced/cli-tools/page`.
    - Retain `AutomationPage` and its intentional placeholder route.
    - Delete only the unused CLI indirection after references are verified.
    - _Requirements: 1.3, 4.4_

- [ ] 3. Introduce shared deterministic test helpers
  - Create a test-only helper for Query Client setup with retries disabled and isolated cache.
  - Create a fetch response-table helper that preserves each test's explicit endpoint scenarios.
  - Migrate duplicated model-picker/provider-form setup without weakening assertions.
  - _Requirements: 3.5, 5.1_

- [ ] 4. Strengthen model-picker and provider contract tests
  - [ ] 4.1 Cover picker interaction and catalog boundaries
    - Assert add/remove/toggle callbacks, selected aliases/combos, custom provider exclusion, and qualified model IDs.
    - Assert loading/error/empty states for catalog requests.
    - _Requirements: 3.2, 3.5_
  - [ ] 4.2 Extract and test provider normalizers/builders
    - Add pure tests for provider detail normalization, account/model selection, and mutation payloads where current behavior is embedded in the page.
    - Preserve existing `ApiError` and toast failure paths.
    - _Requirements: 2.3, 3.2, 4.2_

- [ ] 5. Add high-risk lifecycle and destructive-action tests
  - [ ] 5.1 Test async lifecycle cleanup
    - Cover EventSource open/error/reconnect/unmount behavior and timer/listener cleanup.
    - Cover model-studio abort/stale session/autosave behavior with deterministic timers.
    - _Requirements: 3.3, 5.2_
  - [ ] 5.2 Test destructive and protected flows
    - Cover database/settings destructive actions, password confirmation, mutation failure, and query invalidation.
    - Cover safe same-origin login destinations and unauthorized API handling.
    - _Requirements: 3.1, 3.2, 3.4, 5.2_

- [ ] 6. Extract only stable boundaries from hotspot files
  - [ ] 6.1 Extract shell concerns from `src/app/layout.tsx`
    - Separate navigation metadata and command palette/notification concerns only when props and route contracts are explicit.
    - Preserve sidebar persistence, keyboard handling, focus restoration, title resolution, and footer isolation.
    - _Requirements: 2.1, 2.3_
  - [ ] 6.2 Extract model-studio boundaries
    - Separate stream transport, session persistence, and message row rendering without changing abort, attachment, token, or autosave semantics.
    - Keep `ModelStudioPage` as the orchestration entrypoint.
    - _Requirements: 2.1, 2.3, 3.3_
  - [ ] 6.3 Extract provider detail boundaries
    - Separate account/OAuth/model-test/routing sections only after focused contracts pass.
    - Keep mutation ownership and existing public callbacks stable.
    - _Requirements: 2.1, 2.3, 3.2_

- [ ] 7. Investigate and remove cleanup debt at the source
  - Fix or intentionally document the existing `backdrop-blur-[6px]` CSS build warning without suppressing it.
  - Remove stale `REQ-*` comments, obsolete imports, and dead aliases only after references and tests prove they are unused.
  - Keep the Automation placeholder and `Soon` badge unchanged.
  - _Requirements: 4.1, 4.3, 4.4, 5.3_

- [ ] 8. Verify each cleanup batch end to end
  - Run focused Vitest files after each task group.
  - Run `bun run test` and `bun run build` after the final batch.
  - Confirm no stale imports, route regressions, new build warnings, or weakened failure-path assertions remain.
  - _Requirements: 1.4, 2.4, 5.1, 5.2, 5.3, 5.4_
