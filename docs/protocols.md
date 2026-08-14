# Protocols, Translation, Tools, and Upstream Caching

## Protocol roles

```text
+---------------------------+
| Client protocol shape     |
| OpenAI Chat / Responses   |
| Anthropic Messages        |
+-------------+-------------+
              v
+---------------------------+
| Normalized Cartethyia     |
| request/content/tools     |
+-------------+-------------+
              v
+---------------------------+
| Provider wire format      |
| OpenAI / Anthropic /      |
| configured adapter        |
+---------------------------+
```

Client protocol and provider destination are separate concepts. An OpenAI-shaped client request may route to any compatible configured provider adapter.

## Supported surface concepts

The normalized surface identifies the client contract:

```text
openai-chat
openai-responses
anthropic-messages
images
web-search (when configured)
```

The surface does not expose credentials or decide the upstream provider by itself.

## Translation stages

```text
+---------------------------+
| Ingress adapter           |
| client JSON/events        |
+-------------+-------------+
              v
+---------------------------+
| Normalize                 |
| messages, content, tools, |
| stream intent, model      |
+-------------+-------------+
              v
+---------------------------+
| Provider encoder         |
| provider-specific JSON   |
| and cache markers        |
+-------------+-------------+
              v
+---------------------------+
| Provider decoder         |
| response/events/usage    |
+-------------+-------------+
              v
+---------------------------+
| Egress adapter            |
| client JSON/events        |
+---------------------------+
```

Unsupported content or provider-native features must produce a stable `translation.unsupported_feature` style error. Do not silently drop semantics.

## Tool calling

```text
+---------------------------+
| Client tool definition    |
+-------------+-------------+
              v
+---------------------------+
| Validate name/schema      |
+-------------+-------------+
              v
+---------------------------+
| Normalized Tool           |
+-------------+-------------+
              v
+---------------------------+
| Provider tool encoding    |
+-------------+-------------+
              v
+---------------------------+
| Model tool call           |
+-------------+-------------+
              v
+---------------------------+
| Application policy        |
| allow/deny tool execution |
+-------------+-------------+
              v
+---------------------------+
| Bounded tool result       |
+---------------------------+
```

Cartethyia normalizes and routes tool calls. It must not execute an arbitrary model-requested tool without an explicit application policy boundary.

Tool schemas, arguments, and results are bounded. Full tool arguments/results do not enter dashboard state or lifecycle evidence.

## Streaming

Streaming preserves order and call IDs:

```text
provider chunk
     |
     v
normalized delta/event
     |
     +--> OpenAI Chat chunk
     +--> OpenAI Responses event
     +--> Anthropic content event
```

Cancellation closes the upstream stream and emits a terminal cancellation outcome. A partial stream must not become a successful empty response.

## Always request upstream caching

**Policy:** every provider adapter must request upstream prompt caching whenever that provider/model supports it. Do not add a local cache layer as a substitute for this request marker.

```text
+---------------------------+
| Normalized request        |
+-------------+-------------+
              v
+---------------------------+
| Stable prefix             |
| system, tools, shared     |
| context, stable history  |
+-------------+-------------+
              v
+---------------------------+
| Provider cache marker     |
| OpenAI: prompt_cache_key  |
| + explicit breakpoint     |
| Anthropic: cache_control  |
| type = ephemeral          |
+-------------+-------------+
              v
+---------------------------+
| Upstream request          |
+---------------------------+
```

The marker is an optimization. The request remains valid when the provider does not support caching or the cache misses.

### Provider fields

| Provider | What Cartethyia sends |
| --- | --- |
| OpenAI, GPT-5.6 family | `prompt_cache_key` on every eligible request; Responses gets an explicit breakpoint after stable developer/input content; Chat Completions gets the equivalent stable system/developer breakpoint; use explicit mode only when a safe breakpoint exists |
| OpenAI, earlier supported models | `prompt_cache_key` when supported; automatic caching otherwise; do not send GPT-5.6-only breakpoint fields |
| Anthropic Messages | top-level `cache_control: { "type": "ephemeral" }`; provider moves the automatic breakpoint to the last cacheable block |
| Unsupported provider/model | No invented cache field; send the normal request |

`ephemeral` is the Anthropic name. It is not the OpenAI field name. OpenAI uses prompt-cache fields such as `prompt_cache_key` and `prompt_cache_breakpoint`.
### OpenAI GPT-5.6 family

GPT-5.6 is stricter than older OpenAI models:

```text
Responses / Chat Completions
        |
        v
exact stable prefix
        |
        +--> prompt_cache_key required for reliable matching
        +--> explicit breakpoint at stable boundary
        +--> prompt_cache_options.mode = explicit
        |
        v
changing user/request suffix
```

Rules:

