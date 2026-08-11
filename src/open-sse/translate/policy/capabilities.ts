import type { ProviderCaps, Surface } from "../../../application/contracts";

export type TranslationCapability = "reasoning" | "toolCalls" | "images" | "explicitCache" | "promptCacheKey" | "search";

/** Checks a provider capability before preserving a protocol-native semantic item. */
export function supportsTranslationCapability(capabilities: ProviderCaps, capability: TranslationCapability): boolean {
  return capability === "search" ? capabilities.search === true : capabilities[capability];
}

/** Returns whether a target surface can carry a native block without visible-text loss. */
export function supportsNativeBlockSurface(surface: Surface, nativeType: string | undefined): boolean {
  if (nativeType === undefined) return false;
  if (surface === "anthropic-messages") return nativeType.startsWith("server_") || nativeType.endsWith("_tool_result") || nativeType === "compaction";
  if (surface === "openai-responses") return nativeType === "compaction" || nativeType === "reasoning";
  return false;
}

/** Returns whether the target protocol can preserve encrypted reasoning metadata. */
export function supportsEncryptedReasoning(surface: Surface): boolean {
  return surface === "openai-responses";
}
