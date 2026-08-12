import type { CacheIntent, NormalizedMessage, ProxyRequest, NormalizedTool } from "./contracts";

/**
 * Automatic, always-on section cache marking.
 *
 * Classifies a normalized request's content into stable and dynamic
 * sections in provider-neutral terms; adapters map the resulting plan to
 * their native marker (Anthropic `cache_control`, OpenAI `prompt_cache_key`,
 * or no-op). There is deliberately no toggle, config row, or persisted
 * content anywhere in this module: it is a pure in-memory classification.
 *
 * Section order: system/developer instructions -> tools and schemas ->
 * static context -> stable history -> dynamic history/current turn. Only the
 * last safe reusable prefix may receive a provider marker; dynamic
 * timestamps, secrets, mutable tool results, and unstable content stay after
 * the cache boundary.
 */
export type CacheSectionKind = "system" | "developer" | "tools" | "static_context" | "stable_history" | "dynamic";

export interface CacheSection {
  readonly kind: CacheSectionKind;
  /** Message index in the normalized request; null only for the tools section. */
  readonly messageIndex: number | null;
  /** Content-block index within that message; null for the tools section. */
  readonly blockIndex: number | null;
  readonly stable: boolean;
  /** Bounded character length (text blocks) or serialized size (tools). */
  readonly charLength: number;
}

export interface CachePlan {
  readonly sections: readonly CacheSection[];
  /** Non-empty tool list: tools and schemas are a stable prefix. */
  readonly toolsStable: boolean;
  readonly hasStablePrefix: boolean;
  /** Position (inclusive) of the last stable cacheable block, or null. */
  readonly prefixEndMessageIndex: number | null;
  readonly prefixEndBlockIndex: number | null;
  /** Bounded digest of the stable prefix; never content, never persisted. */
  readonly prefixFingerprint: string | null;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PEM_BLOCK = /-----BEGIN [A-Z][A-Z ]*-----/;

function stablePrefixText(text: string): string | null {
  const matches = [ISO_TIMESTAMP.exec(text), UUID.exec(text), PEM_BLOCK.exec(text)]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((left, right) => left.index - right.index);
  const firstVolatileIndex = matches[0]?.index ?? text.length;
  const prefix = text.slice(0, firstVolatileIndex).trimEnd();
  return prefix.length >= 128 ? prefix : null;
}

/**
 * Stability heuristic for cacheable text: rejects per-request timestamps,
 * UUIDs, and embedded private keys, which break prefix identity across calls.
 */
export function looksStableText(text: string): boolean {
  if (ISO_TIMESTAMP.test(text)) return false;
  if (UUID.test(text)) return false;
  if (PEM_BLOCK.test(text)) return false;
  return true;
}

export function markCacheSections(request: ProxyRequest): readonly CacheSection[] {
  const sections: CacheSection[] = [];
  let sawAssistant = false;
  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i];
    if (message === undefined) continue;
    if (message.role === "assistant") sawAssistant = true;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block === undefined) continue;
      const cacheableRole = message.role === "system" || message.role === "developer" || message.role === "user" || message.role === "assistant";
      const isText = block.type === "text" && block.text !== undefined;
      const stable = cacheableRole && isText && looksStableText(block.text ?? "");
      sections.push({
        kind: sectionKind(message.role, sawAssistant),
        messageIndex: i,
        blockIndex: j,
        stable,
        charLength: block.text?.length ?? 0,
      });
    }
  }
  if (request.tools.length > 0) {
    sections.splice(insertionIndex(sections), 0, {
      kind: "tools",
      messageIndex: null,
      blockIndex: null,
      stable: true,
      charLength: toolsCharLength(request.tools),
    });
  }
  return sections;
}

export function applyCachePlan(request: ProxyRequest, plan: CachePlan, affinityKey?: string | null): ProxyRequest {
  if (!plan.hasStablePrefix || plan.prefixFingerprint === null) return request;
  const cacheKey = request.cacheKey ?? fnv1a64([plan.prefixFingerprint, request.model, request.sourceSurface, affinityKey ?? "anonymous"]);
  const cacheIntent: CacheIntent = {
    key: cacheKey,
    stablePrefixFingerprint: plan.prefixFingerprint,
    affinityKey: affinityKey ?? null,
    policy: "automatic",
    ttl: null,
  };
  if (plan.prefixEndMessageIndex === null || plan.prefixEndBlockIndex === null) {
    return { ...request, cacheKey, cacheIntent };
  }
  const targetMsgIdx = plan.prefixEndMessageIndex;
  const targetBlkIdx = plan.prefixEndBlockIndex;
  const targetMsg = request.messages[targetMsgIdx];
  if (targetMsg === undefined) return { ...request, cacheKey, cacheIntent };
  const targetBlk = targetMsg.content[targetBlkIdx];
  if (targetBlk === undefined) return { ...request, cacheKey, cacheIntent };
  const messages = request.messages.map((message, messageIndex) => {
    if (messageIndex !== targetMsgIdx) return message;
    const content = message.content.flatMap((block, blockIndex) => {
      if (blockIndex !== targetBlkIdx || block.type !== "text" || block.text === undefined) return [block];
      const stablePrefix = stablePrefixText(block.text);
      if (stablePrefix === null || stablePrefix.length === block.text.length) return [{ ...block, cacheControl: "ephemeral" as const }];
      const suffix = block.text.slice(stablePrefix.length).trimStart();
      return [
        { ...block, text: stablePrefix, cacheControl: "ephemeral" as const },
        ...(suffix.length === 0 ? [] : [{ ...block, text: suffix, cacheControl: undefined }]),
      ];
    });
    return { ...message, content };
  });
  return { ...request, messages, cacheKey, cacheIntent };
}

