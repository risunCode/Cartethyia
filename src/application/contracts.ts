export type Surface = "openai-chat" | "openai-responses" | "anthropic-messages" | "images" | "web-search";
export type MediaGenerationKind = "image" | "video";
export type Protocol = "openai" | "anthropic" | "gemini" | "exa" | "devin";
export type CredentialKind = "api_key" | "oauth" | "manual" | "none";

/** Network routing preset shared by proxy settings and the network selector. */
export type RoutingPreset = "auto" | "target-user" | "target-concurrent";
export type WebSearchPreference = "auto" | "prefer-codex" | "prefer-exa";
export type WebSearchRouteKind = "native" | "codex" | "antigravity" | "exa" | "passthrough";

/** Usage aggregation dimension for telemetry queries. */
export type UsageDimension = "model" | "provider" | "key";

/** Usage aggregation period for telemetry queries. */
export type UsagePeriod = "1h" | "24h" | "7d" | "30d" | "all";

export interface ProviderMeta {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: Protocol;
  readonly credentialKind: CredentialKind;
  /** Official onboarding URL for API-key or account credentials, when available. */
  readonly credentialUrl?: string;
  /** Credential modes accepted by the adapter; defaults to the primary kind. */
  readonly credentialKinds?: readonly CredentialKind[];
}

export type ReasoningWireFormat = "openai" | "anthropic-budget" | "anthropic-adaptive" | "gemini-budget" | "gemini-level" | "provider-native";

export interface ReasoningCapability {
  readonly enabled: boolean;
  readonly format: ReasoningWireFormat;
  readonly canDisable: boolean;
  readonly minBudget?: number;
  readonly maxBudget?: number;
}

export interface ProviderQuirkPolicy {
  readonly droppedFields?: readonly string[];
  readonly clampedFields?: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>;
  readonly requiredHeaders?: Readonly<Record<string, string>>;
  readonly supportedResponseControls?: readonly string[];
}

export interface ProviderCaps {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly reasoningCapability?: ReasoningCapability;
  readonly toolCalls: boolean;
  /** Whether the model can accept image input for vision. */
  readonly images: boolean;
  /** Media generation kinds supported by the model. */
  readonly mediaGeneration: readonly MediaGenerationKind[];
  readonly explicitCache: boolean;
  readonly promptCacheKey: boolean;
  readonly quirks?: ProviderQuirkPolicy;
  /** Whether the model/provider can execute a native web search tool. */
  readonly search?: boolean;
}

/** Cache modes that can be declared by a model compatibility descriptor. */
export type ModelCacheMode = "none" | "explicit" | "implicit" | "native";

/** Canonical sampling controls that may be restricted per model. */
export type ModelSamplingField = "temperature" | "top_p" | "stop";

/** Per-model reasoning wire compatibility metadata. */
export interface ModelReasoningCompatibility {
  readonly efforts?: readonly ReasoningEffort[];
  readonly effortMap?: Readonly<Record<string, string>>;
  readonly budget?: boolean;
  readonly summary?: boolean;
  readonly disable?: boolean;
}

/** Per-model sampling-control compatibility metadata. */
export interface ModelSamplingCompatibility {
  readonly temperature?: boolean;
  readonly topP?: boolean;
  readonly stop?: boolean;
  /** Explicit allow-list for clients that describe controls by wire name. */
  readonly supported?: readonly ModelSamplingField[];
}

/** Per-model tool-result and native-tool compatibility metadata. */
export interface ModelToolCompatibility {
  readonly parallel?: boolean;
  readonly resultIdRequired?: boolean;
  readonly nativeTypes?: readonly string[];
}

/** Per-model prompt-cache compatibility metadata. */
export interface ModelCacheCompatibility {
  readonly mode?: ModelCacheMode;
  readonly ttl?: boolean;
  readonly breakpoints?: number;
  readonly minimumPrefixTokens?: number;
}

/** Per-model response-state compatibility metadata. */
export interface ModelResponseStateCompatibility {
  readonly previousResponseId?: boolean;
  readonly staleRepair?: boolean;
}

/** Per-model provider timeout hints. */
export interface ModelTimeoutProfile {
  readonly firstByteMs?: number;
  readonly idleMs?: number;
}

/**
 * Optional model-local compatibility metadata.
 *
 * A present nested object is authoritative for that capability family. Missing
 * optional members are therefore treated conservatively rather than inferred
 * from unrelated provider-level flags.
 */
export interface ModelCompatibility {
  readonly reasoning?: ModelReasoningCompatibility;
  readonly sampling?: ModelSamplingCompatibility;
  readonly tools?: ModelToolCompatibility;
  readonly cache?: ModelCacheCompatibility;
  readonly responseState?: ModelResponseStateCompatibility;
  readonly streamUsage?: boolean;
  readonly timeoutProfile?: ModelTimeoutProfile;
}

/** Normalized capability categories projected from a model's capability booleans. */
export type ModelCapabilityCategory = "vision" | "text" | "reasoning";

