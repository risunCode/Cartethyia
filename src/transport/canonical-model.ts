// Canonical vocabulary shared by every wire family: requests, events, usage,
// and the content-part predicates the pipeline reasons over.
/**
 * Wire protocol families, as a runtime tuple. The console's Elysia body schema
 * and its compatibility-profile validator both project this list, so a new
 * family cannot land in one and be silently missing from the other.
 */
export const WIRE_FAMILIES = ["chat", "responses", "messages", "native"] as const;

/** Wire protocol family selected by a provider route. */
export type WireFamily = (typeof WIRE_FAMILIES)[number];

/**
 * Canonical reasoning efforts, as a runtime tuple. The surface dialects derive
 * their membership set from it, and the probe route's accepted subset is
 * declared separately because it is deliberately narrower.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One canonical reasoning effort. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Public request surface from which a canonical request originated. */
export type SourceSurface = "chat" | "responses" | "messages" | "completion";

export function getHeader(
  headers: Record<string, string> | Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Roles that can occur in an ordered canonical conversation. */
export type Role = "system" | "developer" | "user" | "assistant" | "tool";

/** Canonical cache intent; provider-specific cache mechanics belong to adapters. */
export type CacheHint = "stable_prefix" | { kind: "breakpoint"; list: readonly number[] };

/** A provider-neutral tool declaration. */
export interface ToolDefinition {
  /** Stable tool name used by tool calls. */
  name: string;
  /** Human-readable description supplied to the model. */
  description?: string;
  /** JSON Schema (or an opaque schema representation) for tool arguments. */
  jsonSchema: unknown;
  /** Whether the target should enforce strict schema conformance. */
  strict?: boolean;
  /**
   * Provider-specific streaming hint: begin executing tool input as it
   * streams in rather than waiting for the complete arguments blob
   * (Anthropic Messages `eager_input_streaming`). Ignored by providers
   * that don't support it.
   */
  eager_input_streaming?: boolean;
  /**
   * Provider-specific hint deferring tool schema/definition loading until
   * first invocation (Anthropic Messages `defer_loading`). Ignored by
   * providers that don't support it.
   */
  defer_loading?: boolean;
  /** Optional examples used by providers that support tool input examples. */
  input_examples?: readonly Record<string, unknown>[];
  /** Provider-native tool family, such as web search or code execution. */
  tool_type?: "function" | "custom" | "web_search" | "file_search" | "code_execution" | "computer_use" | "mcp" | "provider";
  /** Whether this tool may be called by a hosted/programmatic caller. */
  allowed_callers?: readonly ("direct" | "programmatic")[];
}

/** Selection policy for model tool invocation. */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; name: string }
  | { type: "custom"; name: string }
  | { type: "allowed_tools"; mode: "auto" | "required"; names: readonly string[] };

/** Common generation controls normalized from each wire surface. */
export interface GenerationControls {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  n?: number;
  stop?: string | readonly string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  service_tier?: string;
  logprobs?: boolean;
  top_logprobs?: number;
  seed?: number;
  /** Provider/model-specific output verbosity. */
  verbosity?: "low" | "medium" | "high";
  /** Scoped provider controls remain extensions rather than canonical fields. */
  [providerExtension: `extension:${string}`]: unknown;
}

/** Model reasoning request intent, including opaque summary handling. */
export interface ReasoningIntent {
  effort?: ReasoningEffort;
  mode?: "standard" | "pro";
  context?: "current_turn" | "all_turns";
  /** Human-readable summary content already produced by a provider. */
  summary?: string;
  /** Requested summary verbosity when generating reasoning. */
  summary_mode?: "auto" | "concise" | "detailed";
  thinking_type?: "enabled" | "adaptive" | "disabled";
  budget_tokens?: number;
  /** [CC] `output_config.task_budget` (task budget, distinct from token budget). */
  task_budget?: number;
  /** Anthropic thinking display policy. */
  display?: "summarized" | "omitted" | "updates";
  /**
   * Anthropic `thinking.block_binding.prefix_mismatch_behavior`. Controls what
   * the API does when a replayed thinking block's prefix no longer matches
   * (e.g. the caller edited the system prompt or tools mid-conversation).
   */
  prefix_mismatch_behavior?: "drop_block" | "error";
  /** Provider-native reasoning state, preserved opaquely for replay. */
  encrypted_content?: string;
}