export interface CacheBreakpointPosition {
  readonly messageIndex: number;
  readonly blockIndex: number;
}

/**
 * Finds the latest text block that can carry an explicit provider cache
 * breakpoint. Assistant/tool suffixes fall back to the nearest earlier
 * system, developer, or user text block because OpenAI only accepts
 * breakpoints on input content blocks.
 */
export function findCacheBreakpoint(request: ProxyRequest): CacheBreakpointPosition | null {
  let targetMessageIndex: number | null = null;
  let targetBlockIndex: number | null = null;
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      if (message.content[blockIndex]?.cacheControl === "ephemeral") {
        targetMessageIndex = messageIndex;
        targetBlockIndex = blockIndex;
        break;
      }
    }
    if (targetMessageIndex !== null) break;
  }
  if (targetMessageIndex === null || targetBlockIndex === null) return null;
  for (let messageIndex = targetMessageIndex; messageIndex >= 0; messageIndex -= 1) {
    const message = request.messages[messageIndex];
    if (message === undefined || (message.role !== "system" && message.role !== "developer" && message.role !== "user")) continue;
    const start = messageIndex === targetMessageIndex ? targetBlockIndex : message.content.length - 1;
    for (let blockIndex = start; blockIndex >= 0; blockIndex -= 1) {
      if (message.content[blockIndex]?.type === "text") return { messageIndex, blockIndex };
    }
  }
  return null;
}

/** GPT-5.6+ accepts explicit OpenAI prompt cache breakpoints. */
export function supportsOpenAIPromptBreakpoints(model: string): boolean {
  const match = /(?:^|\/)gpt-5\.(\d+)(?:$|[-.])/i.exec(model);
  return match !== null && Number.parseInt(match[1] ?? "0", 10) >= 6;
}

export function buildCachePlan(request: ProxyRequest): CachePlan {
  const sections = markCacheSections(request);
  const prefixText: string[] = [];
  let prefixEndMessageIndex: number | null = null;
  let prefixEndBlockIndex: number | null = null;
  let inPrefix = true;
  for (const section of sections) {
    if (section.kind === "tools") continue;
    if (!inPrefix) continue;
    const message = section.messageIndex !== null ? request.messages[section.messageIndex] : undefined;
    const block = section.blockIndex !== null && message !== undefined ? message.content[section.blockIndex] : undefined;
    if (block?.cacheControl === "ephemeral") {
      prefixEndMessageIndex = section.messageIndex;
      prefixEndBlockIndex = section.blockIndex;
      prefixText.push(block.text ?? "");
      inPrefix = false;
      continue;
    }
    const cacheable =
      section.kind === "system" ||
      section.kind === "developer" ||
      section.kind === "static_context" ||
      section.kind === "stable_history";
    const stableText = block?.type === "text" && block.text !== undefined
      ? section.stable ? block.text : stablePrefixText(block.text)
      : null;
    if (cacheable && stableText !== null && stableText.length > 0) {
      prefixEndMessageIndex = section.messageIndex;
      prefixEndBlockIndex = section.blockIndex;
      prefixText.push(stableText);
      if (!section.stable) inPrefix = false;
    } else {
      inPrefix = false;
    }
  }
  const toolsStable = request.tools.length > 0;
  const hasStablePrefix = prefixEndMessageIndex !== null;
  let prefixFingerprint: string | null = null;
  if (hasStablePrefix) {
    if (toolsStable) prefixText.push(boundJsonStringify(request.tools));
    prefixFingerprint = fnv1a64(prefixText);
  }
  return {
    sections,
    toolsStable,
    hasStablePrefix,
    prefixEndMessageIndex,
    prefixEndBlockIndex,
    prefixFingerprint,
  };
}

function sectionKind(role: NormalizedMessage["role"], sawAssistant: boolean): CacheSectionKind {
  switch (role) {
    case "system":
      return "system";
    case "developer":
      return "developer";
    case "user":
      return sawAssistant ? "stable_history" : "static_context";
    case "assistant":
      return "stable_history";
    case "tool":
      return "dynamic";
  }
}

function insertionIndex(sections: readonly CacheSection[]): number {
  let index = 0;
  for (const section of sections) {
    if (section.kind === "system" || section.kind === "developer") index += 1;
    else break;
  }
  return index;
}

function toolsCharLength(tools: readonly NormalizedTool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += tool.name.length + (tool.description?.length ?? 0);
    // Reuse the length cached during normalization when available; fall back
    // to serializing for hand-built tools (e.g. test fixtures) that omit it.
    total += tool.schemaJsonLength ?? boundJsonStringify(tool.inputSchema).length;
  }
  return total;
}

function boundJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** FNV-1a 64-bit hex digest: deterministic, bounded (16 hex chars). */
function fnv1a64(parts: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let partIndex = 0;
  for (const part of parts) {
    if (partIndex > 0) {
      hash = (hash * prime) & mask;
      hash = (hash * prime) & mask;
    }
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      hash ^= BigInt(code & 0xff);
      hash = (hash * prime) & mask;
      hash ^= BigInt(code >> 8);
      hash = (hash * prime) & mask;
    }
    partIndex += 1;
  }
  return hash.toString(16).padStart(16, "0");
}
