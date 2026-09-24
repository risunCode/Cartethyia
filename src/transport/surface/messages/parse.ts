import type { CanonicalMessage, CanonicalRequest, ContentPart, GenerationControls, ReasoningIntent, ToolDefinition } from "../../canonical-model";
import { getHeader as readHeader } from "../../canonical-model";
import { requiredObject } from "../adapters";
import { isRecord } from "../../../protocol/primitives";
import { parseToolDefinition } from "../dialects";
import { canContainToolResult } from "../../canonical-model";
import { MessagesLedgerError } from "./errors";
import { finiteNumber, stringValue } from "../../../protocol/primitives";

export interface MessagesParseOptions {
  /** Explicit Claude model generation (for example `4.6` or `4.7`). */
  modelGeneration?: string;
  /** Header values from the inbound request. */
  headers?: Readonly<Record<string, string>>;
}

/** Context used when encoding a Messages response. */
export interface MessagesEncodingContext {
  response_id?: string;
  model?: string;
}

/** A JSON object from the Anthropic Messages wire protocol. */
export type MessagesWireObject = Record<string, unknown>;

/** A non-streaming Anthropic Messages response. */
export interface MessagesResponse extends MessagesWireObject {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: MessagesWireObject[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: MessagesWireObject;
}

/** A typed Anthropic Messages error response for a failed canonical terminal. */
export interface MessagesErrorResponse extends MessagesWireObject {
  type: "error";
  error: { type: string; message: string };
}

/** One event in an Anthropic Messages stream. */
export interface MessagesStreamEvent extends MessagesWireObject {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop";
}

export function contentArray(value: unknown, label: string): unknown[] {
  if (stringValue(value)) return [value];
  if (!Array.isArray(value)) throw new Error(`Messages ${label} must be a string or block array`);
  return value;
}

export function parseGeneration(model: string, explicit: string | undefined): number | undefined {
  const source = explicit ?? model;
  if (explicit !== undefined && /^\d+(?:[.-]\d+)?$/.test(explicit))
    return Number(explicit.replace("-", "."));
  const match = source.match(/(?:claude[-_ ]?)(\d+)(?:[.-](\d+))?/i);
  if (!match) return undefined;
  return Number(`${match[1]}.${match[2] ?? "0"}`);
}

export function textPart(value: unknown): ContentPart {
  return { kind: "text", text: stringValue(value) ? value : String(value) };
}

export function parseBlock(value: unknown): ContentPart {
  if (stringValue(value)) return textPart(value);
  if (!isRecord(value)) return { kind: "extension", name: "unknown", payload: value };
  const type = value.type;
  if (type === "text") return textPart(value.text ?? "");
  if (type === "image") return { kind: "image", payload: value };
  if (type === "document") {
    const source: MessagesWireObject = isRecord(value.source) ? value.source : {};
    const sourceType = typeof source.type === "string" ? source.type : undefined;
    const fileId = typeof source.file_id === "string" ? source.file_id : undefined;
    const url = typeof source.url === "string" ? source.url : undefined;
    return {
      kind: "document",
      data: source.data ?? fileId ?? url ?? "",
      media_type: stringValue(source.media_type) ? source.media_type : "application/octet-stream",
      ...(stringValue(value.title) ? { title: value.title } : {}),
      ...(isRecord(value.citations) && value.citations.enabled === true ? { citations: true } : {}),
      // Keep the source discriminator so a `file_id`/`url` document is not
      // flattened into inline base64 on the way back out.
      ...(sourceType === "base64" ||
      sourceType === "url" ||
      sourceType === "file" ||
      sourceType === "text"
        ? { source_type: sourceType }
        : {}),
      ...(url === undefined ? {} : { url }),
      ...(fileId === undefined ? {} : { file_id: fileId }),
    };
  }
  if (type === "audio")
    return {
      kind: "audio",
      data: isRecord(value.source) ? value.source.data ?? "" : "",
      media_type: isRecord(value.source) && stringValue(value.source.media_type)
        ? value.source.media_type
        : "audio/mpeg",
    };
  if (type === "refusal") return { kind: "refusal", text: stringValue(value.refusal) ? value.refusal : "" };
  if (type === "tool_use") {
    if (!stringValue(value.id) || !stringValue(value.name)) {
      throw new Error("Messages tool_use requires id and name");
    }
    return {
      kind: "toolCall",
      call_id: value.id,
      name: value.name,
      arguments: value.input ?? {},
      ...(finiteNumber(value.index) ? { index: value.index } : {}),
    };
  }
  if (type === "tool_result") {
    if (!stringValue(value.tool_use_id))
      throw new Error("Messages tool_result requires tool_use_id");
    const resultContent = value.content;
    const content = stringValue(resultContent)
      ? resultContent
      : Array.isArray(resultContent)
        ? resultContent.map(parseBlock)
        : resultContent == null
          ? ""
          : [textPart(resultContent)];
    return {
      kind: "toolResult",
      call_id: value.tool_use_id,
      content,
      ...(value.is_error === true ? { is_error: true } : {}),
    };
  }
  if (type === "thinking") {
    const thinking = stringValue(value.thinking) ? value.thinking : "";
    return {
      kind: "reasoning",
      payload: thinking,
      summary: thinking,
      ...(stringValue(value.signature) ? { signature: value.signature } : {}),
    };
  }
  if (type === "redacted_thinking") {
    return { kind: "reasoning", payload: value, opaque: true };
  }
  if (type === "server_tool_use")
    return { kind: "extension", name: "server_tool_use", payload: value };
  if (type === "search_result") return { kind: "extension", name: "search_result", payload: value };
  return {
    kind: "extension",
    name: stringValue(type) ? `messages:${type}` : "messages:unknown",
    payload: value,
  };
}

export function parseBlocks(value: unknown, label: string): ContentPart[] {
  return contentArray(value, label).map(parseBlock);
}

export function parseMessage(value: unknown): CanonicalMessage {
  const message = requiredObject(value, "message");
  const role = message.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("Messages message role must be system, user, assistant, or tool");
  }
  if (role === "system") {
    return { role, content: parseBlocks(message.content, "system content") };
  }
  if (role === "tool") {
    const callId = message.tool_call_id ?? message.tool_use_id;
    if (!stringValue(callId)) throw new Error("Messages tool message requires tool_call_id");
    const content = stringValue(message.content)
      ? message.content
      : parseBlocks(message.content, "tool content");
    return { role: "user", content: [{ kind: "toolResult", call_id: callId, content }] };
  }
  return {
    role,
    content: parseBlocks(message.content, "message content"),
    ...(message.phase === "commentary" || message.phase === "final_answer"
      ? { phase: message.phase }
      : {}),
  };
}

