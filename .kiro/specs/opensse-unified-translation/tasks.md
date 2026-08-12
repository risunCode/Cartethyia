# Implementation Plan

- [x] 1. Establish canonical translation contracts
  - [x] 1.1 Add immutable translation context, feature result, capability matrix, cache intent, and compatibility rejection types.
    - Preserve `ProxyRequest` and `ProviderCaps` compatibility during migration.
    - _Requirements: 1.2, 2.1, 3.1, 5.1, 7.1_
  - [x] 1.2 Add conservative model capability resolution from provider and model capabilities.
    - Ensure unknown optional features are disabled and mixed catalogs do not inherit aggregate OR support.
    - _Requirements: 2.2, 2.3, 2.4_
  - [x] 1.3 Add unit tests for capability resolution and canonical context construction.
    - _Requirements: 2.1, 2.3, 8.3_

- [x] 2. Centralize client-control translation
  - [x] 2.1 Move effort normalization into a shared feature translator.
    - Cover Claude Code, Codex, Cursor, Gemini CLI, Cline, OpenCode, and generic aliases.
    - _Requirements: 3.1, 3.2_
  - [x] 2.2 Centralize reasoning budget filtering and target projection.
    - Never forward unsupported nested budget fields to a target that does not declare support.
    - _Requirements: 3.2, 3.3, 4.1_
  - [x] 2.3 Add translation matrix tests for reasoning and response controls.
    - _Requirements: 3.1, 3.2, 8.3, 8.4_

- [x] 3. Harden source-wire preservation and target encoding
  - [x] 3.1 Replace arbitrary same-surface copying with explicit extension rules.
    - Preserve only validated, allowlisted fields and record dropped optional fields.
    - _Requirements: 1.3, 1.4, 1.5_
  - [x] 3.2 Apply capability filtering and declarative quirk policy before wire validation.
    - _Requirements: 2.2, 4.1, 4.4_
  - [x] 3.3 Add cross-surface and same-surface payload contract tests.
    - _Requirements: 1.3, 1.4, 4.1, 8.3_

- [x] 4. Unify cache intent and compatibility fallback
  - [x] 4.1 Compute cache intent from the final translated payload and project it per target capability.
    - Keep cache keys when valid and place markers before volatile metadata.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 4.2 Add shared compatibility rejection classification and bounded optional-field retry.
    - Retry once, preserve semantic fields, and emit diagnostics.
    - _Requirements: 4.2, 4.3, 5.5, 7.3_
  - [x] 4.3 Add cache and fallback transport integration tests.
    - _Requirements: 5.5, 7.4, 8.3_

- [x] 5. Migrate provider adapters to shared policy
  - [x] 5.1 Migrate OpenAI, Codex, Grok, and OpenAI-compatible adapters.
    - _Requirements: 2.1, 4.4, 8.1, 8.5_
  - [x] 5.2 Migrate Anthropic, Claude Code, AgentRouter, and custom adapters.
    - _Requirements: 3.2, 4.4, 5.2, 8.1, 8.5_
  - [x] 5.3 Migrate remaining direct adapters or register explicit tested exceptions.
    - _Requirements: 4.4, 8.5_

- [x] 6. Normalize response, stream, and diagnostics symmetry
  - [x] 6.1 Apply one response identity and usage projection policy.
    - _Requirements: 6.1, 6.3, 6.4_
  - [x] 6.2 Extend bounded diagnostics with translation and fallback outcomes.
    - _Requirements: 6.5, 7.1, 7.2, 7.5_
  - [x] 6.3 Add stream/non-stream parity and lifecycle regression tests.
    - _Requirements: 6.1, 6.2, 6.3, 8.3_

- [x] 7. Complete rollout verification
  - [x] 7.1 Run translation matrix, provider, storage, and transport suites.
    - _Requirements: 8.3, 8.4_
  - [x] 7.2 Build the release binary and run localhost health plus deterministic provider smoke.
    - _Requirements: 4.5, 8.3_
  - [x] 7.3 Remove obsolete ad hoc compatibility paths after all migrated callers pass.
    - _Requirements: 4.4, 8.5_
