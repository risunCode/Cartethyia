import type { ProviderCaps, ProviderMeta, Surface } from "../../application/contracts";

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

/** Resolves a wire surface using model-specific capabilities when the catalog knows the model. */
export function resolveModelWireSurface(
  metadata: ProviderMeta,
  providerCapabilities: ProviderCaps,
  modelCapabilities: ProviderCaps | null,
  clientSurface: Surface,
): Surface | null {
  return resolveWireSurface(metadata, modelCapabilities ?? providerCapabilities, clientSurface);
}

export { translateNonStreamResponse, decodeNonStreamResponse, encodeNonStreamResponse } from "./response/index";

export { registerResponseTranslation, lookupResponseTranslation, type ResponseProjector, type ResponseTranslationContext } from "./registry";
export { normalizeChatRequest, buildChatPayload, toOpenAIImageUrl } from "./request/openai-chat";
export { normalizeMessagesRequest, buildMessagesPayload } from "./request/anthropic";
export { normalizeResponsesRequest, buildResponsesPayload, REASONING_EFFORTS, REASONING_SUMMARIES, REASONING_MODES, REASONING_CONTEXTS, parseReasoningConfig } from "./request/openai-responses";
export { mapChatUsage, decodeChatResponse, decodeResponsesResponse, mapResponsesUsage } from "./response/openai";
export { mapAnthropicUsage, decodeAnthropicResponse } from "./response/anthropic";
export { normalizeImageRequest } from "./request/images";
export { translateGeminiImageResponse } from "./response/gemini";
export { mapGeminiUsage, translateGeminiResponse, geminiCandidate, responseParts } from "./response/gemini";
export { ProtocolCodecError, StreamDecodeError, type StreamDecodeKind } from "./errors";
export { detectSurface, lookupProxyEndpoint, normalizeRequest, parseRequestBody } from "./surface";
export { boundedRequest, readBoundedBytes, readBoundedJson, BoundedBodyTooLargeError, type BoundedBytesResult, type JsonBodyResult } from "./body";

export { toRequestDocument, withFieldDisposition, type RequestDocument, type RequestDocumentOptions, type FieldDisposition, type FieldDispositionAction, type ResponseControls, type ConversationState, type ReasoningIntent, type RequestMetadata, type SourceWireMetadata } from "./request/document";
export { detectClientFormat, normalizationEndpoint, clientIdentityForProfile, type ClientFormat, type ClientProfile, type ClientProfileName, type FormatDetectionResult, type DetectionSource, type DetectionConfidence } from "./detection";
export { RequestCodecRegistry, requestCodecRegistry, registerRequestCodec, registerRequestNormalizer, registerRequestEncoder, resolveRequestRoute, type RequestCodecContext, type RequestNormalizer, type RequestEncoder, type RequestCodec, type RequestRoute } from "./request/registry";
export { isNativePassthroughEligible, type NativePassthroughContext } from "./policy/passthrough";
export { applyProviderQuirkPolicy, applyRequiredProviderHeaders } from "./policy/quirks";
export { boundedTranslationDiagnostics, diagnosticsForDetection, type TranslationDiagnosticInput } from "./diagnostics";
export { resolveModelCapabilities, fromCaps, type ModelCapabilities, type ReasoningCapabilities, type CacheCapabilities, type ToolCapabilities, type ResponseCapabilities, type MediaCapabilities, type SupportLevel, type CanonicalEffort } from "./capabilities";
export { createTranslationContext, type TranslationContext, type TranslationPolicy, type TranslationDiagnosticSink, type FeatureTranslation, type CompatibilityRejection, type CompatibilityRule } from "./context";
export { classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "./fallback";
export { preserveWireExtensions } from "./policy/extensions";
export { normalizeClientEffort, projectEffort } from "./request/effort";
export { getCacheIntent, hasCacheBreakpoint } from "./features/cache";
export { DIRECT_ADAPTER_EXCEPTIONS, type DirectAdapterException } from "../transport/direct-adapter-policy";
export type { TranslationDiagnostic, TranslationDiagnosticAction, TranslationDiagnosticStage } from "../../application/contracts";