export function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("Messages tools must be an array");
  return value.map((entry) => {
    const parsed = parseToolDefinition(entry, "messages");
    if (!parsed) throw new Error("Messages tool failed to parse");
    return parsed;
  });
}


/** Reads `thinking.block_binding.prefix_mismatch_behavior` when present. */
export function prefixMismatchBehavior(value: unknown): "drop_block" | "error" | undefined {
  if (!isRecord(value)) return undefined;
  const behavior = value["prefix_mismatch_behavior"];
  if (behavior === "drop_block" || behavior === "error") return behavior;
  return undefined;
}

/** Anthropic `thinking.display` values this gateway can forward without a beta. */
const THINKING_DISPLAY_VALUES: ReadonlySet<string> = new Set(["summarized", "omitted"]);

export function parseThinking(
  value: unknown,
  model: string,
  options: MessagesParseOptions,
  maxTokens: number,
): ReasoningIntent | undefined {
  if (value == null) return undefined;
  const thinking = requiredObject(value, "thinking");
  const type = thinking.type;
  if (type !== "enabled" && type !== "adaptive" && type !== "disabled") {
    throw new Error("Messages thinking.type must be enabled, adaptive, or disabled");
  }
  const display = thinking.display;
  if (display !== undefined && !THINKING_DISPLAY_VALUES.has(String(display))) {
    // `updates` requires the `thinking-display-updates-2026-08-18` beta, which
    // this gateway does not negotiate; failing here is clearer than an opaque
    // upstream 400 on a request that cannot succeed.
    throw new Error("Messages thinking.display must be summarized or omitted");
  }
  const displayValue =
    display === "summarized" || display === "omitted" ? display : undefined;
  const prefixMismatch = prefixMismatchBehavior(thinking.block_binding);
  if (type === "disabled") {
    return {
      thinking_type: "disabled",
      ...(displayValue === undefined ? {} : { display: displayValue }),
    };
  }
  const budget = thinking.budget_tokens;
  const generation = parseGeneration(model, options.modelGeneration);
  const beta =
    readHeader(options.headers, "anthropic-beta")
      ?.split(",")
      .map((part) => part.trim())
      .includes("interleaved-thinking-2025-05-14") ?? false;
  if (type === "enabled") {
    if (!finiteNumber(budget) || !Number.isInteger(budget))
      throw new Error("Manual Messages thinking requires integer budget_tokens");
    if (generation !== undefined && generation >= 4.7)
      throw new Error("Manual Messages thinking is rejected for model generation 4.7+");
    if (budget < 1024 || (!beta && budget >= maxTokens))
      throw new Error(
        "Messages thinking budget_tokens must be at least 1024 and less than max_tokens",
      );
    return {
      thinking_type: "enabled",
      budget_tokens: budget,
      ...(displayValue === undefined ? {} : { display: displayValue }),
      ...(prefixMismatch === undefined ? {} : { prefix_mismatch_behavior: prefixMismatch }),
    };
  }
  if (
    budget !== undefined &&
    (!finiteNumber(budget) || !Number.isInteger(budget) || budget < 1024)
  ) {
    throw new Error(
      "Adaptive Messages thinking budget_tokens must be an integer of at least 1024 when supplied",
    );
  }
  // Adaptive thinking carries the same `budget_tokens < max_tokens` rule as
  // manual mode; only the interleaved-thinking beta relaxes it.
  if (finiteNumber(budget) && !beta && budget >= maxTokens) {
    throw new Error("Adaptive Messages thinking budget_tokens must be less than max_tokens");
  }
  return {
    thinking_type: "adaptive",
    ...(finiteNumber(budget) ? { budget_tokens: budget } : {}),
    ...(displayValue === undefined ? {} : { display: displayValue }),
    ...(prefixMismatch === undefined ? {} : { prefix_mismatch_behavior: prefixMismatch }),
  };
}

