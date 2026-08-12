# Requirements Document

## Introduction

Standardize `src/open-sse` into one reusable translation pipeline for all CLI clients and provider adapters. The system must normalize client-specific request fields into a canonical request document, negotiate target capabilities per provider model, encode only supported outbound fields, preserve cache semantics, and recover from provider incompatibilities without leaking raw upstream failures to clients.

The scope covers request detection, normalization, capability negotiation, provider encoding, cache marking, response decoding/encoding, streaming lifecycle, diagnostics, and adapter integration. It does not require every provider to support every feature; unsupported features must have an explicit policy: adapt, omit with bounded diagnostics, or fail with a stable client-facing error.

## Requirements

### Requirement 1: Canonical translation pipeline

**User Story:** As a CLI client, I want every supported wire format converted through one canonical representation, so that behavior does not depend on which provider adapter receives the request.

#### Acceptance Criteria

1. WHEN a request arrives on any supported client surface THEN the system SHALL detect the client profile and wire format separately.
2. WHEN normalization succeeds THEN the system SHALL produce one canonical request document containing model, messages, tools, reasoning, response controls, media, conversation state, cache intent, and bounded extensions.
3. WHEN a request is translated across surfaces THEN the system SHALL never copy arbitrary source payload fields directly into the target payload.
4. WHEN a same-surface field is preserved THEN the system SHALL apply the same allowlist and sanitizer used by cross-surface encoding.
5. WHEN a field cannot be represented on the target surface THEN the system SHALL apply an explicit disposition of preserved, adapted, unsupported, or dropped-with-diagnostic.

### Requirement 2: Per-model capability negotiation

**User Story:** As a provider operator, I want feature decisions made from the selected model's capabilities, so that one capable model cannot incorrectly enable unsupported parameters for another model on the same provider.

#### Acceptance Criteria

1. WHEN a route target is selected THEN the system SHALL resolve provider, client-facing model, upstream model, target surface, and model-specific capabilities together.
2. WHEN an outbound field is encoded THEN the encoder SHALL consult the selected model capabilities rather than provider-level aggregate booleans.
3. WHEN a provider catalog has mixed capabilities THEN capability aggregation SHALL not enable a feature for every model merely because one model supports it.
4. WHEN capabilities are unknown THEN the system SHALL use a conservative compatibility profile and a bounded fallback policy.
5. WHEN a target surface is unsupported THEN the system SHALL select a declared canonical fallback surface or return a stable capability error before network I/O.

### Requirement 3: Unified client-control translation

**User Story:** As a Claude Code, Codex, Cursor, Gemini CLI, Cline, OpenCode, or generic CLI user, I want client-specific controls translated consistently, so that effort, tools, context, metadata, and response controls work across providers.

#### Acceptance Criteria

1. WHEN a client sends an effort alias such as `max`, ,`high` `low`,`medium`, `xhigh`, `ultracode`, `auto`, or `minimal` THEN the system SHALL normalize it once into a canonical effort intent.
2. WHEN the target provider supports a different effort vocabulary THEN the system SHALL map the canonical intent to the target vocabulary without sending invalid raw values.
3. WHEN the client sends unsupported reasoning fields such as `reasoning.max_tokens` THEN the system SHALL apply the target capability policy instead of forwarding the field blindly.
4. WHEN client metadata contains provider identity instructions THEN the system SHALL preserve intended model identity and prevent a routed model from claiming the wrong provider identity.
5. WHEN tool definitions or tool calls require protocol adaptation THEN the system SHALL use one shared tool ledger and preserve call IDs, arguments, and result ordering.

### Requirement 4: Provider-safe payload encoding

**User Story:** As a provider adapter, I want one capability-aware encoder and transport boundary, so that provider quirks do not create fragile per-adapter payload mutations.

#### Acceptance Criteria

