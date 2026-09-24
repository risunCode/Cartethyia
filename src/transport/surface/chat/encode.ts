import type { CanonicalEvent, CanonicalStopReason } from "../../canonical-model";
import { eventText } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import {
  createToolCallTracker,
  trackToolCall,
  type ToolCallState,
} from "../../tool-identity";
import { usageToChatWire, type OpenAiUsage } from "../../../providers/usage";
import { TEXT_ENCODER } from "../stream-frame";
import { SurfaceStreamEncoder } from "../stream-base";
import type { ChatEncodeOptions, ChunkBase, JsonObject } from "./parse";

export function bytesToString(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export function getResponseId(options: ChatEncodeOptions, events: CanonicalEvent[]): string {
  if (options.response_id !== undefined) return options.response_id;
  if (options.responseId !== undefined) return options.responseId;
  const start = events.find(
    (event) => event.type === "response_start" || event.type === "message_start",
  );
  return start !== undefined && "event_id" in start && start.event_id !== undefined
    ? start.event_id
    : `chatcmpl-${crypto.randomUUID()}`;
}

export function getModel(options: ChatEncodeOptions, events: CanonicalEvent[]): string {
  if (options.model !== undefined) return options.model;
  const start = events.find(
    (event) => event.type === "response_start" || event.type === "message_start",
  );
  return start !== undefined && "model" in start ? (start.model ?? "") : "";
}

/**
 * Resolves the `obfuscation` padding for the stream.
 *
 * `pinned` distinguishes an operator-configured value (`obfuscation`/`padding`
 * in the options) from the synthesized placeholder emitted when the caller
 * only asked for the field to be present. Upstream padding outranks the
 * placeholder — passing the provider's own bytes through is the whole point of
 * the extension — but never an explicit configuration.
 */
export function resolveObfuscation(options: ChatEncodeOptions): {
  value: string | undefined;
  pinned: boolean;
} {
  const configured = options.obfuscation ?? options.padding;
  if (configured !== undefined) return { value: bytesToString(configured), pinned: true };
  if (options.include_obfuscation ?? options.includeObfuscation) {
    return { value: "0000000000000000", pinned: false };
  }
  return { value: undefined, pinned: false };
}

export function eventObfuscation(event: CanonicalEvent): string | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "extension") return undefined;
  if (!event.content.name.includes("obfuscat")) return undefined;
  const payload = event.content.payload;
  return typeof payload === "string" || payload instanceof Uint8Array
    ? bytesToString(payload)
    : undefined;
}

/** Audio output payload carried as an `audio` extension content part. */
export function eventAudio(event: CanonicalEvent): Record<string, unknown> | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "extension") return undefined;
  if (event.content.name !== "audio") return undefined;
  return isRecord(event.content.payload) ? event.content.payload : undefined;
}

export function eventReasoningText(event: CanonicalEvent): string | undefined {
  if (event.type !== "content_delta" || event.content.kind !== "reasoning") return undefined;
  if (event.content.opaque === true) return undefined;
  if (typeof event.content.payload === "string") return event.content.payload;
  return typeof event.content.summary === "string" ? event.content.summary : undefined;
}

function mergedReasoningText(events: readonly CanonicalEvent[]): string {
  let previousSummaryIndex: number | undefined;
  let hadReasoning = false;
  return events
    .map((event) => {
      const text = eventReasoningText(event);
      if (text === undefined) return undefined;
      const index =
        event.type === "content_delta" && event.content.kind === "reasoning"
          ? event.content.summary_index
          : undefined;
      const separator =
        hadReasoning &&
        (index === undefined ||
          previousSummaryIndex === undefined ||
          index !== previousSummaryIndex)
          ? "\n\n"
          : "";
      hadReasoning = true;
      if (index !== undefined) previousSummaryIndex = index;
      return `${separator}${text}`;
    })
    .filter((value): value is string => value !== undefined)
    .join("");
}

export function finishReason(stopReason: CanonicalStopReason | undefined): string {
  if (stopReason !== undefined) {
    switch (stopReason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "content_filter":
        return "content_filter";
      case "refusal":
        // Refusals are content filters on this wire, not normal stops:
        // reporting "stop" hides a refusal as a usable completion.
        return "content_filter";
      case "error":
        // Failed streams keep an explicit error reason (107 precedent):
        // the failure is real and must survive into retry accounting.
        return "error";
      case "cancelled":
        return "error";
      case "pause_turn":
        // OpenAI Chat has no pause_turn vocabulary; map to stop as closest graceful continuation signal.
        // This preserves cross-provider routing without leaking unknown finish_reason.
        return "stop";
      default:
        stopReason satisfies never;
        return "stop";
    }
  }
  // No "cancelled"/"error" on the Chat wire: aborted streams are unread and
  // failed streams carry their signal in the error frame/envelope instead.
  // (The explicit stop_reason branches above already handled every known
  // reason; this default only fires when none was recorded.)
  return "stop";
}
export function eventToolCall(
  event: CanonicalEvent,
): { state: ToolCallState; hasArguments: boolean } | undefined {
  if (event.type === "tool_call_delta") {
    const index = typeof event.index === "number" && event.index >= 0 ? event.index : -1;
    const state: ToolCallState = {
      id: event.call_id,
      arguments: event.arguments_delta ?? "",
      index,
    };
    if (event.name !== undefined) state.name = event.name;
    return {
      state,
      hasArguments: event.arguments_delta !== undefined,
    };
  }
  if (event.type === "content_delta" && event.content.kind === "toolCall") {
    return {
      state: {
        id: event.content.call_id,
        name: event.content.name,
        arguments:
          typeof event.content.arguments === "string"
            ? event.content.arguments
            : JSON.stringify(event.content.arguments),
        index: event.content.index ?? -1,
      },
      hasArguments: true,
    };
  }
  return undefined;
}