/** Structured-output response format. */
export type ResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      schema: unknown;
      strict?: boolean;
      /** OpenAI Structured Outputs schema name (required on the Chat wire). */
      name?: string;
      /** OpenAI Structured Outputs schema description. */
      description?: string;
    };

/** An ordered canonical message and its ordered content parts. */
/** Assistant item phase reported by OpenAI reasoning models. */
export type AssistantItemPhase = "commentary" | "final_answer";

export interface CanonicalMessage {
  role: Role;
  content: readonly ContentPart[];
  /** OpenAI Responses assistant phase, preserved for manual replay. */
  phase?: AssistantItemPhase;
}

/**
 * True when a turn may carry `toolResult` parts.
 *
 * Tool answers live in `tool` turns (OpenAI Chat/Responses) **or** in `user`
 * turns — the Anthropic Messages ledger re-homes every tool result there. This
 * is a property of the canonical model, not of any one wire, so it is defined
 * once here: callers that instead test `role === "tool"` silently miss every
 * Messages-origin history, which is how broken tool sequences reached upstream
 * (rejected as `tool_call_sequence_broken` / "tool calls and tool results do
 * not match").
 */
export function canContainToolResult(message: CanonicalMessage): boolean {
  return message.role === "tool" || message.role === "user";
}

/** Every `toolResult` part on a turn, in order. */
export function toolResultParts(
  message: CanonicalMessage,
): readonly Extract<ContentPart, { kind: "toolResult" }>[] {
  return message.content.filter(
    (part): part is Extract<ContentPart, { kind: "toolResult" }> => part.kind === "toolResult",
  );
}

/** Every `toolCall` part on a turn, in order. */
export function toolCallParts(
  message: CanonicalMessage,
): readonly Extract<ContentPart, { kind: "toolCall" }>[] {
  return message.content.filter(
    (part): part is Extract<ContentPart, { kind: "toolCall" }> => part.kind === "toolCall",
  );
}

/**
 * Canonical content vocabulary. Values that have no stable semantic
 * intersection remain in `extension` or opaque `reasoning` parts.
 */
export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; payload: unknown }
  | {
      kind: "file";
      data: unknown;
      media_type: string;
      filename?: string;
      file_id?: string;
      /** Source URL when the file is referenced rather than inlined. */
      url?: string;
    }
  | { kind: "audio"; data: unknown; media_type: string }
  | {
      kind: "document";
      data: unknown;
      media_type: string;
      title?: string;
      citations?: boolean;
      /**
       * Original source discriminator (`base64`/`url`/`file`/`text`) so a
       * document survives a cross-wire round trip: OpenAI carries `file_url` or
       * `file_id`, Anthropic carries `source.type`, and neither may be
       * collapsed into the other without losing the reference.
       */
      source_type?: "base64" | "url" | "file" | "text";
      /** Source URL when `source_type === "url"`. */
      url?: string;
      /** Files API id when `source_type === "file"`. */
      file_id?: string;
    }
  | { kind: "refusal"; text: string }
  | {
      kind: "toolCall";
      call_id: string;
      name: string;
      /** Arguments stay opaque so adapters own parsing and repair policy. */
      arguments: unknown;
      index?: number;
      /**
       * Responses item id, retained when the source protocol supplies a
       * distinct item id from the call id so a replay can reconstruct the
       * original `function_call` item verbatim.
       */
      item_id?: string;
      /**
       * Wire tool-call family for providers that distinguish plain function
       * calls from custom-grammar or computer-use calls (e.g. Codex
       * Responses `function_call` | `custom_tool_call` | `computer_call`).
       * Absent means `"function"` — the historically only supported kind.
       */
      call_kind?: "function" | "custom" | "computer";
    }
  | {
      kind: "toolResult";
      call_id: string;
      content: readonly ContentPart[] | string;
      is_error?: boolean;
      /** Mirrors the originating `toolCall.call_kind`; absent means `"function"`. */
      call_kind?: "function" | "custom" | "computer";
      /** Responses item id, retained for replay fidelity alongside `toolCall.item_id`. */
      item_id?: string;
    }
  | {
      kind: "reasoning";
      /** Opaque payloads are never decrypted or converted to answer text. */
      payload: unknown;
      opaque?: true;
      summary?: string;
      /** Responses reasoning summary block index, preserved across surfaces. */
      summary_index?: number;
      signature?: string;
      encrypted_content?: string;
    }
  | { kind: "extension"; name: string; payload: unknown };