1. WHEN an outbound payload is built THEN the system SHALL run canonical encoding, capability filtering, provider quirk policy, and final validation in that order.
2. WHEN a provider rejects an optional parameter before meaningful output THEN the system SHALL retry once with only that optional feature removed when the error is explicitly classified as compatibility-related.
3. WHEN a required semantic field is rejected THEN the system SHALL not silently drop it; it SHALL produce a stable translated error and bounded diagnostics.
4. WHEN a provider adapter bypasses shared transport helpers THEN the bypass SHALL implement the same payload policy, error classification, lifecycle cleanup, and capture contract.
5. WHEN request payloads are large THEN the system SHALL preserve bounded body limits and avoid avoidable copies during sanitization.

### Requirement 5: Global prompt-cache contract

**User Story:** As a CLI user, I want prompt caching to work consistently across providers, so that stable instructions and tools are reused without corrupting dynamic session data.

#### Acceptance Criteria

1. WHEN a request has a stable prefix THEN the system SHALL compute one provider-neutral cache intent containing stable-prefix identity, affinity key, and requested cache policy.
2. WHEN the target provider supports native cache markers THEN the encoder SHALL project the intent into the provider's marker format.
3. WHEN the target provider supports only a cache key THEN the encoder SHALL preserve the key without sending unsupported breakpoint/options fields.
4. WHEN a stable prefix is followed by volatile session metadata, UUIDs, timestamps, billing headers, or credentials THEN the system SHALL place the cache boundary before volatile content.
5. WHEN cache options are rejected as unsupported THEN the system SHALL remove only the rejected optional cache fields, preserve the cache key where valid, retry once, and record the fallback without exposing the raw provider error.
6. WHEN usage is returned THEN the system SHALL normalize cache read and write tokens into the shared usage contract and preserve provider-native output semantics at the client boundary.

### Requirement 6: Response and streaming symmetry

**User Story:** As a CLI client, I want streaming and non-streaming responses to expose the same semantics, so that tools, reasoning, usage, errors, and model identity behave consistently.

#### Acceptance Criteria

1. WHEN a provider returns a stream or a complete response THEN the system SHALL decode both into the same canonical response event/document model.
2. WHEN a stream fails before meaningful output THEN the system SHALL permit the declared retry policy; after meaningful output or a terminal event it SHALL not replay the request.
3. WHEN usage includes cache reads or writes THEN stream and non-stream encoders SHALL report equivalent normalized metrics.
4. WHEN a response is projected to a client surface THEN the displayed model SHALL be the client-requested model unless an explicit response policy says otherwise; upstream IDs SHALL remain internal metadata.
5. WHEN an upstream error has no usable detail THEN the system SHALL emit a stable non-empty client-facing error and retain bounded internal diagnostics.

### Requirement 7: Observability and compatibility diagnostics

**User Story:** As an operator, I want to know which translation decisions occurred without storing prompts or secrets, so that compatibility failures can be diagnosed quickly.

#### Acceptance Criteria

1. WHEN detection, normalization, adaptation, filtering, fallback, or cache projection occurs THEN the system SHALL record bounded structured diagnostics.
2. WHEN a request is persisted THEN diagnostics SHALL identify source format, target surface, field category, action, cache-key presence, breakpoint presence, selected provider/model, and fallback count without prompt contents or credentials.
3. WHEN a compatibility retry occurs THEN the diagnostic SHALL identify the rejected optional capability and retry outcome.
4. WHEN a request succeeds after fallback THEN the client SHALL receive the successful response rather than the intermediate provider error.
5. WHEN all compatible attempts fail THEN the client SHALL receive one stable error with a useful reason category, never an empty generic failure.

### Requirement 8: Test and rollout safety

**User Story:** As a maintainer, I want the standardization delivered incrementally, so that existing provider behavior remains usable during migration.

#### Acceptance Criteria

1. WHEN the unified pipeline is introduced THEN existing provider adapters SHALL be migrated behind contract-compatible interfaces.
2. WHEN a provider-specific quirk remains necessary THEN it SHALL be declared as data/policy rather than duplicated inline mutation logic.
3. WHEN a migration slice is complete THEN unit, translation-contract, transport-integration, stream-lifecycle, and provider smoke tests SHALL cover it.
4. WHEN a compatibility regression is detected THEN the system SHALL expose the failing source/target/provider combination in test diagnostics.
5. WHEN the rollout is complete THEN no adapter SHALL bypass canonical capability negotiation or final payload validation without an explicit, tested exception.
