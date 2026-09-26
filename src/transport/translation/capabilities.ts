// Capability contracts, projection, assessment, and tool-loop safeguards.
import { capabilityUnsupported, GatewayError } from "../gateway-error";
import { summarizeParts, type CacheHint, type CanonicalRequest, type GenerationControls, type WireFamily } from "../canonical-model";

/** Capabilities declared by one resolved provider/model/route candidate. */
export interface RouteCapabilities {
  readonly text: true;
  readonly image: boolean;
  /** Accepts non-image document payloads (PDF, plain files). */
  readonly document: boolean;
  /** Accepts audio input parts. */
  readonly audio: boolean;
  /** Serves a provider-side web-search tool. */
  readonly webSearch: boolean;
  readonly tools: boolean;
  readonly parallelToolCalls: boolean;
  readonly reasoning: boolean;
  readonly reasoningEncryptedContent: boolean;
  readonly responseJsonObject: boolean;
  readonly responseJsonSchema: boolean;
  readonly promptCaching: boolean;
  readonly generationControls: ReadonlySet<keyof GenerationControls>;
  readonly extensions: ReadonlySet<string>;
}

/**
 * Per-wire-family generation-control support. Each wire dialect accepts a
 * different subset of `GenerationControls`; capability preflight must use
 * the route's declared set so unsupported controls are rejected explicitly.
 *
 * OpenAI Chat Completions: no `top_k` (Anthropic/Ollama-only sampling knob).
 * OpenAI Responses: no `top_k`, `n`, `stop`, `logprobs`, `top_logprobs` —
 * the Responses API has no multi-completion, stop-sequence, or logprobs
 * surface as of this gateway's supported version.
 * Anthropic Messages: only `temperature`, `top_p`, `top_k`, `stop`,
 * `max_tokens`, `parallel_tool_calls` (translated to `tool_choice`) —
 * everything else (`n`, `logprobs`, `top_logprobs`, `seed`, `service_tier`)
 * has no Messages equivalent.
 * A bespoke adapter is not in this matrix at all — see
 * `BESPOKE_GENERATION_CONTROLS` for why it receives every control.
 */
export const GENERATION_CONTROL_MATRIX: Readonly<
  Record<WireFamily, ReadonlySet<keyof GenerationControls>>
> = {
  chat: new Set([
    "temperature",
    "top_p",
    "n",
    "stop",
    "max_tokens",
    "max_completion_tokens",
    "parallel_tool_calls",
    "service_tier",
    "logprobs",
    "top_logprobs",
    "seed",
  ]),
  responses: new Set(["temperature", "top_p", "max_output_tokens", "parallel_tool_calls", "service_tier"]),
  messages: new Set(["temperature", "top_p", "top_k", "stop", "max_tokens", "parallel_tool_calls"]),
};

/**
 * Controls a bespoke adapter (Cursor, Devin) receives. These adapters read the
 * fields they understand directly from `generation_controls`, so nothing is
 * filtered out on their behalf: a wire matrix describes what a *codec* can
 * re-encode, and no codec is involved here. Filtering would silently drop a
 * control the adapter would have used.
 */
const BESPOKE_GENERATION_CONTROLS: ReadonlySet<keyof GenerationControls> = new Set([
  "temperature",
  "top_p",
  "top_k",
  "n",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "parallel_tool_calls",
  "service_tier",
  "logprobs",
  "top_logprobs",
  "seed",
]);

/**
 * Per-wire-family support for content-part `extension` names. Unlike
 * generation-control extensions (passthrough hints), a content part carries
 * semantics the upstream must understand. `server_tool_use` and `search_result`
 * are Anthropic Messages blocks, so only the Messages wire re-encodes them
 * (`protocol/request/messages.ts`); Chat and Responses drop extension parts.
 * A bespoke adapter reads only what its own framing understands, so it
 * re-encodes nothing here either.
 */
export const EXTENSION_MATRIX: Readonly<Record<WireFamily, ReadonlySet<string>>> = {
  chat: new Set(),
  responses: new Set(),
  messages: new Set(["server_tool_use", "search_result"]),
};

/** No codec re-encodes extension parts, so a bespoke adapter's route carries none. */
const EMPTY_EXTENSIONS: ReadonlySet<string> = new Set();

