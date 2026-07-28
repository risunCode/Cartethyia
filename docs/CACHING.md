# Prompt caching

Implementation: `translate/concerns/cache.ts`. Toggle:
`CACHE_MARKERS_ENABLED` env var (default `true`).

## Why this needs handling at all

Anthropic requires an explicit `cache_control: {type:"ephemeral"}` marker on
the request to opt a prefix into caching; OpenAI caches automatically on the
longest matching prefix with nothing to mark. So there's real work only on
the Anthropic-upstream side (`openai-to-anthropic.ts`, `responses-to-openai.ts`
→ `openai-to-anthropic.ts`) — OpenAI-upstream requests need no request-side
change, only usage normalization on the way back.

## Choosing what to mark

`applyCacheBreakpoint(system, messages)`:

1. If the system prompt is `looksCacheable`, tag it — it's the most stable,
   reused-every-call prefix, so it's always the best candidate when eligible.
2. Otherwise scan messages from the END backward, tag the last text block
   that's `looksCacheable`.
3. Exactly one block is ever tagged. Anthropic's breakpoint semantics cover
   everything UP TO AND INCLUDING the tagged block, so one tag is sufficient
   — tagging more would just spend the write premium on prefixes that are
   already covered by the outermost tag.

`looksCacheable(text)` gates on two things:

- **Size** — `>= 4096` chars (~1024 tokens at ~4 chars/token, Anthropic's
  minimum for cache write to be worth it at all).
- **Stability** — rejects text containing what looks like an ISO timestamp
  (`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`) or a UUID. A cache breakpoint is
  only worth the 1.25x write-token premium if the prefix is IDENTICAL across
  calls; a block containing a per-request timestamp or request-id changes
  every call and would burn the premium for zero future cache reads.

This is a heuristic, not a guarantee — a client can still send unstable text
that doesn't match either pattern. It catches the common cases (system
prompts with `Generated at ...` or a request UUID baked in) cheaply, without
needing per-field cache-policy configuration from the caller.

## Usage normalization

Anthropic and OpenAI report cache accounting under different field names;
`normalizeAnthropicUsage`/`normalizeOpenAIUsage` map both into one shape:

```ts
interface NormalizedCacheUsage {
  cacheReadTokens: number;   // tokens served from cache
  cacheWriteTokens: number;  // tokens newly written to cache this call
  freshInputTokens: number;  // tokens that were neither
}
```

| | cache read | cache write | fresh input |
|---|---|---|---|
| Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens` | `input_tokens` (already excludes cache) |
| OpenAI | `usage.prompt_tokens_details.cached_tokens` | `usage.cache_write_tokens` (GPT-5.6+) | `prompt_tokens - cached_tokens`, floored at 0 |

Both directions' response translators (`translateAnthropicResponseToChat`,
`translateChatResponseToMessages`, and their streaming equivalents in
`upstream/bridge.ts`'s `usageEventFrom`) go through this shape before
re-encoding into the client's expected usage field names, so a client sees
one consistent accounting regardless of which upstream actually served the
request.
