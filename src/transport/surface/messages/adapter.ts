import type { CanonicalEvent, CanonicalRequest, GenerationControls, ReasoningIntent } from "../../canonical-model";
import type { SurfaceAdapter } from "../adapters";
import { requiredObject } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import { TEXT_ENCODER } from "../stream-frame";
import type { MessagesEncodingContext, MessagesErrorResponse, MessagesParseOptions, MessagesResponse } from "./parse";
import {
  asSurfaceBody,
  cacheHint,
  extensionControls,
  parseMessage,
  parseThinking,
  parseTools,
  systemBlocks,
  applyMessagesToolLedger,
} from "./parse";
import { CANONICAL_REASONING_EFFORTS, parseToolChoice } from "../dialects";
import { groupedBlocks, startModel, stopData } from "./encode";
import { finiteNumber, stringValue } from "../../../protocol/primitives";
import { usageToMessagesWire } from "../../../providers/usage";

export class MessagesAdapter implements SurfaceAdapter {
  readonly surface = "messages" as const;

  /** Pure body-shape check used by the once-only surface registry. */
  matchesBodyShape(body: unknown): boolean {
    return (
      isRecord(body) &&
      Array.isArray(body.messages) &&
      ("max_tokens" in body || "maxTokens" in body) &&
      typeof body.model === "string"
    );
  }

  /** Parse a Messages wire request into the canonical request model. */
  parse(input: unknown, options: MessagesParseOptions = {}): CanonicalRequest {
    const supplied = asSurfaceBody(input);
    const body = requiredObject(supplied.body, "request");
    const headers = options.headers ?? supplied.headers;
    if (!stringValue(body.model)) throw new Error("Messages request requires model");
    if (!Array.isArray(body.messages)) throw new Error("Messages request requires messages[]");
    const maxTokens = body.max_tokens ?? body.maxTokens;
    if (!finiteNumber(maxTokens) || !Number.isInteger(maxTokens) || maxTokens <= 0)
      throw new Error("Messages request requires positive integer max_tokens");
    const declaredSystem = systemBlocks(body.system);
    const parsedMessages = body.messages.map(parseMessage);
    // Claude Code (and other first-party clients) send an environment/context
    // turn as `role: "system"` *inside* `messages[]`. Providers only accept
    // system content at the top level, so hoist it there — declared `system`
    // first, then the mid-conversation turns in order — exactly as the
    // reference gateways do. The alternative (rejecting) breaks the client.
    const hoistedSystem = parsedMessages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content);
    const system =
      declaredSystem === undefined && hoistedSystem.length === 0
        ? undefined
        : [...(declaredSystem ?? []), ...hoistedSystem];
    const messages = applyMessagesToolLedger(
      parsedMessages.filter((message) => message.role !== "system"),
    );
    const disabledParallel = body.disable_parallel_tool_use ?? body.disableParallelToolUse;
    const stop = body.stop_sequences ?? body.stopSequences;
    const topP = body.top_p ?? body.topP;
    const topK = body.top_k ?? body.topK;
    const generation_controls: GenerationControls = {
      ...(finiteNumber(body.temperature) ? { temperature: body.temperature } : {}),
      ...(finiteNumber(topP) ? { top_p: topP } : {}),
      ...(finiteNumber(topK) ? { top_k: topK } : {}),
      ...(Array.isArray(stop) || stringValue(stop) ? { stop } : {}),
      max_tokens: maxTokens,
      ...(disabledParallel !== undefined ? { parallel_tool_calls: disabledParallel !== true } : {}),
      ...extensionControls(
        body,
        isRecord(body.metadata) ? (body.metadata.user_id ?? body.metadata.userId) : undefined,
      ),
    };
    const reasoningOptions: MessagesParseOptions =
      headers === undefined ? options : { ...options, headers };
    const reasoning = parseThinking(body.thinking, body.model, reasoningOptions, maxTokens);
    // `output_config` carries the effort/task-budget controls Anthropic
    // recommends alongside adaptive thinking; fold them into the same
    // canonical reasoning intent so the payload builder can re-emit them.
    const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
    let reasoningIntent = reasoning;
    if (outputConfig !== undefined) {
      reasoningIntent ??= {};
      const effort = outputConfig["effort"];
      if (stringValue(effort) && CANONICAL_REASONING_EFFORTS.has(effort))
        reasoningIntent.effort = effort as NonNullable<ReasoningIntent["effort"]>;
      const taskBudget = outputConfig["task_budget"];
      if (finiteNumber(taskBudget)) reasoningIntent.task_budget = taskBudget;
    }
    const cache = cacheHint(body, system);
    const tools = parseTools(body.tools);
    const toolChoice = parseToolChoice(body.tool_choice ?? body.toolChoice, "messages");
    return {
      model: body.model,
      messages,
      ...(system === undefined ? {} : { system }),
      ...(tools === undefined ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      generation_controls,
      ...(reasoningIntent === undefined ? {} : { reasoning: reasoningIntent }),
      ...(cache === undefined ? {} : { cache_hint: cache }),
      stream: body.stream === true,
      source_surface: "messages",
    };
  }

  /** Encode canonical events as a complete Messages response. */
  encode(
    events: readonly CanonicalEvent[],
    context: MessagesEncodingContext = {},
  ): MessagesResponse | MessagesErrorResponse {
    const responseId = context.response_id ?? `msg-${crypto.randomUUID()}`;
    const model = context.model ?? startModel(events) ?? "unknown";
    const data = stopData(events);
    const { blocks: content, droppedUnnamedToolCalls } = groupedBlocks(events);
    // Only downgrade when the drop left the turn with no `tool_use` block at
    // all: a `tool_use` stop reason with zero calls is a dangling stop the
    // client cannot act on. A surviving named call keeps the reason accurate.
    const hasToolUseBlock = content.some((block) => block["type"] === "tool_use");
    const stopReason =
      droppedUnnamedToolCalls > 0 && !hasToolUseBlock && data.reason === "tool_use"
        ? "end_turn"
        : data.reason;
    const usage = usageToMessagesWire(data.usage);
    if (data.failed) {
      return {
        id: responseId,
        type: "error",
        error: { type: "server_error", message: "The upstream response failed" },
      };
    }
    return {
      id: responseId,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    };
  }

  /** Encode sync events into the public JSON bytes for this surface. */
  encodeOutput(
    events: readonly CanonicalEvent[],
    context: MessagesEncodingContext = {},
  ): { bytes: Uint8Array; content_type: "application/json" } {
    return {
      bytes: TEXT_ENCODER.encode(JSON.stringify(this.encode(events, context))),
      content_type: "application/json",
    };
  }
}
/** Singleton adapter useful for registry declarations and simple callers. */
export const messagesAdapter = new MessagesAdapter();