/**
 * Wire families whose codec can encode an audio input part.
 *
 * Chat (`input_audio`) and Responses (`input_audio`) both define one. The
 * Anthropic Messages wire does not: its request content blocks are exactly
 * text, image, document, search_result, thinking, redacted_thinking, tool_use,
 * tool_result, the server-tool blocks, and container_upload — there is no audio
 * variant, and no `media_type` in any accepted shape admits an audio MIME type.
 * Every provider routed over this wire (Anthropic, Claude Code, Kimi) speaks
 * that schema, so an audio part has no valid encoding on any of them.
 *
 * This is the one fact that separates audio from image/document: a codec-backed
 * route can carry an image on every wire, but it cannot carry audio on
 * `messages`. Audio is therefore the only modality whose capability is granted
 * per wire family rather than to every codec-backed route.
 */
export const AUDIO_CAPABLE_WIRE_FAMILIES: ReadonlySet<WireFamily> = new Set<WireFamily>([
  "chat",
  "responses",
]);

/** Defensive fallback: a wire family with no matrix entry forwards no control. */
const EMPTY_CONTROLS: ReadonlySet<keyof GenerationControls> = new Set();

/** Picks only the generation-control keys a given wire family actually forwards. */
export function pickWireSupportedControls(
  controls: GenerationControls,
  wireFamily: WireFamily,
): GenerationControls {
  const supported = GENERATION_CONTROL_MATRIX[wireFamily];
  const picked: GenerationControls = {};
  for (const [key, value] of Object.entries(controls)) {
    if (key.startsWith("extension:")) continue;
    if (supported.has(key as keyof GenerationControls) && value !== undefined) {
      (picked as Record<string, unknown>)[key] = value;
    }
  }
  return picked;
}

/**
 * Minimal candidate shape for capability checks: the snapshot
 * `capability_profile` (built by `buildCapabilityProfile` in route-catalog)
 * plus the wire family driving generation-control support. Structural so
 * both the router (`routing/router.ts`) and the planner share one predicate
 * without a layering cycle.
 */
export interface CapabilityProfileHolder {
  readonly capability_profile: Readonly<Record<string, boolean>>;
  readonly wire_family: WireFamily;
}

/** Projects a snapshot capability profile onto route capability declarations. */
export function routeCapabilitiesFor(candidate: CapabilityProfileHolder): RouteCapabilities {
  const profile = candidate.capability_profile;
  return {
    text: true,
    image: profile.image === true,
    document: profile.document === true,
    // A bespoke adapter frames its own protocol, so only an explicit modality
    // declaration grants it audio. A codec route is decided by the wire's own
    // vocabulary instead: a catalog's audio flag describes the *model*, and no
    // declaration can add a block the schema does not define. Without this
    // narrowing a codec-backed `messages` route claims audio it has no block
    // for, passes the pre-lease gate, and reaches the builder to emit a block
    // the provider rejects — failing the whole request, not just the
    // attachment.
    audio:
      profile.bespokeWire === true
        ? profile.audio === true
        : AUDIO_CAPABLE_WIRE_FAMILIES.has(candidate.wire_family),
    webSearch: profile.webSearch === true,
    tools: profile.tools === true,
    parallelToolCalls: profile.parallelToolCalls === true,
    reasoning: profile.reasoning === true,
    reasoningEncryptedContent: profile.reasoningEncryptedContent === true,
    responseJsonObject: profile.responseJsonObject !== false,
    responseJsonSchema: profile.responseJsonSchema !== false,
    promptCaching: profile.promptCaching !== false,
    // A bespoke route has no codec, so no wire matrix applies: the adapter
    // reads the controls it understands directly. Otherwise the route's wire
    // family decides, because that is the codec that will re-encode them.
    generationControls:
      profile.bespokeWire === true
        ? BESPOKE_GENERATION_CONTROLS
        : GENERATION_CONTROL_MATRIX[candidate.wire_family] ?? EMPTY_CONTROLS,
    // Content-part `extension` names the route's wire codec actually re-encodes.
    // Generation-control `extension:*` keys are passthrough hints and are never
    // route capabilities (see `deriveRequiredCapabilities`).
    extensions:
      profile.bespokeWire === true
        ? EMPTY_EXTENSIONS
        : EXTENSION_MATRIX[candidate.wire_family] ?? EMPTY_EXTENSIONS,
  };
}

/** True when the candidate's snapshot profile supports every requirement. */
export function candidateSupportsRequest(
  candidate: CapabilityProfileHolder,
  required: readonly RequiredCapability[],
): boolean {
  const capabilities = routeCapabilitiesFor(candidate);
  return required.every((capability) => routeSupports(capability, capabilities));
}