- the rendered prefix through the breakpoint must reach the provider's 1,024-token minimum;
- the key and prefix must match exactly;
- Responses marks `input_text` inside a stable developer/system input item;
- Chat Completions marks `text` inside a stable system/developer message;
- `instructions` at the top level cannot carry an explicit breakpoint; use a developer input item when an explicit Responses breakpoint is needed;
- if the stable prefix is too short, send `prompt_cache_key` but omit the explicit marker instead of risking an invalid request;
- use explicit-only mode when the changing suffix should not create a second cache write;
- monitor `cached_tokens` and `cache_write_tokens`.

The implementation uses a conservative byte estimate before adding the explicit marker. That avoids emitting a GPT-5.6 breakpoint for a prefix that is obviously below the upstream minimum.

### OpenAI Chat Completions and Responses

Both surfaces use the same cache policy, but the marker location differs:

```text
Chat Completions:
messages[
  { role: system/developer,
    content: [{ type: text, prompt_cache_breakpoint: ... }]
  }
]

Responses:
input[
  { role: developer/system,
    content: [{ type: input_text, prompt_cache_breakpoint: ... }]
  }
]
```

Responses is preferred for new integrations. Chat Completions remains supported with the equivalent stable-prefix marker.

### Anthropic Messages

Anthropic uses automatic prompt caching:

```json
{
  "cache_control": {
    "type": "ephemeral"
  }
}
```

Anthropic caches `tools`, then `system`, then `messages` up to the automatic breakpoint. The provider silently skips caching when the prompt is below the model/platform minimum. Usage fields distinguish:

```text
cache_read_input_tokens
cache_creation_input_tokens
```

Anthropic cache isolation is workspace/organization dependent. A different account is reusable only when it resolves to the same upstream workspace/cache scope.

### What stays stable

Put reusable content before the cache breakpoint:

- system/developer instructions;
- tool definitions and schemas;
- shared context;
- unchanged conversation history;
- deterministic serialization.

Put changing content after the breakpoint:


- current user message;
- timestamps;
- request/trace IDs;
- random UUIDs/nonces;
- dynamic tool results;
- temporary session/credential suffixes.

The marker must be added **after translation has built the exact provider payload**. That prevents the adapter from marking a boundary that does not exist on the wire.

### Cache key and routing

The cache key must be stable for requests that should reuse the same upstream prefix:

```text
cache key = provider cache scope + model + stable prompt profile
```

The network proxy is not part of the cache key. Changing Cartethyia's network proxy does not change the upstream prompt prefix.

Changing the Cartethyia account is safe only when both accounts resolve to the same upstream cache scope. “Same upstream URL” alone is not enough: providers may isolate caches by organization, project, workspace, or account. If the cache scope changes, use a different key and expect a miss.

For OpenAI, the official behavior is exact prefix matching plus `prompt_cache_key`; caches are not shared between organizations. Therefore:

```text
same provider + same cache scope + same model + same key + same prefix
    -> eligible for cache reuse

same provider URL but different organization/project scope
    -> do not assume cache reuse
```

### Anti-miss rules

1. Always add the marker when capability says it is supported.
2. Keep the stable prefix byte-for-byte deterministic.
3. Keep the same `prompt_cache_key` for the same stable prompt profile.
4. Never put timestamps, UUIDs, request IDs, or changing tool results before the breakpoint.
5. Keep tool order, schemas, model, and relevant settings identical.
6. Do not include Cartethyia proxy identity in the key.
7. Do not assume an account switch preserves cache scope.
8. Parse `cached_tokens` and `cache_write_tokens` when upstream returns them.
9. Record `hit`, `miss`, or `unknown`; never manufacture a hit.

### Cost and latency

On a cache hit, the provider can avoid reprocessing the cached prefix, reducing latency and input-token cost. Cache writes and retention may have provider-specific pricing. Cache marking does not make output generation free and does not guarantee a hit.

### Evidence

Record only bounded cache metadata:

```text
cache_supported: true/false/unknown
cache_marked: true/false
cache_status: hit/miss/unknown
cache_read_tokens: number/null
cache_write_tokens: number/null
```

Never log the key, stable prefix, prompt, tool arguments, credentials, or provider payload.

### If marking fails

If marker construction fails but the request is otherwise valid, send the normal provider request and record `cache_status=unknown`. A cache failure must not become a request failure and must not be reported as a successful cache hit.

## Adding a new protocol/provider

1. Define client surface and provider capability separately.
2. Normalize content, tools, streaming, usage, and errors.
3. Add always-on capability-gated cache marking.
4. Add stable-prefix, account-scope, proxy-change, and cache-miss tests.
5. Add unsupported-feature tests.
6. Add bounded cache evidence without raw payloads.

## Official provider references

- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