/** Normalized context window limits in tokens; null when unknown. */
export interface ModelContextLimits {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** Normalized token pricing (USD per 1M tokens); null when unknown. */
export interface ModelTokenPricing {
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
}

export interface ProviderModel {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCaps;
  /** Optional per-model overrides for otherwise conservative capability projection. */
  readonly compatibility?: ModelCompatibility;
  /**
   * Optional model id sent to the upstream API when it differs from the
   * client-facing {@link id}. When unset, the upstream receives {@link id}
   * verbatim. This lets a catalog expose a friendly id (e.g.
   * "mistral/codestral") while forwarding only the suffix the upstream
   * expects ("codestral"), without per-adapter model-rewrite hacks.
   */
  readonly upstreamId?: string;
  /** Normalized context limits; null fields mean "unknown" (never fabricated). */
  readonly context?: ModelContextLimits;
  /** Normalized capability categories (projected from capabilities unless overridden). */
  readonly categories?: readonly ModelCapabilityCategory[];
  /** Normalized token pricing; null fields mean "unknown" (never fabricated). */
  readonly pricing?: ModelTokenPricing;
}

/**
 * Normalized model metadata as surfaced by model-list endpoints and console
 * views. `source` records provenance (built-in catalog vs user-configured
 * custom provider); `updatedAt` is the last write time of the underlying
 * definition when tracked.
 */
export interface ModelMetadata {
  readonly context: ModelContextLimits;
  readonly categories: readonly ModelCapabilityCategory[];
  readonly pricing: ModelTokenPricing;
  readonly source: "catalog" | "custom";
  readonly updatedAt: string | null;
}

export interface ProviderModelCatalog {
  readonly list: readonly ProviderModel[];
  readonly get: (modelId: string) => ProviderModel | null;
}

export interface RouteTarget {
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Model id sent to the upstream API. Resolved from the catalog entry's
   * {@link ProviderModel.upstreamId} when set, otherwise mirrors
   * {@link modelId}. Transport layers MUST send this field (never
   * {@link modelId} or the raw client model string) as the upstream model
   * identifier.
   */
  readonly upstreamModelId: string;
  readonly surface: Surface;
}

export interface PayloadCapture {
  /** Captures the exact JSON/text payload at a transport boundary. */
  request(value: unknown): void;
  response(value: unknown): void;
  /** Observes an upstream response without consuming the caller's body. */
  observeResponse(response: Response): Response;
  /** Waits for any bounded stream capture still in flight. */
  settle(): Promise<void>;
}

export interface ProviderRequest {
  readonly target: RouteTarget;
  readonly request: ProxyRequest;
  readonly credential: string;
  readonly network: NetworkSelection;
  readonly signal: AbortSignal;
  /** Original client headers for provider-specific allowlisted passthrough only. */
  readonly headers?: Headers;
  readonly capture?: PayloadCapture;
  /** Records bounded translation decisions without exposing payload contents. */
  readonly recordDiagnostic?: (diagnostic: TranslationDiagnostic) => void;
}

export interface ProviderUsage {
  /** Uncached input tokens; cache reads and writes are tracked separately below. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Input tokens served from the provider's prompt cache. */
  readonly cacheReadTokens: number | null;
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens: number | null;
  /** Provider-reported reasoning tokens when the wire exposes them. */
  readonly reasoningTokens?: number | null;
  readonly source: "provider" | "tokenizer" | "unknown";
}


export type ProviderOutput =
  | { readonly mode: "non_stream"; readonly body: Record<string, unknown>; readonly usage?: ProviderUsage }
  | { readonly mode: "stream"; readonly events: AsyncIterable<StreamEvent>; readonly usage?: ProviderUsage };

export interface Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  resolveTarget(modelId: string, surface: Surface): RouteTarget;
  call(input: ProviderRequest): Promise<ProviderOutput>;
  mapError(error: unknown): ProviderCallError;
}

export type RouteScope = "account" | "proxy";
export type RouteStatus = "healthy" | "cooling_down" | "error" | "disabled";

export interface RouteHealth {
  readonly scope: RouteScope;
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: string | null;
  readonly sanitizedMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
}

/** Durable persistence contract for route health — injected by the storage layer. */
export interface RouteHealthStore {
  readHealth(scope: RouteScope, routeId: string): Promise<RouteHealth | null>;
  writeHealth(scope: RouteScope, routeId: string, health: RouteHealth): Promise<void>;
  clearHealth(scope: RouteScope, routeId: string): Promise<void>;
}