/** A canonical response/event stream lifecycle state. */
type TerminalState = "complete" | "failed" | "aborted";

/**
 * Canonical, protocol-neutral stop reason. Provider adapters populate this
 * from their own upstream vocabulary (e.g. Anthropic `end_turn`/`tool_use`,
 * OpenAI `stop`/`tool_calls`) instead of passing the raw string through;
 * surface encoders map it back into their own wire vocabulary
 * (OpenAI `finish_reason`, Anthropic `stop_reason`, Responses
 * `incomplete_details.reason`). This keeps cross-provider routing from
 * leaking one protocol's stop-reason vocabulary into another's response.
 */
export type CanonicalStopReason =
  | "stop"
  | "length"
  | "tool_use"
  | "content_filter"
  | "refusal"
  | "error"
  | "cancelled"
  | "pause_turn";

/**
 * The canonical terminal event: exactly one closes every stream.
 *
 * Named so the shared `canonicalTerminal` builder can return it directly rather
 * than a loosely-typed record each caller has to cast.
 */
export interface CanonicalTerminalEvent {
  readonly type: "terminal";
  readonly sequence_number: number;
  readonly state: TerminalState;
  readonly stop_reason?: CanonicalStopReason;
  /**
   * Original provider-native stop/finish-reason string, preserved losslessly
   * for diagnostics and same-provider passthrough. Surface encoders MUST NOT
   * switch on this field; use `stop_reason`.
   */
  readonly provider_stop_reason?: string;
  /**
   * Provider-native stop details (e.g. Anthropic `stop_details` for
   * refusal/sensitive). Preserved for observability; surface encoders may
   * surface as error detail. Undocumented providers may populate this with
   * their own structured reason.
   */
  readonly stop_details?: Record<string, unknown>;
  readonly usage?: UsageRecord;
  readonly event_id?: string;
  readonly response_id?: string;
  /** Event timestamp in milliseconds since epoch (optional for profiling). */
  readonly timestamp?: number;
}