export function chunk(
  base: Omit<ChunkBase, "choices" | "usage">,
  choices: unknown[],
  usage: OpenAiUsage | null,
  obfuscation?: string,
): ChunkBase {
  return {
    ...base,
    choices,
    usage,
    ...(obfuscation === undefined ? {} : { obfuscation }),
  };
}
export function asJsonBytes(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value));
}

export function jsonCompletion(
  events: CanonicalEvent[],
  options: ChatEncodeOptions,
  model: string,
  id: string,
  created: number,
): JsonObject {
  const content = events
    .map(eventText)
    .filter((value): value is string => value !== undefined)
    .join("");
  const reasoningContent = mergedReasoningText(events);
  const toolCalls = new Map<number, ToolCallState>();
  const tracker = createToolCallTracker();
  let terminalFinishReason: string | null = null;
  let usage: OpenAiUsage | null = null;
  const cancelled =
    options.cancelled === true || options.aborted === true || options.signal?.aborted === true;
  for (const event of events) {
    const tool = eventToolCall(event);
    if (tool) {
      const tracked = trackToolCall(tracker, {
        id: tool.state.id,
        name: tool.state.name,
        args: tool.state.arguments,
        index: tool.state.index,
      });
      toolCalls.set(tracked.index, tracked.state);
    }
    if (event.type === "usage") {
      usage = usageToChatWire(event.usage);
      continue;
    }
    if (event.type === "terminal") {
      terminalFinishReason = finishReason(event.stop_reason);
      if (!cancelled && event.state !== "aborted" && event.usage) usage = usageToChatWire(event.usage);
    }
  }
  if (cancelled) usage = null;
  const message: JsonObject = {
    role: "assistant",
    content: content.length === 0 ? null : content,
    ...(reasoningContent.length === 0 ? {} : { reasoning_content: reasoningContent }),
  };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .map((tool) => ({
        id: tool.id,
        type: "function",
        // Zero-argument calls assemble as "{}": an empty string is not
        // valid JSON for the client's parser.
        function: { name: tool.name ?? "", arguments: tool.arguments.length > 0 ? tool.arguments : "{}" },
      }));
  }
  const audio = events.map(eventAudio).findLast((value) => value !== undefined);
  if (audio !== undefined) message.audio = audio;
  const result: JsonObject = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: terminalFinishReason }],
    usage,
  };
  const terminal = events.findLast((event) => event.type === "terminal");
  if (terminal?.type === "terminal" && terminal.state === "failed") {
    result.error = {
      type: "server_error",
      code: terminal.stop_reason ?? "provider_error",
      message: "The upstream response failed",
    };
  }
  const serviceTier = options.service_tier ?? options.serviceTier;
  if (serviceTier !== undefined) result.service_tier = serviceTier;
  const start = events.find(
    (event): event is Extract<CanonicalEvent, { type: "response_start" | "message_start" }> =>
      event.type === "response_start" || event.type === "message_start",
  );
  if (start?.system_fingerprint !== undefined)
    result.system_fingerprint = start.system_fingerprint;
  return result;
}

/**
 * Incremental SSE encoder for Chat Completions. It is the only encoder for
 * this surface: it preserves state across individual `push` calls so a
 * handler can flush `data: ...` lines as upstream `CanonicalEvent`s arrive.
 */
export class ChatStreamEncoder extends SurfaceStreamEncoder<CanonicalEvent, JsonObject> {
  private readonly base: {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    service_tier?: string;
  };
  private tracker = createToolCallTracker();
  private finalUsage: OpenAiUsage | null = null;
  private terminalState: "complete" | "failed" | "aborted" | undefined;
  private terminalReason: string | undefined;
  private configuredObfuscation: string | undefined;
  // Set when `configuredObfuscation` is an operator-configured value rather
  // than the synthesized placeholder, so upstream padding knows whether it is
  // allowed to take over once the extension event arrives.
  private readonly obfuscationPinned: boolean;
  private readonly serviceTier: string | undefined;
  private readonly includeUsage: boolean | undefined;
  private readonly cancelled: boolean;
  private emittedAny = false;
  private previousReasoningSummaryIndex: number | undefined;
  private baseModel: string;
  private baseId: string;
  private readonly created: number;