export interface RouteSwitch {
  readonly scope: RouteScope;
  readonly previousRouteId: string | null;
  readonly replacementRouteId: string | null;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface RouteCandidate {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly surface: Surface;
  readonly health: RouteHealth | null;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly compatible: boolean;
  readonly searchRoute?: WebSearchRouteKind;
}


export interface AffinityKey {
  readonly namespace: "api_key" | "trusted_identity";
  readonly value: string;
}

/**
 * Per-model lock record — an error on model A does NOT block model B on
 * the same account. Parallel to AccountHealthRecord but keyed by
 * (accountId, modelId). Only bounded sanitized scalars; never secrets.
 * Lives in the domain layer so AccountCandidate can reference it without a
 * circular import into the auth module.
 */
export interface ModelLockRecord {
  readonly accountId: string;
  readonly modelId: string;
  readonly retryAt: string;
  readonly errorKind: string | null;
  readonly statusCode: number | null;
  readonly sanitizedMessage: string | null;
  readonly failureCount: number;
}

export interface AccountCandidate {
  readonly id: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly health: RouteHealth | null;
  readonly enabled: boolean;
  readonly quotaAvailable: boolean;
  /**
   * Per-model locks keyed by modelId. When present, a lock whose retry_at
   * has not passed makes the account ineligible for that specific model —
   * an error on model A does NOT block model B on the same account.
   */
  readonly modelLocks: ReadonlyMap<string, ModelLockRecord> | null;
}

export interface ProxyCandidate {
  readonly id: string;
  readonly url: string;
  readonly health: RouteHealth | null;
  readonly enabled: boolean;
}

export interface AccountChoice {
  readonly account: AccountCandidate;
  readonly switchEvent: RouteSwitch | null;
}

export interface ProxyChoice {
  readonly proxy: ProxyCandidate;
  readonly switchEvent: RouteSwitch | null;
}

export interface CredentialSelection {
  readonly accountId: string | null;
  readonly kind: CredentialKind;
  readonly leaseId: string;
  readonly secret: string;
}

export interface NetworkSelection {
  readonly proxyId: string | null;
  readonly url: string | null;
  readonly isRelay?: boolean;
  readonly release: () => Promise<void>;
}


export type ProxyEndpoint = "/v1/chat/completions" | "/v1/messages" | "/v1/responses" | "/v1/images/generations" | "/v1/images/edits" | "/v1/models";

export type ClientName =
  | "github_copilot"
  | "claude_code"
  | "codex"
  | "cursor"
  | "cline"
  | "opencode"
  | "pi"
  | "unknown";

export type ClientDetectionSource =
  | "explicit_header"
  | "user_agent"
  | "protocol_header"
  | "body_shape"
  | "endpoint"
  | "prompt_marker"
  | "unknown";

export interface ClientIdentity {
  readonly name: ClientName;
  readonly source: ClientDetectionSource;
}

export interface RequestLimits {
  readonly maxBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface ImageReference {
  readonly kind: "url" | "data" | "file";
  readonly value: string;
  readonly mediaType: string | null;
}

export interface ContentBlock {
  readonly type: "text" | "image" | "tool_use" | "tool_result" | "compaction" | "reasoning" | "native" | "unknown";
  readonly text?: string;
  readonly cacheControl?: "ephemeral";
  readonly image?: ImageReference;
  readonly toolName?: string;
  readonly toolCallId?: string;
  /** JSON-encoded function arguments preserved across protocol adapters. */
  readonly toolArguments?: string;
  readonly toolResultIsError?: boolean;
  /** Provider-native block discriminator, retained only when target capabilities support it. */
  readonly nativeType?: string;
  /** Bounded provider-native block payload that is never rendered as visible text. */
  readonly nativePayload?: Readonly<Record<string, unknown>>;
  /** Visible reasoning summary text, kept separate from ordinary text blocks. */
  readonly reasoningText?: string;
  /** Provider reasoning signature retained only for a compatible target surface. */
  readonly reasoningSignature?: string;
  readonly reasoningEncryptedContent?: string;
  /** Structured reasoning summary entries preserved across compatible projections. */
  readonly reasoningSummary?: readonly Readonly<Record<string, unknown>>[];
  /** Original opaque provider block, when it must round-trip unchanged. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface NormalizedMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content: readonly ContentBlock[];
  /** OpenAI reasoning token payload that must round-trip in thinking mode. */
  readonly reasoningContent?: string;
  /** Opaque Responses reasoning items that precede this message. */
  readonly reasoningItemsBefore?: readonly Record<string, unknown>[];
  /** OpenAI Responses assistant message phase, when supplied. */
  readonly phase?: "commentary" | "final_answer";
}

export interface NormalizedTool {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: Record<string, unknown>;
  /** Original protocol-native tool type, when the client supplied one. */
  readonly nativeType?: string;
  /** Bounded options preserved for Anthropic server tools. */
  readonly nativeOptions?: Readonly<Record<string, unknown>>;
  /** Complete original tool definition for same-surface preservation. */
  readonly raw?: Readonly<Record<string, unknown>>;
  /**
   * Precomputed `JSON.stringify(inputSchema).length`, set during normalization
   * so the cache planner reuses it instead of re-serializing the schema per
   * request. Absent on hand-built tools; consumers fall back to serializing.
   */
  readonly schemaJsonLength?: number;
  /** Anthropic Advanced Tool Use: omit the definition until tool search discovers it. */
  readonly deferLoading?: boolean;
  readonly allowedCallers?: readonly string[];
  readonly inputExamples?: readonly Readonly<Record<string, unknown>>[];
}

export interface CacheIntent {
  readonly key: string | null;
  readonly stablePrefixFingerprint: string | null;
  readonly affinityKey: string | null;
  readonly policy: "automatic" | "explicit" | "ephemeral";
  readonly ttl: string | null;
}

export interface ProxyRequest {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly stream: boolean;
  readonly responseFormat: "text" | "json_object" | "json_schema";
  readonly responseFormatSchema?: Readonly<Record<string, unknown>>;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: "none" | "auto" | "required" | Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reasoning: "enabled" | "disabled" | "default";
  /**
   * Structured reasoning controls forwarded to OpenAI Responses-style upstreams.
   * Populated from the `reasoning` object (`effort`/`summary`/`mode`/`context`)
   * and the `include` array on `/v1/responses`; carries concise-by-default
   * summary controls and include flags for reasoning-capable models.
   */
  readonly reasoningConfig?: ReasoningConfig;
  /** Items to include alongside the response (e.g. `reasoning.encrypted_content`). */
  readonly include?: readonly string[];
  /** Optional remote-provider context configuration; unsupported adapters omit it on the wire. */
  readonly contextManagement?: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];
  /** Anthropic MCP connector server definitions, forwarded only on Messages requests. */
  readonly mcpServers?: readonly Readonly<Record<string, unknown>>[];
  /** Opaque Responses items that precede the next normalized message. */
  readonly reasoningItems?: readonly Record<string, unknown>[];
  /** Opaque Responses items that follow the last normalized message. */
  readonly trailingReasoningItems?: readonly Record<string, unknown>[];
  readonly maxOutputTokens: number | null;
  readonly images: readonly ImageReference[];
  readonly imageOperation?: "generate" | "edit";
  readonly sourceSurface: Surface;
  readonly signal: AbortSignal;
  readonly limits: RequestLimits;
  readonly cacheKey?: string;
  readonly cacheIntent?: CacheIntent;
  readonly metadataUserId?: string;
  /**
   * Parsed source payload retained for same-surface wire preservation.
   * Cross-protocol adapters continue to use the canonical fields above.
   */
  readonly wirePayload?: Readonly<Record<string, unknown>>;
}

/** Effort levels supported by OpenAI reasoning models (o/o-series, GPT-5 series) and Grok. */
export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

/** Summary verbosity accepted by `reasoning.summary` on the Responses wire. */
export type ReasoningSummary = "auto" | "concise" | "detailed";

/** Responses reasoning execution mode. */
export type ReasoningMode = "standard" | "pro";

/** Responses reasoning history context selection. */
export type ReasoningContext = "auto" | "current_turn" | "all_turns";

export interface ReasoningConfig {
  readonly effort?: ReasoningEffort;
  readonly maxTokens?: number;
  readonly exclude?: boolean;
  readonly enabled?: boolean;
  readonly summary?: ReasoningSummary;
  readonly mode?: ReasoningMode;
  readonly context?: ReasoningContext;
}

export interface RunProxyRequestInput {
  /** Correlation ID supplied by the HTTP boundary when available. */
  readonly requestId?: string;
  readonly endpoint: ProxyEndpoint;
  readonly surface: Surface;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal;
  /** Boundary-derived client IP; never inferred from untrusted payload data. */
  readonly clientIp?: string | null;
}

const CLIENT_NAMES: Readonly<Record<string, ClientName>> = Object.freeze({
  github_copilot: "github_copilot",
  claude_code: "claude_code",
  codex: "codex",
  cursor: "cursor",
  cline: "cline",
  opencode: "opencode",
  pi: "pi",
});
const CLIENT_USER_AGENT_NEEDLES = Object.freeze(
  Object.entries(CLIENT_NAMES).map(([needle, name]) => ({ needle: needle.replace("_", "-"), rawNeedle: needle, name })),
);

export function detectClient(headers: Headers, normalized?: ProxyRequest): ClientIdentity {
  const explicit = headers.get("x-client-name")?.trim().toLowerCase();
  const explicitName = explicit ? CLIENT_NAMES[explicit] : undefined;
  if (explicitName) return { name: explicitName, source: "explicit_header" };

  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("claude-cli")) return { name: "claude_code", source: "user_agent" };
  for (const entry of CLIENT_USER_AGENT_NEEDLES) {
    if (userAgent.includes(entry.needle) || userAgent.includes(entry.rawNeedle)) {
      return { name: entry.name, source: "user_agent" };
    }
  }