/** An ordered canonical stream event; sequence numbers must increase monotonically. */
export type CanonicalEvent =
  | {
      type: "message_start" | "response_start";
      sequence_number: number;
      event_id?: string;
      response_id?: string;
      model?: string;
      /** Provider response fingerprint (OpenAI `system_fingerprint`), when supplied. */
      system_fingerprint?: string;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | {
      type: "content_delta";
      sequence_number: number;
      content: ContentPart;
      event_id?: string;
      response_id?: string;
      item_id?: string;
      output_index?: number;
      content_index?: number;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | {
      type: "tool_call_delta";
      sequence_number: number;
      call_id: string;
      /** Wire tool-call index, retained when the source protocol supplies it. */
      index?: number;
      name?: string;
      arguments_delta?: string;
      event_id?: string;
      response_id?: string;
      item_id?: string;
      output_index?: number;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | {
      type: "tool_result";
      sequence_number: number;
      call_id: string;
      content: readonly ContentPart[];
      event_id?: string;
      response_id?: string;
      item_id?: string;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | {
      type: "usage";
      sequence_number: number;
      usage: UsageRecord;
      event_id?: string;
      response_id?: string;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | {
      type: "keepalive";
      sequence_number: number;
      event_id?: string;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    }
  | CanonicalTerminalEvent
  | {
      type: "error";
      sequence_number: number;
      category: string;
      message: string;
      event_id?: string;
      response_id?: string;
      retryable?: boolean;
      /** Event timestamp in milliseconds since epoch (optional for profiling). */
      timestamp?: number;
    };

/** A reported or explicitly unavailable token count. */
export type TokenCount = number | "unavailable";

/** Provider-normalized token and cost accounting without double counting. */
export interface UsageRecord {
  input_tokens: number;
  cached_input_tokens: TokenCount;
  cache_write_tokens: TokenCount;
  uncached_input_tokens: TokenCount;
  output_tokens: number;
  reasoning_tokens: TokenCount;
  /**
   * Estimated USD cost, or `null` when no price is known for the routed
   * provider/model.
   *
   * `null` is not `0`: zero is a real answer (a free tier, a genuinely
   * zero-priced route), while `null` says the catalog had no rate to apply. The
   * two must stay distinguishable or the analytics `partial` flag — which
   * counts completed rows with no persisted cost — can never fire, and an
   * unpriced route reports `$0.00` as if it were measured. A route the catalog
   * cannot price is unpriced, not free.
   */
  estimated_cost: number | null;
  total_tokens?: number | "unavailable";
  details?: {
    accepted_prediction_tokens?: number | "unavailable";
    rejected_prediction_tokens?: number | "unavailable";
  };
}

/** Provider state needed to continue a stateful or opaque conversation. */
export interface ConversationState {
  response_id?: string;
  previous_response_id?: string;
  conversation_id?: string;
  provider_state?: Record<string, unknown>;
}

/** Canonical request passed between surface and provider adapters. */
export interface CanonicalRequest {
  model: string;
  /** Canonical system content normalized by a surface adapter. */
  system?: readonly ContentPart[];
  /** Canonical instructions content normalized by a surface adapter. */
  instructions?: readonly ContentPart[];
  messages: readonly CanonicalMessage[];
  tools?: readonly ToolDefinition[];
  tool_choice?: ToolChoice;
  generation_controls: GenerationControls;
  reasoning?: ReasoningIntent;
  response_format?: ResponseFormat;
  cache_hint?: CacheHint;
  conversation?: ConversationState;
  metadata?: Record<string, string | number | boolean | null>;
  provider_options?: Record<string, unknown>;
  /** Codex-specific sticky routing identity, surfaced from inbound metadata. */
  session_id?: string;
  thread_id?: string;
  window_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  conversation_id?: string;
  residency?: string;
  stream: boolean;
  source_surface: SourceSurface;
}


// Shared canonical-request content-part predicates.
export function allParts(request: CanonicalRequest): readonly ContentPart[] {

  return [
    ...(request.system ?? []),
    ...(request.instructions ?? []),
    ...request.messages.flatMap((message) => message.content),
  ];
}

export function hasKind(parts: readonly ContentPart[], kind: ContentPart["kind"]): boolean {
  return parts.some((part) => part.kind === kind);
}

/**
 * Text of the first non-empty text part of the first user turn, or `""`.
 *
 * Several providers seed a per-session identifier from the opening user turn
 * (Antigravity's signed session id, the billing version suffix), so the
 * captured shape — first user message, first non-empty text part — has to be
 * the same everywhere rather than each provider walking messages its own way.
 */
export function firstUserText(request: CanonicalRequest): string {
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.kind === "text" && part.text.length > 0) return part.text;
    }
  }
  return "";
}

/**
 * One message's text parts joined by newlines, in order.
 *
 * The flattening the protobuf wire families need where a field carries a single
 * string and the canonical model allows several text parts.
 */
export function joinTextParts(parts: readonly ContentPart[]): string {
  const text: string[] = [];
  for (const part of parts) {
    if (part.kind === "text") text.push(part.text);
  }
  return text.join("\n");
}

export function hasExtension(parts: readonly ContentPart[], name: string): boolean {
  return parts.some((part) => part.kind === "extension" && part.name === name);
}

export function hasOpaqueReasoning(parts: readonly ContentPart[]): boolean {
  return parts.some((part) => part.kind === "reasoning" && part.opaque === true);
}

export function hasEncryptedReasoning(parts: readonly ContentPart[]): boolean {
  return parts.some((part) => part.kind === "reasoning" && part.encrypted_content !== undefined);
}

/**
 * Single-pass summary of a request's content parts.
 *
 * `deriveRequiredCapabilities` + `assessTranslation` run on every candidate
 * preflight and previously each flattened the whole request (`allParts`) and
 * then scanned the copy up to ~6 times. This walks the messages once, builds
 * no intermediate array, and answers every predicate the pipeline needs.
 * Results are memoized per request object in a `WeakMap`, so the preflight +
 * translate passes over one request share a single summary and entries are
 * collected with the request itself — no manual invalidation, no leak.
 * (Deliberately not a shared object pool: pooled mutable arrays across
 * concurrent preflights would be an aliasing hazard; the memoized summary and
 * its extension set are treated as read-only.)
 */
export interface PartSummary {
  readonly hasImage: boolean;
  readonly hasDocument: boolean;
  readonly hasAudio: boolean;
  readonly hasWebSearch: boolean;
  readonly hasToolActivity: boolean;
  readonly hasOpaqueReasoning: boolean;
  readonly hasEncryptedReasoning: boolean;
  readonly extensionNames: ReadonlySet<string>;
}

const partSummaryCache = new WeakMap<CanonicalRequest, PartSummary>();

export function summarizeParts(request: CanonicalRequest): PartSummary {
  const cached = partSummaryCache.get(request);
  if (cached) return cached;
  let hasImage = false;
  let hasDocument = false;
  let hasAudio = false;
  let hasToolActivity = false;
  let hasOpaqueReasoning = false;
  let hasEncryptedReasoning = false;
  let extensionNames: Set<string> | undefined;
  const inspect = (part: ContentPart): void => {
    switch (part.kind) {
      case "image":
        hasImage = true;
        break;
      case "document":
      case "file":
        hasDocument = true;
        break;
      case "audio":
        hasAudio = true;
        break;
      case "toolCall":
      case "toolResult":
        hasToolActivity = true;
        break;
      case "reasoning":
        if (part.opaque === true) hasOpaqueReasoning = true;
        if (part.encrypted_content !== undefined) hasEncryptedReasoning = true;
        break;
      case "extension":
        (extensionNames ??= new Set()).add(part.name);
        break;
    }
  };
  for (const part of request.system ?? []) inspect(part);
  for (const part of request.instructions ?? []) inspect(part);
  for (const message of request.messages) {
    for (const part of message.content) inspect(part);
  }
  // Web search is requested through a hosted tool declaration rather than a
  // content part, so it is derived from `request.tools` in the same pass.
  const hasWebSearch =
    request.tools?.some(
      (tool) => tool.tool_type === "web_search" || tool.name === "web_search",
    ) === true;
  const summary: PartSummary = {
    hasImage,
    hasDocument,
    hasAudio,
    hasWebSearch,
    hasToolActivity,
    hasOpaqueReasoning,
    hasEncryptedReasoning,
    extensionNames: extensionNames ?? new Set(),
  };
  partSummaryCache.set(request, summary);
  return summary;
}