export function systemBlocks(value: unknown): ContentPart[] | undefined {
  if (value == null) return undefined;
  return parseBlocks(value, "system");
}
export function cacheHint(
  body: MessagesWireObject,
  system: readonly ContentPart[] | undefined,
): CanonicalRequest["cache_hint"] {
  const top = body.cache_control ?? body.cacheControl;
  const breakpoints: number[] = [];
  const inspect = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      if (isRecord(block) && (block.cache_control !== undefined || block.cacheControl !== undefined))
        breakpoints.push(index);
    });
  };
  inspect(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message)) inspect(message.content);
    }
  }
  if (top !== undefined && isRecord(top) && top.type === "ephemeral") return "stable_prefix";
  if (breakpoints.length > 0) return { kind: "breakpoint", list: breakpoints };
  if (system && system.length > 0 && body.cache_control === "auto") return "stable_prefix";
  return undefined;
}

export function asSurfaceBody(input: unknown): {
  body: unknown;
  headers?: Readonly<Record<string, string>>;
} {
  if (isRecord(input) && "body" in input) {
    const headers = isRecord(input.headers)
      ? Object.fromEntries(
          Object.entries(input.headers).filter((entry): entry is [string, string] =>
            stringValue(entry[1]),
          ),
        )
      : undefined;
    return headers === undefined ? { body: input.body } : { body: input.body, headers };
  }
  return { body: input };
}