/**
 * Single arithmetic home for extended-thinking token guards. Anthropic
 * rejects sampling params alongside thinking and requires
 * `max_tokens >= budget_tokens + buffer`; both rules live here so the
 * Messages payload builder (`protocol/request/messages.ts`) and the
 * adapter-stage param quirks (`translation/quirks.ts`) share them.
 */

/** Output-token buffer added to the thinking budget (Anthropic requires headroom above budget). */
const THINKING_BUDGET_OUTPUT_BUFFER = 1024;

/**
 * Sampling controls Anthropic rejects when extended thinking is active.
 * `top_k` rides along: the Messages wire has no thinking+top_k combination
 * either, and the payload builder has always stripped all three together.
 */
export const THINKING_STRIPPED_SAMPLING_CONTROLS: readonly (keyof GenerationControls)[] = [
  "temperature",
  "top_p",
  "top_k",
];

/** True when the request enables extended thinking (disabled/absent → false). */
export function isThinkingEnabled(request: CanonicalRequest): boolean {
  const thinkingType = request.reasoning?.thinking_type;
  return thinkingType !== undefined && thinkingType !== "disabled" && request.reasoning !== undefined;
}

/**
 * Ensures `max_tokens` accommodates the thinking budget plus buffer,
 * clamped to the caller-supplied ceiling (OAuth vs API-key ceilings differ
 * per provider auth and stay at the call site).
 */
export function ensureMaxTokensForThinking(
  currentMax: number,
  budget: number | undefined,
  maxAllowed: number,
): number {
  if (budget === undefined || budget <= 0) return currentMax;
  const buffer = THINKING_BUDGET_OUTPUT_BUFFER;
  if (budget + buffer > maxAllowed) {
    throw new GatewayError(
      "invalid_request",
      400,
      `Anthropic thinking budget requires max_tokens greater than ${buffer}; got ${currentMax} with budget ${budget}`,
      { budget_tokens: budget, max_tokens: currentMax },
    );
  }
  const required = budget + buffer;
  return Math.min(Math.max(currentMax, required), maxAllowed);
}

/** A request capability derived before any account or network lease is acquired. */
export type RequiredCapability =
  | "image"
  | "document"
  | "audio"
  | "web_search"
  | "tools"
  | "parallel_tool_calls"
  | "reasoning"
  | "reasoning.encrypted_content"
  | "response_format.json_object"
  | "response_format.json_schema"
  | "prompt_caching"
  | `generation_control:${string}`
  | `extension:${string}`;

/**
 * Copy of a canonical request safe to project into one route's wire dialect.
 * No field is silently removed: every unsupported semantic requirement has
 * already produced a typed rejection before this result exists.
 */
export interface ProjectedRequest extends CanonicalRequest {
  readonly requiredCapabilities: readonly RequiredCapability[];
}

/** Derives every semantic requirement from a canonical request deterministically. */
export function deriveRequiredCapabilities(
  request: CanonicalRequest,
): readonly RequiredCapability[] {
  const capabilities: RequiredCapability[] = [];
  const parts = summarizeParts(request);

  // Modalities the caller attached as payload are hard requirements: they
  // cannot be re-expressed as text, so an incapable route must be filtered out
  // (and, in the router, fused onto a capable model) rather than degraded.
  if (parts.hasImage) capabilities.push("image");
  if (parts.hasDocument) capabilities.push("document");
  if (parts.hasAudio) capabilities.push("audio");
  // `web_search` is deliberately NOT derived from `parts.hasWebSearch`. A
  // hosted-tool declaration is already carried through the normal `tools`
  // requirement and passthrough, and many providers serve it without
  // declaring `webSearch` in their static catalog. Deriving it here would
  // start filtering/degrading requests those providers currently handle.
  // It remains a valid `RequiredCapability` for callers that opt in.
  if (request.tools?.length || parts.hasToolActivity) {
    capabilities.push("tools");
  }
  if (request.generation_controls.parallel_tool_calls) {
    capabilities.push("parallel_tool_calls");
  }
  if (request.reasoning) {
    capabilities.push("reasoning");
    if (parts.hasEncryptedReasoning) {
      capabilities.push("reasoning.encrypted_content");
    }
  }
  if (request.response_format?.type === "json_object") {
    capabilities.push("response_format.json_object");
  }
  if (request.response_format?.type === "json_schema") {
    capabilities.push("response_format.json_schema");
  }
  if (request.cache_hint) capabilities.push("prompt_caching");

  for (const key of Object.keys(request.generation_controls)) {
    // `extension:*` keys are passthrough hints to the wire codec, not route
    // capabilities: the codec reads the names it understands and drops the
    // rest. Gating them here used to strip every hint (this set was never
    // populated), degrading `include_usage`, `prompt_cache_key`, `user`,
    // `metadata`, etc. and re-warning per request.
    if (key.startsWith("extension:")) continue;
    capabilities.push(`generation_control:${key}`);
  }
  for (const name of parts.extensionNames) {
    capabilities.push(`extension:${name}`);
  }

  return [...new Set(capabilities)];
}