  const protocol = headers.get("x-stainless-helper-method")?.toLowerCase() ?? "";
  if (protocol.includes("claude")) return { name: "claude_code", source: "protocol_header" };
  if (protocol.includes("codex")) return { name: "codex", source: "protocol_header" };

  const marker = normalized?.messages.find((message) => message.role === "system" || message.role === "developer")?.content[0];
  const markerText = marker?.type === "text" ? marker.text?.toLowerCase() ?? "" : "";
  if (/\bclaude code\b/.test(markerText)) return { name: "claude_code", source: "prompt_marker" };
  if (/\bcodex\b/.test(markerText)) return { name: "codex", source: "prompt_marker" };
  return { name: "unknown", source: "unknown" };
}

export type StopReason = "completed" | "length" | "tool_call" | "content_filter" | "compaction" | "pause_turn" | "error";

export type StreamEvent =
  | { readonly type: "message_start"; readonly id: string }
  | { readonly type: "thinking_delta"; readonly text: string; readonly reasoningSignature?: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly callId: string; readonly name: string; readonly reasoningSignature?: string }
  | { readonly type: "tool_call_delta"; readonly callId: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly callId: string }
  | { readonly type: "server_tool_result"; readonly block: Readonly<Record<string, unknown>> }
  | { readonly type: "native_block_start"; readonly index: number; readonly block: Readonly<Record<string, unknown>> }
  | { readonly type: "native_block_delta"; readonly index: number; readonly delta: Readonly<Record<string, unknown>> }
  | { readonly type: "native_block_stop"; readonly index: number }
  | { readonly type: "context_item"; readonly phase: "added" | "done"; readonly outputIndex: number; readonly item: Readonly<Record<string, unknown>> }
  | { readonly type: "compaction_start" }
  | { readonly type: "compaction_delta"; readonly text: string }
  | { readonly type: "compaction_stop" }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | { readonly type: "message_stop"; readonly reason: StopReason; readonly error?: SafeErrorSummary };