export function extensionControls(body: MessagesWireObject, userId: unknown): GenerationControls {
  const extensions: Record<`extension:${string}`, unknown> = {};
  const contextManagement = body.context_management ?? body.contextManagement;
  if (contextManagement !== undefined)
    extensions["extension:context_management"] = contextManagement;
  if (userId !== undefined) extensions["extension:metadata_user_id"] = userId;
  // Anthropic top-level params with no canonical slot pass through verbatim.
  if (body.service_tier === "auto" || body.service_tier === "standard_only")
    extensions["extension:service_tier"] = body.service_tier;
  if (isRecord(body.container)) extensions["extension:container"] = body.container;
  if (stringValue(body.inference_geo)) extensions["extension:inference_geo"] = body.inference_geo;
  if (stringValue(body.user_profile_id))
    extensions["extension:user_profile_id"] = body.user_profile_id;
  if (stringValue(body.workspace_id)) extensions["extension:workspace_id"] = body.workspace_id;
  return extensions;
}

interface ToolCallOccurrence {
  callId: string;
  messageIndex: number;
  server: boolean;
}

interface ToolResultOccurrence {
  result: Extract<ContentPart, { kind: "toolResult" }>;
  messageIndex: number;
  partIndex: number;
}

function isServerTool(part: ContentPart): boolean {
  return (
    part.kind === "extension" && (part.name === "server_tool_use" || part.name === "search_result")
  );
}

function serverToolId(part: ContentPart): string | undefined {
  if (
    part.kind !== "extension" ||
    !isServerTool(part) ||
    typeof part.payload !== "object" ||
    part.payload === null ||
    Array.isArray(part.payload)
  )
    return undefined;
  const payload = part.payload as Record<string, unknown>;
  const id = payload.id ?? payload.tool_use_id ?? payload.call_id;
  return typeof id === "string" ? id : undefined;
}

function resultMessage(
  results: readonly Extract<ContentPart, { kind: "toolResult" }>[],
): CanonicalMessage | undefined {
  if (results.length === 0) return undefined;
  // Error results pass through verbatim with their is_error flag: the
  // original payload is the diagnostic detail a retry depends on, and
  // inventing instructive prose destroys it.
  return { role: "user", content: [...results] };
}

function isToolResult(part: ContentPart): part is Extract<ContentPart, { kind: "toolResult" }> {
  return part.kind === "toolResult";
}

function collectOccurrences(messages: readonly CanonicalMessage[]): {
  calls: Map<string, ToolCallOccurrence>;
  results: ToolResultOccurrence[];
  serverIds: Set<string>;
} {
  const calls = new Map<string, ToolCallOccurrence>();
  const results: ToolResultOccurrence[] = [];
  const serverIds = new Set<string>();
  messages.forEach((message, messageIndex) => {
    message.content.forEach((part, partIndex) => {
      if (part.kind === "toolCall") {
        if (!part.call_id || !part.name)
          throw new MessagesLedgerError("tool_call must include call_id and name");
        if (calls.has(part.call_id))
          throw new MessagesLedgerError(`duplicate tool call occurrence: ${part.call_id}`);
        calls.set(part.call_id, { callId: part.call_id, messageIndex, server: false });
      }
      const serverId = serverToolId(part);
      if (serverId) {
        serverIds.add(serverId);
        calls.set(serverId, { callId: serverId, messageIndex, server: true });
      }
      // Result collection follows the shared tool-result rule
      // (`canContainToolResult`, translation/tool-repair.ts): answers live in
      // tool/user turns only. The ledger reconstructs turns from them; only
      // the repair scan synthesizes missing outputs.
      if (canContainToolResult(message) && isToolResult(part))
        results.push({ result: part, messageIndex, partIndex });
    });
  });
  return { calls, results, serverIds };
}

