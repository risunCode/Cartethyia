import type { ProviderCaps, ProviderMeta, Protocol, Surface } from "../../domain/contracts";
import { lookupTranslation } from "./registry";

/** Resolves the provider-native wire surface while preserving the client surface in the normalized request. */
export function resolveWireSurface(metadata: ProviderMeta, capabilities: ProviderCaps, clientSurface: Surface): Surface | null {
  if (clientSurface === "images") return capabilities.surfaces.includes("images") ? "images" : null;
  if (clientSurface === "web-search") return capabilities.surfaces.includes("web-search") ? "web-search" : null;
  if (capabilities.surfaces.includes(clientSurface)) return clientSurface;
  if (metadata.protocol === "anthropic") return capabilities.surfaces.includes("anthropic-messages") ? "anthropic-messages" : null;
  if (metadata.protocol === "gemini") {
    if (capabilities.surfaces.includes("openai-chat")) return "openai-chat";
    if (capabilities.surfaces.includes("openai-responses")) return "openai-responses";
    return null;
  }
  if (metadata.protocol === "exa") return capabilities.surfaces.includes("web-search") ? "web-search" : null;
  if (capabilities.surfaces.includes("openai-chat")) return "openai-chat";
  return capabilities.surfaces.includes("openai-responses") ? "openai-responses" : null;
}

/** Converts a provider's non-stream body from its wire shape to the client's requested surface. */
export function translateBody(
  body: Record<string, unknown>,
  protocol: Protocol,
  wireSurface: Surface,
  clientSurface: Surface,
): Record<string, unknown> {
  if (wireSurface === clientSurface || clientSurface === "images" || protocol === "gemini") return body;
  const direct = lookupTranslation(wireSurface, clientSurface);
  if (direct !== undefined) return direct(body);
  if (wireSurface !== "openai-chat" && clientSurface !== "openai-chat") {
    const toHub = lookupTranslation(wireSurface, "openai-chat");
    const fromHub = lookupTranslation("openai-chat", clientSurface);
    if (toHub !== undefined && fromHub !== undefined) return fromHub(toHub(body));
  }
  return body;
}

export { registerTranslation, lookupTranslation, type BodyConverter } from "./registry";
export { normalizeChatRequest, buildChatPayload, mapChatUsage, toOpenAIImageUrl } from "./codecs/openai-chat";
export { normalizeMessagesRequest, buildMessagesPayload, mapAnthropicUsage } from "./codecs/anthropic-messages";
export { normalizeResponsesRequest, buildResponsesPayload, mapResponsesUsage, REASONING_EFFORTS, parseReasoningConfig } from "./codecs/openai-responses";
export { normalizeImageRequest } from "./codecs/images";
export { buildGeminiPayload, mapGeminiUsage, translateGeminiResponse, geminiCandidate, responseParts } from "./codecs/gemini-generate-content";
export { ProtocolCodecError, StreamDecodeError, type StreamDecodeKind } from "./errors";
export { detectSurface, lookupProxyEndpoint, normalizeRequest, parseRequestBody } from "./surface";
export { readBoundedJson, type JsonBodyResult } from "./body";

// Side-effect registration keeps the conversion graph extensible without a central table.
import "./converters/compat";
