import { findCacheBreakpoint, supportsOpenAIPromptBreakpoints } from "../../../application/cache";
import type { NormalizedMessage, ProxyRequest } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";

const EXPLICIT_CACHE_BREAKPOINT = { mode: "explicit" } as const;

/** Applies OpenAI Chat explicit prompt-cache metadata at the selected text block. */
export function applyOpenAIChatCacheBreakpoint(payload: Record<string, unknown>, request: ProxyRequest): void {
  if (!supportsOpenAIPromptBreakpoints(request.model) || request.cacheKey === undefined) return;
  const position = findCacheBreakpoint(request);
  if (position === null) return;
  if (payload.prompt_cache_options === undefined) payload.prompt_cache_options = { ...EXPLICIT_CACHE_BREAKPOINT, ttl: "30m" };
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  const message = messages[position.messageIndex];
  if (!isRecord(message)) return;
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    message.content = [{ type: "text", text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT }];
    return;
  }
  if (!Array.isArray(content)) return;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block) || block.type !== "text") continue;
    content[index] = { ...block, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT };
    return;
  }
}

/** Applies OpenAI Responses explicit prompt-cache metadata to a message's input items. */
export function applyOpenAIResponsesCacheBreakpoint(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  itemsForMessage: (message: NormalizedMessage) => readonly Record<string, unknown>[],
): void {
  if (!supportsOpenAIPromptBreakpoints(request.model) || request.cacheKey === undefined) return;
  const position = findCacheBreakpoint(request);
  if (position === null) return;
  if (payload.prompt_cache_options === undefined) payload.prompt_cache_options = { ...EXPLICIT_CACHE_BREAKPOINT, ttl: "30m" };
  const input = payload.input;
  if (!Array.isArray(input)) return;
  let wireIndex = 0;
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    const items = itemsForMessage(message);
    if (messageIndex === position.messageIndex) {
      for (let offset = 0; offset < items.length; offset += 1) {
        const candidate = input[wireIndex + offset];
        if (!isRecord(candidate) || (candidate.role !== "system" && candidate.role !== "developer" && candidate.role !== "user")) continue;
        const content = candidate.content;
        if (typeof content === "string" && content.length > 0) {
          candidate.content = [{ type: "input_text", text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT }];
          return;
        }
        if (!Array.isArray(content)) continue;
        for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
          const block = content[blockIndex];
          if (!isRecord(block) || block.type !== "input_text") continue;
          content[blockIndex] = { ...block, prompt_cache_breakpoint: EXPLICIT_CACHE_BREAKPOINT };
          return;
        }
      }
      return;
    }
    wireIndex += items.length;
  }
}
