/**
 * Prompt-cache concern — marks the outgoing request so upstream can cache
 * the stable prefix, and normalizes the incoming usage accounting so callers
 * see one shape regardless of provider.
 *
 * Anthropic: explicit `cache_control: {type:"ephemeral"}` on the last stable
 * content block (system/tools/message) marks everything up to and including
 * that block as one cacheable prefix. Usage comes back as
 * `cache_creation_input_tokens` / `cache_read_input_tokens`.
 *
 * OpenAI: caching is automatic on the longest matching prefix — nothing to
 * mark on the request. Usage comes back as
 * `usage.prompt_tokens_details.cached_tokens` (read) and, on GPT-5.6+,
 * `usage.cache_write_tokens` (write).
 *
 * A cache breakpoint is only worth paying the 1.25x write premium for if the
 * prefix is actually stable across calls — a block containing a timestamp or
 * a UUID changes every request and would just burn the write premium with
 * zero future reads.
 */

import type { UnifiedMessage } from "./blocks";
import { isTextBlock } from "./blocks";

const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Anthropic requires ~1024+ tokens for a breakpoint to be worth it; approximate via chars (~4 chars/token). */
const MIN_CACHEABLE_CHARS = 1024 * 4;

export function looksCacheable(text: string): boolean {
  return text.length >= MIN_CACHEABLE_CHARS && !TIMESTAMP_RE.test(text) && !UUID_RE.test(text);
}

export interface NormalizedCacheUsage {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshInputTokens: number;
}

export function normalizeAnthropicUsage(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): NormalizedCacheUsage {
  return {
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    freshInputTokens: usage.input_tokens,
  };
}

export function normalizeOpenAIUsage(usage: {
  prompt_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_write_tokens?: number;
}): NormalizedCacheUsage {
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    cacheReadTokens,
    cacheWriteTokens: usage.cache_write_tokens ?? 0,
    freshInputTokens: Math.max(0, usage.prompt_tokens - cacheReadTokens),
  };
}

// ── Applying the breakpoint ───────────────────────────────────────────────


export interface CacheBreakpointResult {
  system: string | undefined;
  systemCached: boolean;
  messages: UnifiedMessage[];
}

/**
 * Tag the single best cache breakpoint: prefer the system prompt (it's the
 * most stable, reused-every-call prefix); fall back to the last text block
 * of the last message if there's no cacheable system prompt. Anthropic's
 * breakpoint semantics cover everything UP TO AND INCLUDING the tagged
 * block, so tagging exactly one block is sufficient — this never tags more
 * than one.
 */
export function applyCacheBreakpoint(system: string | undefined, messages: UnifiedMessage[]): CacheBreakpointResult {
  if (system !== undefined && looksCacheable(system)) {
    return { system, systemCached: true, messages };
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    for (let j = msg.blocks.length - 1; j >= 0; j--) {
      const block = msg.blocks[j]!;
      if (isTextBlock(block) && looksCacheable(block.text)) {
        const nextMessages = messages.slice();
        const nextBlocks = msg.blocks.slice();
        nextBlocks[j] = { ...block, cache: true };
        nextMessages[i] = { ...msg, blocks: nextBlocks };
        return { system, systemCached: false, messages: nextMessages };
      }
    }
  }

  return { system, systemCached: false, messages };
}
