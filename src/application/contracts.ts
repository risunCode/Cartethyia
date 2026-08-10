export type Surface = "openai-chat" | "openai-responses" | "anthropic-messages" | "images" | "web-search";
export type Protocol = "openai" | "anthropic" | "gemini" | "exa" | "devin";
export type CredentialKind = "api_key" | "oauth" | "manual" | "none";

/** Network routing preset shared by proxy settings and the network selector. */
export type RoutingPreset = "auto" | "target-user" | "target-concurrent";

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

export interface ProviderCaps {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly toolCalls: boolean;
  readonly images: boolean;
  readonly explicitCache: boolean;
  readonly promptCacheKey: boolean;
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
  /** Original client headers needed for transparent provider passthrough. */
  readonly headers?: Headers;
  readonly capture?: PayloadCapture;
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
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
  readonly type: "text" | "image" | "tool_use" | "tool_result" | "compaction" | "unknown";
  readonly text?: string;
  readonly cacheControl?: "ephemeral";
  readonly image?: ImageReference;
  readonly toolName?: string;
  readonly toolCallId?: string;
  /** JSON-encoded function arguments preserved across protocol adapters. */
  readonly toolArguments?: string;
  readonly toolResultIsError?: boolean;
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
  /** Original Anthropic server-tool type, when the client supplied one. */
  readonly nativeType?: "web_search_20250305";
  /** Bounded options preserved for Anthropic server tools. */
  readonly nativeOptions?: Readonly<Record<string, unknown>>;
  /**
   * Precomputed `JSON.stringify(inputSchema).length`, set during normalization
   * so the cache planner reuses it instead of re-serializing the schema per
   * request. Absent on hand-built tools; consumers fall back to serializing.
   */
  readonly schemaJsonLength?: number;
}

export interface ProxyRequest {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly stream: boolean;
  readonly responseFormat: "text" | "json_object" | "json_schema";
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
  /** Remote provider context-compaction configuration, preserved by native adapters. */
  readonly contextManagement?: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];
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
  /** Client-supplied Claude Code metadata.user_id, when present. */
  readonly metadataUserId?: string;
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

export function detectClient(headers: Headers, normalized?: ProxyRequest): ClientIdentity {
  const explicit = headers.get("x-client-name")?.trim().toLowerCase();
  const names: Readonly<Record<string, ClientName>> = {
    github_copilot: "github_copilot",
    claude_code: "claude_code",
    codex: "codex",
    cursor: "cursor",
    cline: "cline",
    opencode: "opencode",
    pi: "pi",
  };
  const explicitName = explicit ? names[explicit] : undefined;
  if (explicitName) return { name: explicitName, source: "explicit_header" };

  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("claude-cli")) return { name: "claude_code", source: "user_agent" };
  for (const [needle, name] of Object.entries(names)) {
    if (userAgent.includes(needle.replace("_", "-")) || userAgent.includes(needle)) {
      return { name, source: "user_agent" };
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

export type StopReason = "completed" | "length" | "tool_call" | "content_filter" | "compaction" | "error";

export type StreamEvent =
  | { readonly type: "message_start"; readonly id: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly callId: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly callId: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly callId: string }
  | { readonly type: "context_item"; readonly phase: "added" | "done"; readonly outputIndex: number; readonly item: Readonly<Record<string, unknown>> }
  | { readonly type: "compaction_start" }
  | { readonly type: "compaction_delta"; readonly text: string }
  | { readonly type: "compaction_stop" }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | { readonly type: "message_stop"; readonly reason: StopReason };


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

export interface ProviderCallError {
  readonly statusCode: number | null;
  readonly kind: ApplicationErrorKind;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly source: ErrorSource;
  readonly sanitizedMessage: string;
  readonly retryAt: string | null;
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

export interface SafeErrorSummary {
  readonly statusCode: number | null;
  readonly kind: ApplicationErrorKind;
  readonly message: string;
  readonly retryAt: string | null;
}

export interface CleanupHandle {
  readonly release: () => Promise<void>;
}

export interface CleanupStack {
  add(handle: CleanupHandle): void;
  run(): Promise<void>;
}

const MAX_ERROR_MESSAGE_LENGTH = 240;

export function sanitizeMessage(value: unknown): string {
  const source = value instanceof Error ? value.message : typeof value === "string" ? value : "Provider request failed (no error detail available)";
  const redacted = source
    .replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\n"']*/gi, "credential=[redacted]")
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
        void handle.release();
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