function validatedResults(
  calls: Map<string, ToolCallOccurrence>,
  results: readonly ToolResultOccurrence[],
  serverIds: Set<string>,
): Map<string, ToolResultOccurrence> {
  const byCall = new Map<string, ToolResultOccurrence>();
  for (const occurrence of results) {
    const call = calls.get(occurrence.result.call_id);
    if (!call) {
      if (serverIds.has(occurrence.result.call_id)) continue;
      throw new MessagesLedgerError(
        `tool_result has no matching tool_use: ${occurrence.result.call_id}`,
      );
    }
    if (call.server) continue;
    if (byCall.has(occurrence.result.call_id))
      throw new MessagesLedgerError(
        `duplicate tool_result occurrence: ${occurrence.result.call_id}`,
      );
    byCall.set(occurrence.result.call_id, occurrence);
  }
  return byCall;
}

function freeContent(message: CanonicalMessage): ContentPart[] {
  return message.content.filter((part) => !isToolResult(part));
}

/**
 * Rebuilds canonical Messages tool rounds under one explicit policy owner.
 * Results are matched by call ID, emitted in call order directly after the
 * assistant turn, and never silently repaired when an occurrence is missing.
 */
export function applyMessagesToolLedger(
  messages: readonly CanonicalMessage[],
): readonly CanonicalMessage[] {
  const { calls, results, serverIds } = collectOccurrences(messages);
  const byCall = validatedResults(calls, results, serverIds);
  const resultMessageIndexes = new Set(results.map((occurrence) => occurrence.messageIndex));
  const output: CanonicalMessage[] = [];
  const consumedResultMessages = new Set<number>();

  messages.forEach((message, messageIndex) => {
    const callParts = message.content.filter(
      (part): part is Extract<ContentPart, { kind: "toolCall" }> => part.kind === "toolCall",
    );
    const serverParts = message.content.filter(isServerTool);
    if (callParts.length > 0) {
      output.push({ role: message.role, content: message.content });
      const matchedEntries = callParts
        .map((part) => byCall.get(part.call_id))
        .filter((entry): entry is ToolResultOccurrence => entry !== undefined);
      matchedEntries.forEach((entry) => consumedResultMessages.add(entry.messageIndex));
      const rebuilt = resultMessage(matchedEntries.map((entry) => entry.result));
      if (rebuilt) output.push(rebuilt);
      return;
    }
    if (resultMessageIndexes.has(messageIndex)) {
      if (consumedResultMessages.has(messageIndex)) {
        const previous = messages[messageIndex - 1];
        const trailing = freeContent(message);
        if (trailing.length > 0 && previous?.content.some(isServerTool) !== true)
          output.push({ role: message.role, content: trailing });
        return;
      }
      const free = freeContent(message);
      const resultsOnly = message.content
        .filter(isToolResult)
        .filter((part) => !serverIds.has(part.call_id));
      consumedResultMessages.add(messageIndex);
      const rebuilt = resultMessage(resultsOnly);
      if (rebuilt) output.push(rebuilt);
      const previous = messages[messageIndex - 1];
      const previousHasDirectServer =
        previous?.content.some((part) => isServerTool(part)) === true || serverParts.length > 0;
      if (free.length > 0 && !previousHasDirectServer)
        output.push({ role: message.role, content: free });
      return;
    }
    if (
      messageIndex > 0 &&
      messages[messageIndex - 1]?.content.some(isServerTool) &&
      message.role === "user"
    ) {
      // A directly invoked server tool owns the turn. Trailing user text would
      // terminate it early and is intentionally suppressed by this ledger.
      return;
    }
    if (message.content.length > 0) output.push({ role: message.role, content: message.content });
  });
  return output;
}