  constructor(
    private readonly options: ChatEncodeOptions = {},
    model?: string,
    id?: string,
    created?: number,
  ) {
    super();
    this.baseModel = model ?? options.model ?? "";
    this.baseId = id ?? options.response_id ?? options.responseId ?? `chatcmpl-${crypto.randomUUID()}`;
    this.created = created ?? options.created ?? Math.floor(Date.now() / 1000);
    this.serviceTier = options.service_tier ?? options.serviceTier;
    this.includeUsage = options.include_usage ?? options.includeUsage;
    this.cancelled =
      options.cancelled === true || options.aborted === true || options.signal?.aborted === true;
    const obfuscation = resolveObfuscation(options);
    this.configuredObfuscation = obfuscation.value;
    this.obfuscationPinned = obfuscation.pinned;
    this.base = {
      id: this.baseId,
      object: "chat.completion.chunk" as const,
      created: this.created,
      model: this.baseModel,
      ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
    };
  }

  private withBase(
    choices: unknown[],
    usage: OpenAiUsage | null,
    obfuscation?: string,
  ): JsonObject {
    return {
      ...chunk(
        {
          ...this.base,
          ...(this.serviceTier === undefined ? {} : { service_tier: this.serviceTier }),
        },
        choices,
        usage,
        obfuscation ?? this.configuredObfuscation,
      ),
    };
  }

  push(event: CanonicalEvent): JsonObject[] {
    const result: JsonObject[] = [];
    if (event.type === "usage") {
      this.finalUsage = usageToChatWire(event.usage);
      return result;
    }
    if (
      (event.type === "message_start" || event.type === "response_start") &&
      event.model !== undefined
    ) {
      if (
        this.options.model === undefined &&
        this.options.response_id === undefined &&
        this.options.responseId === undefined
      ) {
        if (event.model !== this.baseModel) {
          this.baseModel = event.model;
          (this.base as unknown as Record<string, unknown>).model = event.model;
        }
        if (event.event_id !== undefined && event.event_id !== this.baseId) {
          this.baseId = event.event_id;
          (this.base as unknown as Record<string, unknown>).id = event.event_id;
        }
      }
    }
    const eventPadding = eventObfuscation(event);
    if (eventPadding !== undefined && !this.obfuscationPinned) {
      this.configuredObfuscation = eventPadding;
    }
    const padding = this.configuredObfuscation;
    if (event.type === "message_start" || event.type === "response_start") {
      result.push(
        this.withBase(
          [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    const reasoningText = eventReasoningText(event);
    if (reasoningText !== undefined) {
      const summaryIndex =
        event.type === "content_delta" && event.content.kind === "reasoning"
          ? event.content.summary_index
          : undefined;
      const separator =
        summaryIndex !== undefined &&
        this.previousReasoningSummaryIndex !== undefined &&
        summaryIndex !== this.previousReasoningSummaryIndex
          ? "\n\n"
          : "";
      if (summaryIndex !== undefined) this.previousReasoningSummaryIndex = summaryIndex;
      result.push(
        this.withBase(
          [{ index: 0, delta: { reasoning_content: `${separator}${reasoningText}` }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    const text = eventText(event);
    if (text !== undefined) {
      result.push(
        this.withBase([{ index: 0, delta: { content: text }, finish_reason: null }], null, padding),
      );
      this.emittedAny = true;
      return result;
    }
    const audio = eventAudio(event);
    if (audio !== undefined) {
      result.push(
        this.withBase([{ index: 0, delta: { audio }, finish_reason: null }], null, padding),
      );
      this.emittedAny = true;
      return result;
    }
    const tool = eventToolCall(event);
    if (tool) {
      const tracked = trackToolCall(this.tracker, {
        id: tool.state.id,
        name: tool.state.name,
        args: tool.state.arguments,
        index: tool.state.index,
      });
      const delta: JsonObject = {
        index: tracked.index,
        ...(tracked.isFirst ? { id: tool.state.id } : {}),
        type: "function",
        function: {
          ...(tool.state.name === undefined ? {} : { name: tool.state.name }),
          arguments: tool.state.arguments,
        },
      };
      result.push(
        this.withBase(
          [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }],
          null,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    if (event.type === "keepalive") {
      result.push(this.withBase([], null, padding));
      this.emittedAny = true;
      return result;
    }
    if (event.type === "terminal") {
      this.terminalState = event.state;
      this.terminalReason = finishReason(event.stop_reason);
      if (!this.cancelled && event.state !== "aborted" && event.usage)
        this.finalUsage = usageToChatWire(event.usage);
      const usage = this.cancelled || event.state === "aborted" ? null : this.finalUsage;
      result.push(
        this.withBase(
          [{ index: 0, delta: {}, finish_reason: this.terminalReason }],
          usage,
          padding,
        ),
      );
      this.emittedAny = true;
      return result;
    }
    return result;
  }

  finish(): JsonObject[] {
    const result: JsonObject[] = [];
    if (this.terminalState === undefined && !this.emittedAny) {
      result.push(this.withBase([], null, this.configuredObfuscation));
    }
    if (
      this.includeUsage === true &&
      this.terminalState === "complete" &&
      !this.cancelled &&
      this.finalUsage !== null
    ) {
      result.push(this.withBase([], this.finalUsage, this.configuredObfuscation));
    }
    return result;
  }
}