/** Anthropic and OpenAI 5.6+ both cap explicit cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Validates the cache-breakpoint count at the preflight boundary — before
 * admission or dispatch — so an over-limit request fails once with a typed
 * 400 input error instead of throwing a bare `Error` deep inside a
 * provider's payload builder (`transport/translation/capabilities.ts`), where
 * it could be misread as a candidate-specific dispatch failure and retried
 * against another candidate for a request that will fail identically every
 * time regardless of which candidate serves it.
 */
function validateCacheBreakpoints(hint: CacheHint | undefined): void {
  if (hint === undefined || hint === "stable_prefix") return;
  if (hint.list.length > MAX_CACHE_BREAKPOINTS) {
    throw new GatewayError(
      "invalid_request",
      400,
      `cache_hint declares ${hint.list.length} breakpoints; at most ${MAX_CACHE_BREAKPOINTS} are supported`,
      { breakpoint_count: hint.list.length, max_breakpoints: MAX_CACHE_BREAKPOINTS },
    );
  }
}

/**
 * Performs pre-lease capability filtering and returns a projection-ready
 * canonical request. The output retains every supported semantic field; it
 * never uses lossy defaults for image/tool/reasoning/structured-output/cache
 * requirements.
 */
export function projectForRoute(
  request: CanonicalRequest,
  capabilities: RouteCapabilities,
): ProjectedRequest {
  validateCacheBreakpoints(request.cache_hint);
  const requiredCapabilities = deriveRequiredCapabilities(request);

  for (const required of requiredCapabilities) {
    if (!routeSupports(required, capabilities)) {
      throw capabilityUnsupported(required, { source_surface: request.source_surface });
    }
  }

  return {
    ...request,
    requiredCapabilities,
  };
}

/** Tests a resolved route's capability declaration against one requirement. */
function routeSupports(
  required: RequiredCapability,
  capabilities: RouteCapabilities,
): boolean {
  if (required === "image") return capabilities.image;
  if (required === "document") return capabilities.document;
  if (required === "audio") return capabilities.audio;
  if (required === "web_search") return capabilities.webSearch;
  if (required === "tools") return capabilities.tools;
  if (required === "parallel_tool_calls") {
    return capabilities.tools && capabilities.parallelToolCalls;
  }
  if (required === "reasoning") return capabilities.reasoning;
  if (required === "reasoning.encrypted_content") {
    return capabilities.reasoning && capabilities.reasoningEncryptedContent;
  }
  if (required === "response_format.json_object") return capabilities.responseJsonObject;
  if (required === "response_format.json_schema") return capabilities.responseJsonSchema;
  if (required === "prompt_caching") return capabilities.promptCaching;
  if (required.startsWith("generation_control:")) {
    const control = required.slice("generation_control:".length) as keyof GenerationControls;
    if (capabilities.generationControls.has(control)) return true;
    if (
      (control === "max_tokens" || control === "max_output_tokens" || control === "max_completion_tokens") &&
      (capabilities.generationControls.has("max_tokens") ||
        capabilities.generationControls.has("max_output_tokens") ||
        capabilities.generationControls.has("max_completion_tokens"))
    ) {
      return true;
    }
    return false;
  }
  return capabilities.extensions.has(required.slice("extension:".length));
}

/** Provider-neutral normalization helpers used only after capability preflight. */
export function normalizeGenerationControls(controls: GenerationControls): GenerationControls {
  const normalized: GenerationControls = { ...controls };
  if (
    normalized.max_output_tokens === undefined &&
    normalized.max_completion_tokens !== undefined
  ) {
    normalized.max_output_tokens = normalized.max_completion_tokens;
  }
  if (normalized.max_output_tokens === undefined && normalized.max_tokens !== undefined) {
    normalized.max_output_tokens = normalized.max_tokens;
  }
  return normalized;
}

