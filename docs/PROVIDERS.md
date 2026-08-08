# Providers

## Adapter ownership

A provider adapter owns provider metadata, credential kind, models, capabilities, request construction, authentication headers, response/stream decoding, error classification, and optional quota transport.

Adapters do not own client API-key ACLs, account selection, client-surface translation, or console persistence.

## Capability matrix

| Capability | Meaning |
| --- | --- |
| `openai-chat` | OpenAI Chat semantics |
| `openai-responses` | Responses input/output items |
| `anthropic-messages` | Anthropic message blocks/events |
| `streaming` | Incremental upstream output |
| `tools` | Tool declarations, calls, and results |
| `reasoning` | Reasoning/thinking configuration or output |
| `images` | Image input, generation, or editing |

Capabilities are explicit metadata. A model name alone does not prove support.

## Authentication

API-key providers send account secrets through adapter-owned headers or body fields. OAuth providers use auth drivers for login, exchange, refresh, and revoke. Custom OpenAI/Anthropic-compatible providers can define endpoint URLs and headers, subject to SSRF and redirect validation.

Client API-key authentication and upstream provider authentication are separate: the client key authorizes Cartethyia to route; the selected account credential authorizes the provider call.

## Provider behavior

Provider documentation must record endpoint paths, required headers, token expiry, stream framing, tool/reasoning representation, quota/rate-limit status, retryability, image constraints, and model naming. Provider quirks belong in the adapter or codec, not in generic gateway branches.

## User agents and headers

Gateway-owned headers cover client authentication, request IDs, admission, and safety limits. Adapter-owned headers cover upstream authorization, client fingerprints, API versions, beta headers, and provider-specific fields. Never log authorization, cookies, API keys, OAuth tokens, or custom secret headers.

Some adapters intentionally emulate upstream client identities such as Claude Code, Grok Build, Kiro, or Qoder. This identity is upstream-facing and must not leak into client authentication.

## Quota fetchers

Provider quota fetchers live under `src/providers/quota/`. They authenticate with current account credentials, enforce timeout and response-size bounds, parse known provider fields, and return normalized snapshots or sanitized errors.

Scheduling, coalescing, persistence, cooldowns, and polling loops belong to `src/auth/`, not the fetcher.

## Custom providers

Custom providers define a stable ID, display name, protocol, endpoint, credential kind, optional headers, model metadata, and capabilities. They use the same URL safety, limits, translation, routing, and error handling as built-in adapters.

## Adding a provider

1. Add metadata and credential kind.
2. Implement the adapter contract.
3. Register it in the provider registry.
4. Add model metadata and capabilities.
5. Implement request and stream decoding.
6. Map errors into shared retryability and route scopes.
7. Add quota transport only for a stable provider quota API.
8. Add auth, headers, request, stream, error, and capability tests.
9. Update this document and the capability matrix.