export interface SafeErrorSummary {
  readonly statusCode: number | null;
  readonly kind: ApplicationErrorKind;
  readonly message: string;
  readonly retryAt: string | null;
}

export interface StreamLifecycle {
  readonly headersCommitted: boolean;
  readonly meaningfulOutput: boolean;
  readonly terminalSeen: boolean;
  readonly close: () => Promise<void>;
}

export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === "message_stop";
}

export interface RequestTelemetry {
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly clientIp?: string | null;
  readonly clientName: ClientIdentity["name"];
  readonly clientSource: ClientIdentity["source"];
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: "non_stream" | "stream" | null;
  readonly statusCode: number | null;
  readonly errorKind: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly usage: ProviderUsage | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly switches: readonly RouteSwitch[];
}

export interface WebSearchFallback {
  readonly previousRouteId: string;
  readonly replacementRouteId: string | null;
  readonly reason: string;
}

export type TranslationDiagnosticStage = "detection" | "normalization" | "request" | "response" | "policy";
export type TranslationDiagnosticAction = "preserved" | "adapted" | "dropped" | "rejected" | "fallback";

export interface TranslationDiagnostic {
  readonly stage: TranslationDiagnosticStage;
  readonly sourceFormat: string;
  readonly targetSurface: Surface;
  readonly fieldCategory: string;
  readonly action: TranslationDiagnosticAction;
  readonly reason: string;
}

/** Compact, secret-free translation adaptation metadata persisted with request routing. */
export interface RequestRoutingMetadata {
  readonly requestedModel: string | null;
  readonly mappedModel: string | null;
  readonly upstreamModel: string | null;
  readonly wireSurface: string | null;
  readonly errorMessage: string | null;
  readonly cacheKeyPresent?: boolean;
  /** True when a stable prefix received an ephemeral/native cache boundary. */
  readonly cacheBreakpointPresent?: boolean;
  /** Search route selected for the request, when web-search routing was active. */
  readonly webSearchRoute?: WebSearchRouteKind;
  /** True when the original route handled a web-search request without a search provider. */
  readonly webSearchPassthrough?: boolean;
  /** Provider fallback attempts kept internal to the client response. */
  readonly webSearchFallbacks?: readonly WebSearchFallback[];
  readonly translationDiagnostics?: readonly TranslationDiagnostic[];
}

export interface RequestTelemetryHandle {
  readonly requestId: string;
  readonly recordSwitch: (event: RouteSwitch) => void;
  readonly recordFirstToken: () => void;
  readonly finish: (result: TelemetryFinish) => Promise<void>;
}

export interface TelemetryFinish {
  readonly statusCode: number;
  readonly errorKind: string | null;
  readonly usage: ProviderUsage | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: "non_stream" | "stream" | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly routing?: RequestRoutingMetadata;
}

export interface TelemetryWriter {
  start(input: Omit<RequestTelemetry, "finishedAt" | "durationMs" | "statusCode" | "errorKind" | "usage" | "providerId" | "model" | "mode" | "switches">): RequestTelemetryHandle;
}

export type ApplicationErrorKind =
  | "invalid_request"
  | "authentication_failed"
  | "authorization_denied"
  | "quota_exceeded"
  | "concurrency_exceeded"
  | "model_not_found"
  | "capability_unsupported"
  | "credential_unavailable"
  | "network_unavailable"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_protocol_error"
  | "stream_timeout"
  | "stream_truncated"
  | "client_aborted"
  | "internal_error";

export type ErrorSource = "internal" | "upstream" | "client";

