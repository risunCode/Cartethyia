# Protocols, Translation, Tools, Streaming, and Prompt Caching

Cartethyia keeps client protocol shape separate from provider destination.
Translation is performed at the edges around one normalized Go request model.

## 1. Protocol roles

```text
client wire format
    - OpenAI Chat Completions
    - OpenAI Responses
    - Anthropic Messages
    - image request surface
          |
          v
normalized Cartethyia request
    - messages/content
    - tools/tool choice
    - reasoning
    - response format
    - stream intent
    - cache identity
          |
          v
provider wire format
    - OpenAI-compatible JSON
    - Anthropic JSON
    - provider-specific adapter format
```

The active contracts live under:

```text
daemon/internal/proxy/protocol/contracts/
daemon/internal/proxy/protocol/transforms/
```

A client protocol does not expose credentials and does not choose the provider
by itself.

## 2. Active external surfaces

```text
POST /v1/chat/completions       OpenAI Chat Completions
POST /v1/responses              OpenAI Responses
POST /v1/messages               Anthropic Messages
POST /v1/images/generations     OpenAI image generation
POST /v1/images/edits           OpenAI image edits
```

The normalized source surface is retained so the response encoder can preserve
surface-specific behavior. Responses and Chat are not interchangeable wire
formats even when they share model/provider routing.

## 3. Translation stages

```text
+-------------------------+
| ingress decoder         |
| bounded client JSON     |
+------------+------------+
             v
+-------------------------+
| normalization            |
| roles, blocks, tools,    |
| reasoning, usage intent  |
+------------+------------+
             v
+-------------------------+
| route target             |
| provider + model +      |
| upstream surface        |
+------------+------------+
             v
+-------------------------+
| provider encoder        |
| exact upstream payload  |
+------------+------------+
             v
+-------------------------+
| provider decoder        |
| body/events/usage       |
+------------+------------+
             v
+-------------------------+
| client encoder           |
| JSON or stream events    |
+-------------------------+
```

Unsupported content or provider-native features produce a stable unsupported
feature/translation error. Semantics must not be silently dropped to make a
request appear successful.

The provider encoder owns wire-only fields. Cache markers, provider-specific
headers, reasoning controls, and provider-native tool fields must be added only
where the selected adapter declares the capability.

## 4. Canonical content and reasoning

The normalized model represents:

- system, developer, user, assistant, and tool roles;
- text, image, tool-use, tool-result, reasoning, compaction, native, and unknown
  content blocks;
- opaque reasoning signatures/encrypted reasoning content;
- reasoning effort, summary, mode, context, max tokens, enabled, and exclude
  controls;
- response format and JSON schema;
- image references by URL, data, or file kind;
- provider-native payloads only where an adapter explicitly preserves them.

Unknown values remain distinguishable from empty values. A provider decoder may
retain bounded raw metadata for round-trip behavior, but raw bodies do not enter
observability or dashboard state.

## 5. Tool calling

```text
client tool definition
        |
        v
bounded name/schema validation
        |
        v
normalized Tool
        |
        v
provider tool encoder
        |
        v
model tool call
        |
        v
application policy boundary
        |
        v
bounded tool result
```

Rules:

- tool names and schemas are bounded before translation;
- arguments are treated as JSON text at the canonical boundary;
- provider-native tools are marked with their native type and rejected by
  incompatible encoders instead of being corrupted;
- tool execution is an application policy decision, not an automatic action
  granted by a model response;
- tool arguments/results are not lifecycle evidence or dashboard state;
- unsupported tool combinations return a stable translation error.

## 6. Streaming

```text
provider chunk/event
        |
        v
normalized event
        |
        +--> OpenAI Chat chunk
        +--> OpenAI Responses event
        +--> Anthropic content event
```

The stream contract preserves:

- event order;
- tool-call IDs and fragments;
- reasoning deltas and opaque signatures;
- usage on terminal/final events;
- stop reason and terminal state;
- cancellation and upstream close behavior.

A client disconnect cancels upstream work. A malformed upstream event or stream
stall becomes a typed stream failure. A partial response is not promoted to a
successful empty response.

## 7. Provider capability resolution

Provider metadata declares capabilities such as:

```text
surface support
streaming
reasoning
tool calls
prompt-cache key
explicit cache marker
web search
media generation
```

The router filters candidates with these capabilities before provider
translation. An adapter must not emit a provider field just because another
provider supports it.

## 8. Upstream prompt caching

Prompt caching is provider-side optimization, not the Redis resolution cache.
The exact provider payload must exist before adding the cache marker.

```text
normalized request
        |
        v
translated provider payload
        |
        v
stable prefix calculation
        |
        +--> provider cache key when supported
        +--> explicit breakpoint when supported and eligible
        +--> normal payload when unsupported/ineligible
```

Stable prefix content generally includes:

- system/developer instructions;
- tool definitions and schemas;
- shared context;
- unchanged history;
- deterministic serialization.

Changing content belongs after the boundary:

- current user message;
- timestamps;
- request/trace IDs;
- random IDs/nonces;
- dynamic tool results;
- temporary account/session suffixes.

### OpenAI-compatible adapters

When capability and model policy allow it, adapters can emit:

```json
{
  "prompt_cache_key": "stable-provider-scoped-key"
}
```

For eligible models with a sufficiently large stable prefix, the adapter may
also emit the provider's explicit breakpoint and explicit mode. If the stable
prefix is below the provider minimum, keep the key when supported but omit the
breakpoint rather than generating an invalid request.

### Anthropic adapters

When explicit cache capability is enabled, the adapter may add:

```json
{
  "cache_control": {
    "type": "ephemeral"
  }
}
```

The marker belongs to a cacheable translated block. Native server tools must
not receive a marker unless their provider contract explicitly supports it.

### Cache status

Only bounded metadata may be recorded:

```text
cache_supported: true | false | unknown
cache_marked: true | false
cache_status: hit | miss | unknown
cache_read_tokens: number | null
cache_write_tokens: number | null
```

Never log the key, stable prefix, prompt, tool arguments, credentials, or full
provider payload. Cache marking failures fail open to the normal provider
request and report `unknown` rather than a fabricated hit.

## 9. Local RTK token saver

The local RTK implementation is isolated under:

```text
daemon/internal/proxy/compression/
```

It contains bounded smart filters and a fail-open token-saving pipeline. It is
not an upstream prompt-cache marker, not Redis, and not Headroom. In the current
2.1.0 checkpoint it is a reusable package, not an automatically inserted stage
of the active dispatch path. Do not assume every `/v1/*` request is compressed.

## 10. Adding a protocol or provider

1. Define the client surface and upstream provider separately.
2. Add/extend normalized contracts before adding wire fields.
3. Add capability declarations and reject unsupported combinations explicitly.
4. Implement request and response translation at protocol edges.
5. Preserve stream order, IDs, usage, stop reason, and cancellation.
6. Add provider cache marking only after the exact wire payload is available.
7. Add malformed input, unsupported feature, cache miss, account scope, stream,
   and redaction tests.
8. Keep provider secrets and raw payloads out of evidence.
