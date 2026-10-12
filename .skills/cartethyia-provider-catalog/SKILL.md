---
name: cartethyia-provider-catalog
description: "Add, remove, import, authenticate, or curate a provider or model. Use for adapters, OAuth/BYOK flows, base-models.json catalog rows, /v1/models, capabilities, and availability claims."
---

# Provider and catalog

Use for adding, removing, importing, authenticating, probing, or curating
providers and models.

## Add a bundled provider

1. Identify the metadata, registry, adapter, auth, catalog, and quota
   authorities.
2. Add only the provider-specific pieces required by the existing integration
   family.
3. Preserve required headers, user-agent, body shape, endpoint path, and
   streaming format.
4. Update intentional dashboard mirrors, config, docs, and `.env.example`.
5. Verify through the real composition root, not isolated stubs.

Do not invent capabilities, pricing, limits, or availability when upstream is
silent. A catalog row is not proof that a model answers.

## OAuth and account flows

Redirect URIs must exactly match the allowlist. Refresh-only, device, browser,
cookie, and imported-credential flows have different boundaries; follow the
existing family. Keep credentials server-side and redact them from logs and
payload capture.

For OAuth, verify the real browser callback, state single-use behavior,
persistence, refresh registration, and one real request through the account when
safe.

## BYOK and custom providers

Derive the wire contract from the compatibility profile. Validate base URL,
model, auth, allowed wire families, and network policy at the server boundary.
Dashboard forms submit data; they do not implement auth or routing policy.

`resolveByokWireProfile` (`src/providers/operations/byok-wire-profile.ts`) is the
authority. Do not re-hardcode authentication or wire-family mappings in
registration, discovery, or connection-test paths.

## Model catalog

- OpenCode Zen is id-oriented; models.dev carries rich metadata.
- `src/providers/discovery/base-models.json` is the offline catalog authority.
- Provider-id remaps live in `MODELS_DEV_PROVIDER_IDS`
  (`src/providers/discovery/models-dev-catalog.ts`).
- `/v1/models` omits unavailable optional fields rather than emitting null.
- Capabilities are normalized to `text | image | audio | video | pdf` at
  emission.
- Pool capabilities and pricing are claims about every member, not one member.
- Catalog presence is not availability; use an authorized real probe.

## Image generation

`POST /v1/images/generations` is a separate service from chat. The route is
declared in `src/transport/contracts.ts`, and `createGenerationHandler` prefers
`adapter.generateImage` over `dispatchNativeService`. Shared prompt and result
helpers live in `src/protocol/image-generation.ts`.

Do not borrow the chat turn envelope for an image request. Codex chat owns
`canonicalToCodexResponsesPayload`, `buildCodexIdentityHeaders`, turn metadata,
routing hints, and `client_metadata`. Image generation posts its own body.

| Provider | Wire |
|---|---|
| Gemini | `POST {base}/models/{model}:generateContent` with `x-goog-api-key` and `generationConfig.responseModalities: ["IMAGE"]`. Read `inlineData` through `geminiInlineImages`. |
| Antigravity | Stream `POST {base}/v1internal:streamGenerateContent?alt=sse` with the agent envelope, image system instruction, `responseModalities: ["IMAGE"]`, and the existing sandbox failover. Decode SSE with `maxEventBytes: 32 * 1024 * 1024`. |
| Codex | Stream `POST {base}/backend-api/codex/responses`. A `-image` id strips that suffix and becomes the carrier. A dedicated image id uses carrier `gpt-5.6-terra` and names itself as the tool model. Send `tools: [{ type: "image_generation", ... }]`, `tool_choice: { type: "image_generation" }`, `store: false`, and `stream: true`. |

Codex image headers are the hosted set: auth, user-agent, `originator`,
`version`, `[OI]-Beta: responses=experimental`, `session_id`,
`conversation_id`, account id, and residency. Do not send the chat turn headers.

A catalog row is not an entitlement. When you have an authorized account and
probe, replay the provider directly before changing the body:

- `gpt-image-*` can be rejected for a ChatGPT account.
- Forcing the image tool can return `Tool choice 'image_generation' must be specified with 'tools' parameter` even when `tools` is present.
- Leaving the tool optional can return 200 and ignore it.
- A plain chat request returns text, not an image.
- A missing `api.model.images.request` scope, or a 404 from an image endpoint, is an account boundary.

Prove an image by decoded magic bytes: `89 50 4E 47` for PNG or `FF D8 FF` for
JPEG. `content_signature` and a text reply are not images. Gemini stays
unverified until a Gemini account exists. These upstream rejection examples
are account- and deployment-specific observations, not guarantees; confirm
them against the authorized account before changing a request. After a catalog
edit, restart the process; `bun --hot` can keep a cached adapter, and
`dist/cartethyia.exe` can keep answering on `:12800`.

## Grok video generation

These are unverified upstream research notes, not a supported Cartethyia video
integration. The checked-in Grok adapter targets Grok Build at
`cli-chat-proxy.grok.com`, and this repository does not implement the SSO/DPoP
video flow described below. Do not treat these endpoints or field names as a
gateway implementation recipe without a fresh, authorized probe.

The previously observed free-video surface was the developer console:

- `POST https://console.x.ai/v1/videos/generations` returns `request_id`.
- `GET https://console.x.ai/v1/videos/<request_id>` returns status and `video.url`.
- The model is `grok-imagine-video`. Duration is 1–15 seconds. One `image.url`
  may be an HTTPS URL or a `data:` URL, never bare base64.

The reported authentication was an SSO cookie plus DPoP, not the stored Grok
Build OAuth token. The reported procedure minted `POST /v1/dpop/token` with a
fresh P-256 JWK, then signed one ES256 proof per request using raw `r || s` and
an `htu` containing scheme, host, and path only. Those details and the
approximately 300-second token lifetime have not been verified by this
repository; re-check them before use. A stored `oauth` credential must not be
assumed to work on this separate surface.

The reported quota was about two videos followed by HTTP 429
`resource-exhausted`; this is not a guaranteed limit. Track video exhaustion
separately if implementing the feature. A catalog row is not an entitlement,
and a 200 chat response is not a video. Verify the returned MP4 URL or bytes
including the `ftyp` box rather than accepting a status alone.

## Remove a provider

Use the [provider-removal skill](../cartethyia-provider-removal/SKILL.md). It
owns the cutover and persisted-row cleanup. Boot retires unbundled global rows;
the catalog also hides any orphan immediately and lets tenant delete remove
it without exposing a current builtin to deletion.

## Verify

The gate list is the
[engineering verification reference](../cartethyia-engineering/references/verification.md);
run those, plus `bun run test:backend`.

The boundary specific to this skill is upstream: exercise the real auth,
catalog, and request boundaries when safe. If credentials or upstream access are
unavailable, say so instead of claiming availability.