/** Stable provider failure categories used by retry, health, and telemetry policy. */
export type ProviderFailureCode =
  | "auth_invalidated"
  | "usage_limit"
  | "rate_limit_transient"
  | "context_overflow"
  | "stale_response_state"
  | "empty_provider_body"
  | "provider_finish_error"
  | "content_blocked"
  | "tool_schema_rejected"
  | "optional_parameter_rejected"
  | "stream_pre_response_timeout"
  | "stream_idle_timeout"
  | "stream_total_timeout"
  | "caller_aborted"
  | "unknown_provider_failure";

/** Transport phase supplied to the stable provider failure classifier. */
export type ProviderFailurePhase = "pre_response" | "idle" | "total" | "caller_abort";

/** Bounded, secret-free inputs accepted by {@link classifyProviderFailure}. */
export interface ProviderFailureClassificationInput {
  readonly statusCode?: number | null;
  readonly structuredCode?: unknown;
  readonly message?: unknown;
  readonly phase?: ProviderFailurePhase | null;
  readonly bodyState?: "present" | "empty" | "truncated";
  readonly callerAborted?: boolean;
  readonly kind?: ApplicationErrorKind;
  readonly failureCode?: ProviderFailureCode;
}

export interface ProviderCallError {
  readonly statusCode: number | null;
  readonly kind: ApplicationErrorKind;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly source: ErrorSource;
  readonly sanitizedMessage: string;
  readonly retryAt: string | null;
  /** Optional for source compatibility; normalized failures always populate it. */
  readonly failureCode?: ProviderFailureCode;
}

/**
 * Derives whether a failure originated inside Cartethyia, from an upstream
 * provider response, or from the client. Uses the error kind and route
 * scope — callers never set this manually, so the classification stays
 * consistent across all construction sites.
 */
export function deriveErrorSource(kind: ApplicationErrorKind, _routeScope: "account" | "proxy" | "provider" | null): ErrorSource {
  // Client-side failures: the caller disconnected or sent a bad request.
  if (kind === "client_aborted" || kind === "invalid_request") return "client";
  // Internal routing/config failures: no upstream was contacted.
  if (kind === "internal_error" || kind === "credential_unavailable" || kind === "capability_unsupported" || kind === "model_not_found") return "internal";
  // Network-level failures: the upstream was unreachable.
  if (kind === "network_unavailable") return "upstream";
  // Everything else with a statusCode or provider scope came from upstream.
  return "upstream";
}

const PROVIDER_FAILURE_CODES: readonly ProviderFailureCode[] = [
  "auth_invalidated",
  "usage_limit",
  "rate_limit_transient",
  "context_overflow",
  "stale_response_state",
  "empty_provider_body",
  "provider_finish_error",
  "content_blocked",
  "tool_schema_rejected",
  "optional_parameter_rejected",
  "stream_pre_response_timeout",
  "stream_idle_timeout",
  "stream_total_timeout",
  "caller_aborted",
  "unknown_provider_failure",
];

function isProviderFailureCode(value: unknown): value is ProviderFailureCode {
  return typeof value === "string" && PROVIDER_FAILURE_CODES.includes(value as ProviderFailureCode);
}

function boundedFailureText(value: unknown, maxLength = MAX_ERROR_MESSAGE_LENGTH): string {
  const source = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return source.slice(0, maxLength).toLowerCase();
}

function structuredFailureCode(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 96).trim().toLowerCase();
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["code", "error_code", "type"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate.slice(0, 96).trim().toLowerCase();
  }
  const nested = record.error;
  return nested === undefined ? "" : structuredFailureCode(nested);
}

function normalizeFailureToken(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function classifyStructuredFailure(value: unknown): ProviderFailureCode | null {
  const token = normalizeFailureToken(structuredFailureCode(value));
  if (token === "") return null;
  if (/^(?:auth|authentication|authorization|unauthorized|invalid_api_key|invalid_credential|invalid_grant|token_expired|token_revoked|oauth_expired)/.test(token)) return "auth_invalidated";
  if (/^(?:usage_limit|quota_exceeded|insufficient_quota|billing_hard_limit|insufficient_balance|spend_limit|payment_required|resource_exhausted)$/.test(token)) return "usage_limit";
  if (/^(?:rate_limit|rate_limit_exceeded|too_many_requests|model_capacity|capacity_exhausted|overloaded|temporarily_unavailable)$/.test(token)) return "rate_limit_transient";
  if (/^(?:context_overflow|context_length_exceeded|maximum_context|prompt_too_long|input_too_large|request_too_large)$/.test(token)) return "context_overflow";
  if (/^(?:stale_response_state|invalid_previous_response|previous_response_not_found|response_not_found|invalid_response_id|unknown_response_id|conversation_not_found)$/.test(token)) return "stale_response_state";
  if (/^(?:empty_response|empty_body|no_content|no_output|response_empty)$/.test(token)) return "empty_provider_body";
  if (/^(?:truncated|stream_truncated|incomplete_response|response_incomplete)$/.test(token)) return "provider_finish_error";
  if (/^(?:provider_finish_error|finish_error|finish_reason_error)$/.test(token)) return "provider_finish_error";
  if (/^(?:content_blocked|content_filter|safety_violation|policy_violation|blocked_content)$/.test(token)) return "content_blocked";
  if (/^(?:tool_schema|tool_schema_rejected|invalid_tool|invalid_function|tool_validation|schema_validation)$/.test(token)) return "tool_schema_rejected";
  if (/^(?:optional_parameter|optional_parameter_rejected|unsupported_parameter|unknown_parameter|unsupported_field|unsupported_option)$/.test(token)) return "optional_parameter_rejected";
  return null;
}

function classifyFailureMessage(value: unknown): ProviderFailureCode | null {
  const message = boundedFailureText(value);
  if (message === "") return null;
  if (/\b(?:invalid|expired|revoked)\b.{0,32}\b(?:api.?key|credential|token|grant)\b|\b(?:authentication|authorization)\b.{0,24}\b(?:failed|invalid|denied|expired)\b/.test(message)) return "auth_invalidated";
  if (/\b(?:usage|quota|billing|credit|balance|spend(?:ing)?|payment)\b.{0,36}\b(?:limit|exceed(?:ed)?|reach(?:ed)?|insufficient|exhaust(?:ed)?|rejected)\b|\b(?:limit|exceed(?:ed)?|insufficient|exhaust(?:ed)?)\b.{0,36}\b(?:usage|quota|credit|balance)\b/.test(message)) return "usage_limit";
  if (/\b(?:context(?: length| window| limit| overflow)?|maximum context|prompt|input)\b.{0,24}\b(?:too long|too large|exceed(?:ed)?|overflow|limit)\b|\btoo many tokens\b/.test(message)) return "context_overflow";
  if (/\b(?:previous_response_id|response.?id|conversation)\b.{0,40}\b(?:stale|invalid|unknown|not found|expired)\b|\bstale\b.{0,24}\bresponse\b/.test(message)) return "stale_response_state";
  if (/\b(?:empty|blank|no content|no output|no response)\b.{0,24}\b(?:body|response|output)?\b|\b(?:response|body)\b.{0,24}\b(?:empty|blank)\b/.test(message)) return "empty_provider_body";
  if (/\b(?:truncated|incomplete|unexpected end|ended before)\b/.test(message)) return "provider_finish_error";
  if (/\b(?:finish.?reason|provider.{0,24}(?:finish|terminal).{0,24}error)\b/.test(message)) return "provider_finish_error";
  if (/\b(?:content.?filter|content blocked|safety|policy violation|blocked by policy)\b/.test(message)) return "content_blocked";
  if (/\b(?:tool|function).{0,36}\bschema\b|\bschema\b.{0,36}\b(?:tool|function)\b|\binvalid\b.{0,24}\b(?:tool|function)\b/.test(message)) return "tool_schema_rejected";
  if (/\b(?:unsupported|unknown|unrecognized)\b.{0,24}\b(?:parameter|field|option)\b|\bnot supported\b.{0,24}\b(?:parameter|field|option)\b|\boptional parameter\b/.test(message)) return "optional_parameter_rejected";
  if (/\b(?:rate.?limit|too many requests|per minute|overloaded|model capacity|temporarily unavailable)\b/.test(message)) return "rate_limit_transient";
  return null;
}

function classifyFailureKind(kind: ApplicationErrorKind | undefined): ProviderFailureCode | null {
  switch (kind) {
    case "client_aborted": return "caller_aborted";
    case "authentication_failed":
    case "authorization_denied": return "auth_invalidated";
    case "quota_exceeded": return "usage_limit";
    case "provider_rate_limited": return "rate_limit_transient";
    case "stream_timeout": return "stream_total_timeout";
    case "stream_truncated": return "provider_finish_error";
    default: return null;
  }
}

/**
 * Classifies a provider failure without retaining or returning provider
 * payloads. Transport phase and caller abort take precedence, followed by
 * HTTP status, structured code, bounded body state, and bounded message text.
 */
export function classifyProviderFailure(input: ProviderFailureClassificationInput): ProviderFailureCode {
  if (isProviderFailureCode(input.failureCode)) return input.failureCode;
  if (input.callerAborted === true || input.phase === "caller_abort" || input.kind === "client_aborted") return "caller_aborted";
  if (input.phase === "pre_response") return "stream_pre_response_timeout";
  if (input.phase === "idle") return "stream_idle_timeout";
  if (input.phase === "total") return "stream_total_timeout";

  const statusCode = input.statusCode;
  const structured = classifyStructuredFailure(input.structuredCode);
  const message = classifyFailureMessage(input.message);
  if (statusCode === 401 || statusCode === 403) return "auth_invalidated";
  if (statusCode === 402) return "usage_limit";
  if (statusCode === 413) return "context_overflow";
  if (statusCode === 429) return structured === "usage_limit" || message === "usage_limit" || /\b(?:quota|usage|billing|credit|balance)\b/.test(boundedFailureText(input.message)) ? "usage_limit" : "rate_limit_transient";
  if (structured !== null) return structured;
  if (input.bodyState === "empty") return "empty_provider_body";
  if (input.bodyState === "truncated") return "provider_finish_error";
  const kind = classifyFailureKind(input.kind);
  if (kind !== null) return kind;
  if (message !== null) return message;
  return "unknown_provider_failure";
}

export type ProviderFailureNormalizationContext = Omit<ProviderFailureClassificationInput, "kind" | "failureCode">;

/**
 * Adds a stable failure code while preserving the legacy error shape and
 * re-sanitizing the diagnostic message at the normalization boundary.
 */
function failureDiagnostic(code: ProviderFailureCode, statusCode: number | null): string {
  switch (code) {
    case "auth_invalidated": return "Provider authentication was rejected";
    case "usage_limit": return "Provider usage limit reached";
    case "rate_limit_transient": return "Provider rate limit exceeded";
    case "context_overflow": return "Provider context limit exceeded";
    case "stale_response_state": return "Provider response state was stale";
    case "empty_provider_body": return "Provider returned an empty response";
    case "provider_finish_error": return "Provider response ended before completion";
    case "content_blocked": return "Provider blocked the requested content";
    case "tool_schema_rejected": return "Provider rejected the tool schema";
    case "optional_parameter_rejected": return "Provider rejected an optional parameter";
    case "stream_pre_response_timeout": return "Provider response headers timed out";
    case "stream_idle_timeout": return "Provider stream went idle";
    case "stream_total_timeout": return "Provider request exceeded its total timeout";
    case "caller_aborted": return "Request aborted by client";
    case "unknown_provider_failure": return statusCode === null ? "Provider request failed" : `Provider request failed with HTTP ${statusCode}`;
  }
}

export function normalizeProviderFailure(error: ProviderCallError, context: ProviderFailureNormalizationContext = {}): ProviderCallError {
  const failureCode = classifyProviderFailure({
    ...context,
    statusCode: context.statusCode ?? error.statusCode,
    kind: error.kind,
    failureCode: error.failureCode,
    message: context.message ?? error.sanitizedMessage,
  });
  return { ...error, sanitizedMessage: failureDiagnostic(failureCode, context.statusCode ?? error.statusCode), failureCode };
}
export interface CleanupHandle {
  readonly release: () => Promise<void>;
}

export interface CleanupStack {
  add(handle: CleanupHandle): void;
  run(): Promise<void>;
}

const MAX_ERROR_MESSAGE_LENGTH = 240;

function errorMessageOf(value: unknown, depth = 0): string | null {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (depth >= 2 || typeof value !== "object" || value === null) return null;
  const record = value as { readonly message?: unknown; readonly detail?: unknown; readonly error?: unknown };
  for (const candidate of [record.message, record.detail, record.error]) {
    const message = errorMessageOf(candidate, depth + 1);
    if (message !== null && message.trim().length > 0) return message;
  }
  return null;
}

export function sanitizeMessage(value: unknown): string {
  const source = errorMessageOf(value) ?? "Provider request failed (no error detail available)";
  const redacted = source
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s"']+/gi, "Authorization: Bearer [redacted]")
    .replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*(?:Bearer\s+)?[^\n"']*/gi, "credential=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > 0 ? redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH) : "Provider request failed (empty error message)";
}

export function boundedRetryAt(value: unknown, nowMs: number, maxDelayMs: number): string | null {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  if (seconds === null || seconds < 0 || seconds > maxDelayMs / 1_000) return null;
  return new Date(nowMs + seconds * 1_000).toISOString();
}
export function publicErrorBody(error: ProviderCallError, requestId: string): PublicErrorBody {
  return {
    error: {
      type: "error",
      code: error.kind,
      message: error.sanitizedMessage,
      request_id: requestId,
      source: error.source,
      origin: error.routeScope,
    },
  };
}

export interface PublicErrorBody {
  readonly error: {
    readonly type: string;
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly source: ErrorSource;
    readonly origin: "account" | "proxy" | "provider" | null;
  };
}
export function createCleanupStack(): CleanupStack {
  const handles: CleanupHandle[] = [];
  let finished = false;
  return {
    add(handle: CleanupHandle): void {
      if (finished) {
        void handle.release().catch((error: unknown) => {
          console.warn(`[Cleanup] release failed: ${sanitizeMessage(error)}`);
        });
        return;
      }
      handles.push(handle);
    },
    async run(): Promise<void> {
      if (finished) return;
      finished = true;
      while (handles.length > 0) {
        const handle = handles.pop();
        if (handle) await handle.release();
      }
    },
  };
}

export interface PresentedProxyResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ResponseBody;
}

export type ResponseBody =
  | { readonly mode: "json"; readonly value: Record<string, unknown> | PublicErrorBody }
  | { readonly mode: "stream"; readonly events: AsyncIterable<StreamEvent> };
