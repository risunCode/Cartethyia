import { toOpenAIImageUrl } from "./openai-chat";
import { ProtocolCodecError } from "../errors";
import type { ProviderUsage } from "../../../application/contracts";
import { abortedError,
classifyImageReference,
isProtocolError,
isRecord,
messageText,
narrowArray,
narrowMessageArray,
narrowNumber,
narrowObject,
narrowString,
normalizeFail,
normalizeOk,
normalizeStream,
normalizeToolList,
nullableNumber,
protocolError,
pushImageReference,
boundJsonLength,
MAX_BLOCKS_PER_MESSAGE,
MAX_MESSAGE_COUNT,
MAX_MODEL_LENGTH,
MAX_OUTPUT_TOKENS,
MAX_TEXT_BLOCK_LENGTH,
MAX_TOOL_ARGUMENT_LENGTH,
MAX_TOOL_NAME_LENGTH,
type NormalizeInput,
type NormalizeResult,
type ProtocolError, } from "../../../application/protocols";
import type { ContentBlock, ImageReference, NormalizedMessage, ProxyRequest, NormalizedTool, ReasoningConfig, ReasoningContext, ReasoningEffort, ReasoningMode, ReasoningSummary } from "../../../application/contracts";
import type { ModelCapabilities } from "../capabilities";
import { normalizeClientEffort, projectEffort } from "./effort";
import { preserveWireExtensions } from "../policy/extensions";
import { applyOpenAIResponsesCacheBreakpoint } from "../policy/cache";
import { stringifyToolArguments } from "../concerns/tools";
import { isWebSearchTool } from "../../../application/web-search-routing";

export function normalizeResponsesRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);
  const responseFormat = normalizeResponseFormat(root["text"]);
  if (isProtocolError(responseFormat)) return normalizeFail(responseFormat);
  const reasoning = normalizeReasoning(root["reasoning"]);
  if (isProtocolError(reasoning)) return normalizeFail(reasoning);
  let reasoningConfig = reasoning.config;
  const topEffort = root["reasoning_effort"];
  if (topEffort !== undefined && reasoningConfig?.effort === undefined) {
    const effort = normalizeClientEffort(topEffort);
    if (effort !== undefined) reasoningConfig = { ...reasoningConfig, effort };
  }


  const contextManagement = normalizeContextManagement(root["context_management"]);
  if (isProtocolError(contextManagement)) return normalizeFail(contextManagement);

  const maxOutputTokens = normalizeMaxOutputTokens(root["max_output_tokens"]);
  if (isProtocolError(maxOutputTokens)) return normalizeFail(maxOutputTokens);
  const controls = normalizeResponsesControls(root);
  if (isProtocolError(controls)) return normalizeFail(controls);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const inputMessages = normalizeInput(root["input"], images, reasoningState);
  if (isProtocolError(inputMessages)) return normalizeFail(inputMessages);

  const instructions = normalizeInstructions(root["instructions"]);
  if (isProtocolError(instructions)) return normalizeFail(instructions);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const include = normalizeInclude(root["include"]);
  if (isProtocolError(include)) return normalizeFail(include);

  const rawCacheKey = root["prompt_cache_key"];
  const cacheKey = typeof rawCacheKey === "string" && rawCacheKey.length <= 256 ? rawCacheKey : undefined;
  const finalReasoning = reasoningState.seen || reasoningConfig?.effort !== undefined || reasoningConfig?.enabled === true || reasoningConfig?.maxTokens !== undefined ? "enabled" : reasoning.flag;

  return normalizeOk({
    model,
    messages: [...instructions, ...inputMessages.messages],
    tools,
    stream,
    ...controls,
    responseFormat: responseFormat.format,
    ...(responseFormat.schema === undefined ? {} : { responseFormatSchema: responseFormat.schema }),
    reasoning: finalReasoning,
    reasoningConfig,
    include,
    ...(contextManagement === undefined ? {} : { contextManagement }),
    ...(inputMessages.trailingReasoningItems === undefined ? {} : { trailingReasoningItems: inputMessages.trailingReasoningItems }),
    maxOutputTokens,
    images,
    sourceSurface: "openai-responses",
    signal: input.signal,
    limits: input.limits,
    wirePayload: root,
    ...(cacheKey === undefined ? {} : { cacheKey }),
  });
}

function normalizeInstructions(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") return protocolError("instructions", "instructions: expected a string");
  if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("instructions", `instructions: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
  return [{ role: "system", content: [{ type: "text", text: raw }] }];
}

interface NormalizedResponseFormat {
  readonly format: ProxyRequest["responseFormat"];
  readonly schema?: Readonly<Record<string, unknown>>;
}

function normalizeResponseFormat(raw: unknown): NormalizedResponseFormat | ProtocolError {
  if (raw === undefined || raw === null) return { format: "text" };
  const text = narrowObject(raw, "text");
  if (isProtocolError(text)) return text;
  const format = text["format"];
  if (format === undefined || format === null) return { format: "text" };
  const formatObj = narrowObject(format, "text.format");
  if (isProtocolError(formatObj)) return formatObj;
  const type = formatObj["type"];
  if (type === "text" || type === "json_object") return { format: type };
  if (type === "json_schema") {
    const schema = narrowObject(formatObj["json_schema"], "text.format.json_schema");
    if (isProtocolError(schema)) return schema;
    const bound = boundJsonLength(schema, "text.format.json_schema", MAX_TEXT_BLOCK_LENGTH);
    if (bound !== null) return bound;
    return { format: type, schema: { ...schema } };
  }
  if (typeof type === "string") return protocolError("text.format.type", `text.format.type: unsupported format "${type}"`);
  return protocolError("text.format.type", 'text.format.type: expected "text", "json_object", or "json_schema"');
}

/** Effort levels accepted by the Responses `reasoning.effort` field. Shared with the Chat codec. */
export const REASONING_EFFORTS: readonly string[] = ["xhigh", "high", "medium", "low", "minimal", "none"];
/** Summary verbosity accepted by `reasoning.summary`. Shared with the Chat codec. */
export const REASONING_SUMMARIES: readonly string[] = ["auto", "concise", "detailed"];
/** Execution modes accepted by the Responses `reasoning.mode` field. */
export const REASONING_MODES: readonly string[] = ["standard", "pro"];
/** History context values accepted by the Responses `reasoning.context` field. */
export const REASONING_CONTEXTS: readonly string[] = ["auto", "current_turn", "all_turns"];

/**
 * Parses a `reasoning` wire object (as seen on both the Responses and Chat
 * surfaces) into a structured {@link ReasoningConfig} plus a flat enable flag.
 * Field-level validation errors surface as a {@link ProtocolError}.
 *
 * @param obj - the already-narrowed `reasoning` object
 * @param fieldPrefix - prefix for error field names (e.g. "reasoning")
 * @param enabledValue - the `enabled` value read from the object, if any
 * @returns the parsed config (possibly undefined when empty) and flag, or a ProtocolError
 */
export function parseReasoningConfig(
  obj: Record<string, unknown>,
  fieldPrefix: string,
  enabledValue: unknown,
): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  if (enabledValue === false) return { flag: "disabled", config: { enabled: false } };
  const config: { effort?: ReasoningEffort; maxTokens?: number; exclude?: boolean; enabled?: boolean; summary?: ReasoningSummary; mode?: ReasoningMode; context?: ReasoningContext } = {};
  const effortRaw = obj["effort"];
  if (effortRaw !== undefined && effortRaw !== null && effortRaw !== "") {
    const effort = normalizeClientEffort(effortRaw);
    if (effort !== undefined) config.effort = effort;
  }
  const summaryRaw = obj["summary"];
  if (summaryRaw !== undefined && summaryRaw !== null) {
    if (typeof summaryRaw !== "string") return protocolError(`${fieldPrefix}.summary`, `${fieldPrefix}.summary: expected a string`);
    const summary = REASONING_SUMMARIES.includes(summaryRaw as ReasoningSummary) ? (summaryRaw as ReasoningSummary) : null;
    if (summary === null) return protocolError(`${fieldPrefix}.summary`, `${fieldPrefix}.summary: unsupported value "${summaryRaw}"`);
    config.summary = summary;
  }
  const modeRaw = obj["mode"];
  if (modeRaw !== undefined && modeRaw !== null) {
    if (typeof modeRaw !== "string") return protocolError(`${fieldPrefix}.mode`, `${fieldPrefix}.mode: expected a string`);
    const mode = REASONING_MODES.includes(modeRaw as ReasoningMode) ? (modeRaw as ReasoningMode) : null;
    if (mode === null) return protocolError(`${fieldPrefix}.mode`, `${fieldPrefix}.mode: unsupported value "${modeRaw}"`);
    config.mode = mode;
  }
  const contextRaw = obj["context"];
  if (contextRaw !== undefined && contextRaw !== null) {
    if (typeof contextRaw !== "string") return protocolError(`${fieldPrefix}.context`, `${fieldPrefix}.context: expected a string`);
    const context = REASONING_CONTEXTS.includes(contextRaw as ReasoningContext) ? (contextRaw as ReasoningContext) : null;
    if (context === null) return protocolError(`${fieldPrefix}.context`, `${fieldPrefix}.context: unsupported value "${contextRaw}"`);
    config.context = context;
  }
  const maxTokensRaw = obj["max_tokens"];
  if (maxTokensRaw !== undefined && maxTokensRaw !== null) {
    const maxTokens = narrowNumber(maxTokensRaw, `${fieldPrefix}.max_tokens`, { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
    if (isProtocolError(maxTokens)) return maxTokens;
    config.maxTokens = maxTokens;
  }
  if (typeof obj["exclude"] === "boolean") config.exclude = obj["exclude"];
  if (enabledValue === true) config.enabled = true;
  const flag = config.effort !== undefined || config.enabled === true || config.maxTokens !== undefined || config.mode !== undefined || config.context !== undefined ? "enabled" : "default";
  return { flag, config: Object.keys(config).length > 0 ? config : undefined };
}

function normalizeInput(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): { messages: NormalizedMessage[]; trailingReasoningItems?: readonly Record<string, unknown>[] } | ProtocolError {
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("input", `input: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return { messages: [{ role: "user", content: [{ type: "text", text: raw }] }] };
  }
  const list = narrowMessageArray(raw, "input", MAX_MESSAGE_COUNT);
  if (isProtocolError(list)) return list;
  const messages: NormalizedMessage[] = [];
  const pendingReasoningItems: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `input[${i}]`;
    if (item === undefined) continue;
    if (typeof item === "string") {
      if (item.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
      messages.push({ role: "user", content: [{ type: "text", text: item }], reasoningItemsBefore: takePendingReasoning(pendingReasoningItems) });
      continue;
    }
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "message" || (type === undefined && typeof obj["role"] === "string")) {
      const message = normalizeMessageItem(obj, field, images, reasoningState);
      if (isProtocolError(message)) return message;
      messages.push(withPendingReasoning(message, pendingReasoningItems));
    } else if (type === "function_call") {
      const block = normalizeFunctionCallItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push(withPendingReasoning({ role: "assistant", content: [block] }, pendingReasoningItems));
    } else if (type === "function_call_output") {
      const block = normalizeFunctionCallOutputItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push(withPendingReasoning({ role: "tool", content: [block] }, pendingReasoningItems));
    } else if (type === "reasoning") {
      const normalized = normalizeReasoningItem(obj, field);
      if (isProtocolError(normalized)) return normalized;
      pendingReasoningItems.push(normalized);
      reasoningState.seen = true;
    } else if (type === "compaction") {
      const bound = boundJsonLength(obj, field, MAX_TEXT_BLOCK_LENGTH);
      if (bound !== null) return bound;
      pendingReasoningItems.push(obj);
    } else if (type === "additional_tools") {
      // Codex code-mode sends this Responses-only opaque item. Same-surface
      // payload preservation restores it byte-for-byte; cross-surface
      // translations intentionally omit it rather than inventing a tool shape.
      const bound = boundJsonLength(obj, field, MAX_TEXT_BLOCK_LENGTH);
      if (bound !== null) return bound;
    } else if (typeof type === "string") {
      return protocolError(`${field}.type`, `unsupported input item type "${type}"`);
    } else {
      return protocolError(`${field}.type`, "input item type must be a string");
    }
  }
  const trailingReasoningItems = takePendingReasoning(pendingReasoningItems);
  return trailingReasoningItems === undefined ? { messages } : { messages, trailingReasoningItems };
}

function normalizeReasoning(raw: unknown): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  if (raw === undefined || raw === null) return { flag: "default", config: undefined };
  const obj = narrowObject(raw, "reasoning");
  if (isProtocolError(obj)) return obj;
  return parseReasoningConfig(obj, "reasoning", obj["enabled"]);

}
function normalizeContextManagement(raw: unknown): readonly Readonly<Record<string, unknown>>[] | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = narrowArray(raw, "context_management", 16);
  if (isProtocolError(list)) return list;
  const result: Readonly<Record<string, unknown>>[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = narrowObject(list[i], `context_management[${i}]`);
    if (isProtocolError(item)) return item;
    result.push(item);
  }
  const bound = boundJsonLength(result, "context_management", 64 * 1024);
  return bound === null ? result : bound;
}
/** Normalizes the Responses `include` array (e.g. `reasoning.encrypted_content`). */
function normalizeInclude(raw: unknown): readonly string[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return protocolError("include", "include: expected an array of strings");
  const items: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || item.length === 0) return protocolError(`include[${i}]`, "include: expected a non-empty string");
    if (item.length > 128) return protocolError(`include[${i}]`, `include[${i}]: exceeds maximum length of 128 characters`);
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

function normalizeMaxOutputTokens(raw: unknown): number | null | ProtocolError {
  if (raw === undefined || raw === null) return null;
  const value = narrowNumber(raw, "max_output_tokens", { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}
interface NormalizedResponsesControls {
  readonly temperature?: number;
  readonly topP?: number;
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: ProxyRequest["toolChoice"];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function normalizeResponsesControls(root: Record<string, unknown>): NormalizedResponsesControls | ProtocolError {
  const temperature = optionalResponsesNumber(root["temperature"], "temperature", 0, 2);
  if (isProtocolError(temperature)) return temperature;
  const topP = optionalResponsesNumber(root["top_p"], "top_p", 0, 1);
  if (isProtocolError(topP)) return topP;
  const parallelToolCalls = optionalResponsesBoolean(root["parallel_tool_calls"], "parallel_tool_calls");
  if (isProtocolError(parallelToolCalls)) return parallelToolCalls;
  const toolChoice = root["tool_choice"];
  if (toolChoice !== undefined && toolChoice !== null && toolChoice !== "none" && toolChoice !== "auto" && toolChoice !== "required" && !isRecord(toolChoice)) {
    return protocolError("tool_choice", "tool_choice: expected none, auto, required, or an object");
  }
  const metadataRaw = root["metadata"];
  let metadata: Readonly<Record<string, unknown>> | undefined;
  if (metadataRaw !== undefined && metadataRaw !== null) {
    const value = narrowObject(metadataRaw, "metadata");
    if (isProtocolError(value)) return value;
    const bound = boundJsonLength(value, "metadata", MAX_TEXT_BLOCK_LENGTH);
    if (bound !== null) return bound;
    metadata = { ...value };
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(toolChoice === undefined || toolChoice === null ? {} : { toolChoice: typeof toolChoice === "string" ? toolChoice : { ...toolChoice } }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function optionalResponsesNumber(raw: unknown, field: string, min: number, max: number): number | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  return narrowNumber(raw, field, { min, max });
}

function optionalResponsesBoolean(raw: unknown, field: string): boolean | undefined | ProtocolError {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") return protocolError(field, `${field}: expected a boolean`);
  return raw;
}


function normalizeMessageItem(obj: Record<string, unknown>, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    return protocolError(`${field}.role`, `unsupported message role "${role}"`);
  }
  const phaseRaw = obj["phase"];
  if (phaseRaw !== undefined && role !== "assistant") return protocolError(`${field}.phase`, `${field}.phase is only valid for assistant messages`);
  if (phaseRaw !== undefined && phaseRaw !== "commentary" && phaseRaw !== "final_answer") return protocolError(`${field}.phase`, `${field}.phase: expected "commentary" or "final_answer"`);
  const content = normalizeMessageContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content, ...(phaseRaw === undefined ? {} : { phase: phaseRaw }) };
}
function takePendingReasoning(items: Record<string, unknown>[]): readonly Record<string, unknown>[] | undefined {
  if (items.length === 0) return undefined;
  const pending = items.splice(0, items.length);
  return pending;
}

function withPendingReasoning(message: NormalizedMessage, pending: Record<string, unknown>[]): NormalizedMessage {
  const reasoningItemsBefore = takePendingReasoning(pending);
  return reasoningItemsBefore === undefined ? message : { ...message, reasoningItemsBefore };
}

function normalizeReasoningItem(obj: Record<string, unknown>, field: string): Record<string, unknown> | ProtocolError {
  const item: Record<string, unknown> = { type: "reasoning" };
  for (const key of ["id", "encrypted_content"] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    const text = narrowString(value, `${field}.${key}`, MAX_TEXT_BLOCK_LENGTH);
    if (isProtocolError(text)) return text;
    item[key] = text;
  }
  const summary = obj["summary"];
  if (summary !== undefined) {
    if (!Array.isArray(summary) || summary.length > MAX_BLOCKS_PER_MESSAGE) return protocolError(`${field}.summary`, `${field}.summary: expected at most ${MAX_BLOCKS_PER_MESSAGE} summary items`);
    const normalized: Record<string, unknown>[] = [];
    for (let i = 0; i < summary.length; i++) {
      const entry = summary[i];
      const entryField = `${field}.summary[${i}]`;
      const entryObject = narrowObject(entry, entryField);
      if (isProtocolError(entryObject)) return entryObject;
      const type = entryObject["type"];
      if (type !== "summary_text" && type !== "reasoning_text") return protocolError(`${entryField}.type`, `${entryField}.type: unsupported summary type`);
      const text = narrowString(entryObject["text"], `${entryField}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      normalized.push({ type, text });
    }
    item.summary = normalized;
  }
  const bound = boundJsonLength(item, field, MAX_TEXT_BLOCK_LENGTH);
  return bound === null ? item : bound;
}

function normalizeMessageContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (isRecord(item) && item["type"] === "reasoning") {
      const normalized = normalizeReasoningItem(item, blockField);
      if (isProtocolError(normalized)) return normalized;
      reasoningState.seen = true;
      const summary = Array.isArray(normalized.summary) ? normalized.summary.filter(isRecord) : undefined;
      blocks.push({ type: "reasoning", nativeType: "reasoning", nativePayload: { ...normalized }, reasoningEncryptedContent: typeof normalized.encrypted_content === "string" ? normalized.encrypted_content : undefined, reasoningSummary: summary, raw: normalized });
      continue;
    }
    const block = normalizeResponseBlock(item, blockField, images);
    if (isProtocolError(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

function normalizeResponseBlock(raw: unknown, field: string, images: ImageReference[]): ContentBlock | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  switch (type) {
    case "input_text":
    case "output_text": {
      const text = narrowString(obj["text"], `${field}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      return { type: "text", text };
    }
    case "input_image": {
      const image = normalizeInputImage(obj["image_url"], `${field}.image_url`, images);
      if (isProtocolError(image)) return image;
      return { type: "image", image };
    }
    case "function_call": {
      const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
      const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
      if (isProtocolError(name)) return name;
      if (name.trim() === "") return protocolError(`${field}.name`, "function call name must not be empty");
      const argumentsValue = normalizeToolArguments(obj["arguments"], `${field}.arguments`);
      if (isProtocolError(argumentsValue)) return argumentsValue;
      return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
    }
    case "function_call_output": {
      const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
      const output = normalizeToolOutput(obj["output"], `${field}.output`);
      if (isProtocolError(output)) return output;
      return { type: "tool_result", text: output, toolCallId: callId };
    }
    case "refusal":
      return { type: "unknown" };
    default:
      if (typeof type === "string") return { type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined };
      return protocolError(`${field}.type`, "content block type must be a string");
  }
}

function normalizeFunctionCallItem(obj: Record<string, unknown>, field: string): ContentBlock | ProtocolError {
  const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
  if (isProtocolError(callId)) return callId;
  if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
  const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
  if (isProtocolError(name)) return name;
  if (name.trim() === "") return protocolError(`${field}.name`, "function call name must not be empty");
  const argumentsValue = normalizeToolArguments(obj["arguments"], `${field}.arguments`);
  if (isProtocolError(argumentsValue)) return argumentsValue;
  return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
}

function normalizeFunctionCallOutputItem(obj: Record<string, unknown>, field: string): ContentBlock | ProtocolError {
  const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
  if (isProtocolError(callId)) return callId;
  if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
  const output = normalizeToolOutput(obj["output"], `${field}.output`);
  if (isProtocolError(output)) return output;
  return { type: "tool_result", text: output, toolCallId: callId };
}

function normalizeToolArguments(raw: unknown, field: string): string | ProtocolError {
  try {
    return stringifyToolArguments(raw ?? "{}");
  } catch {
    return protocolError(field, `${field}: exceeds ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
  }
}

function normalizeToolOutput(raw: unknown, field: string): string | ProtocolError {
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return raw;
  }
  try {
    const output = stringifyToolArguments(raw ?? "{}");
    if (output.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return output;
  } catch {
    return protocolError(field, `${field}: exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
  }
}

function normalizeInputImage(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const url = isRecord(raw) ? raw["url"] : raw;
  const classification = classifyImageReference(url, field);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference, field);
  if (bound !== null) return bound;
  return classification.reference;
}

function normalizeTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: false, schemaField: "parameters", schemaRequired: false });
}


// OpenAI Responses wire codec
/**
 * Translates the normalized request into the OpenAI Responses wire payload.
 * json_schema response formats are approximated as json_object because the
 * normalized request carries no schema body.
 */
export function buildResponsesPayload(request: ProxyRequest, options: { readonly includeContextManagement?: boolean; readonly upstreamModel?: string; readonly explicitCache?: boolean; readonly capabilities?: ModelCapabilities } = {}): Record<string, unknown> {
  const upstreamModel = options.upstreamModel ?? request.model;
  const payload: Record<string, unknown> = {
    model: upstreamModel,
    stream: request.stream,
    input: [...request.messages.flatMap(toResponsesItem), ...(request.trailingReasoningItems ?? [])],
  };
  if (request.tools.length > 0) payload.tools = request.tools.map(toResponsesTool);
  if (request.maxOutputTokens !== null) payload.max_output_tokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) payload.prompt_cache_key = request.cacheKey;
  if (request.responseFormat !== "text") {
    payload.text = request.responseFormat === "json_schema" && request.responseFormatSchema !== undefined
      ? { format: { type: "json_schema", ...request.responseFormatSchema } }
      : { format: { type: "json_object" } };
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.topP !== undefined) payload.top_p = request.topP;
  if (request.parallelToolCalls !== undefined) payload.parallel_tool_calls = request.parallelToolCalls;
  if (request.toolChoice !== undefined) payload.tool_choice = request.toolChoice;
  if (request.metadata !== undefined && request.sourceSurface === "openai-responses") payload.metadata = request.metadata;
  if (request.reasoning === "enabled" || request.reasoningConfig !== undefined) {
    payload.reasoning = buildReasoningWire(request.reasoning, request.reasoningConfig, options.capabilities);
  }
  if (request.include !== undefined && request.include.length > 0) payload.include = [...request.include];
  if (options.includeContextManagement !== false && request.contextManagement !== undefined) {
    const contextManagement = request.contextManagement;
    if (Array.isArray(contextManagement)) payload.context_management = [...contextManagement];
    else if (isRecord(contextManagement) && Array.isArray(contextManagement.edits)) payload.context_management = contextManagement.edits;
  }
  preserveWireExtensions(payload, request, "openai-responses", options.includeContextManagement === false
    ? ["model", "stream", "input", "tools", "max_output_tokens", "prompt_cache_key", "prompt_cache_options", "text", "reasoning", "include", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "metadata"]
    : ["model", "stream", "input", "tools", "max_output_tokens", "prompt_cache_key", "prompt_cache_options", "text", "reasoning", "include", "context_management", "temperature", "top_p", "parallel_tool_calls", "tool_choice", "metadata"]);
  const preservedReasoning = payload.reasoning;
  if (isRecord(preservedReasoning)) {
    if (Object.prototype.hasOwnProperty.call(preservedReasoning, "effort")) {
      const safeEffort = projectEffort(preservedReasoning.effort, "openai-responses", options.capabilities?.reasoning.efforts);
      if (safeEffort === undefined) delete preservedReasoning.effort;
      else preservedReasoning.effort = safeEffort;
    }
    if (options.capabilities !== undefined && options.capabilities.reasoning.maxTokens !== "supported") delete preservedReasoning.max_tokens;
  } else if (preservedReasoning !== undefined && preservedReasoning !== null) {
    delete payload.reasoning;
  }
  applyOpenAIResponsesCacheBreakpoint(payload, request, toResponsesItem, upstreamModel, options.explicitCache !== false);
  return payload;
}


/**
 * Builds the `reasoning` wire object, preserving structured effort, summary,
 * mode, context, maxTokens, exclude, or enabled controls. Concise summaries
 * are the default so terminal clients do not receive verbose reasoning.
 */
function buildReasoningWire(flag: "enabled" | "disabled" | "default", config: ReasoningConfig | undefined, capabilities?: ModelCapabilities): Record<string, unknown> {
  if (config !== undefined) {
    const wire: Record<string, unknown> = {};
    const effort = config.effort === undefined ? undefined : projectEffort(config.effort, "openai-responses", capabilities?.reasoning.efforts);
    if (effort !== undefined && capabilities?.reasoning.supported !== false) wire.effort = effort;
    if (config.summary !== undefined && capabilities?.reasoning.summary !== false) wire.summary = config.summary;
    else if (config.enabled !== false && capabilities?.reasoning.summary !== false) wire.summary = "concise";
    if (config.maxTokens !== undefined && capabilities?.reasoning.maxTokens === "supported") wire.max_tokens = config.maxTokens;
    if (config.exclude !== undefined) wire.exclude = config.exclude;
    if (config.enabled !== undefined) wire.enabled = config.enabled;
    if (config.mode !== undefined && (capabilities === undefined || capabilities.reasoning.modes.includes(config.mode))) wire.mode = config.mode;
    if (config.context !== undefined) wire.context = config.context;
    return Object.keys(wire).length > 0 ? wire : { enabled: false };
  }
  return flag === "enabled" && capabilities?.reasoning.supported !== false ? { effort: "medium", summary: "concise" } : { enabled: false };
}
function toResponsesTool(tool: NormalizedTool): Record<string, unknown> {
  if (isWebSearchTool(tool)) return { type: "web_search" };
  if (tool.nativeType?.startsWith("web_fetch_") === true) {
    throw new ProtocolCodecError({
      kind: "capability_unsupported",
      message: "Anthropic web fetch tools require an Anthropic-compatible upstream",
      statusCode: 400,
      routeScope: "provider",
    });
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? undefined,
    parameters: tool.inputSchema,
  };
}

function toResponsesReasoningItem(block: ContentBlock): Record<string, unknown> {
  const raw = block.raw;
  const item: Record<string, unknown> = { type: "reasoning" };
  if (isRecord(raw)) {
    if (typeof raw.id === "string") item.id = raw.id;
    if (typeof raw.encrypted_content === "string") item.encrypted_content = raw.encrypted_content;
    if (Array.isArray(raw.summary)) item.summary = raw.summary;
  }
  if (typeof item.encrypted_content !== "string" && block.reasoningEncryptedContent !== undefined) {
    item.encrypted_content = block.reasoningEncryptedContent;
  }
  if (!Array.isArray(item.summary)) {
    item.summary = block.reasoningSummary ?? (block.reasoningText === undefined ? [] : [{ type: "summary_text", text: block.reasoningText }]);
  }
  return item;
}

function toResponsesItem(message: NormalizedMessage): readonly Record<string, unknown>[] {
  const prefix = message.reasoningItemsBefore ?? [];
  switch (message.role) {
    case "system":
    case "developer":
      return [...prefix, { role: message.role, content: messageText(message) }];
    case "user": {
      const hasImage = message.content.some((block) => block.type === "image");
      if (!hasImage) return [...prefix, { role: "user", content: messageText(message) }];
      const blocks: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") blocks.push({ type: "input_text", text: block.text ?? "" });
        else if (block.type === "image") blocks.push({ type: "input_image", image_url: toOpenAIImageUrl(block.image) });
      }
      return [...prefix, { role: "user", content: blocks }];
    }
    case "assistant": {
      const items: Record<string, unknown>[] = [...prefix];
      for (const block of message.content) {
        if (block.type === "compaction" && block.raw !== undefined) items.push({ ...block.raw });
        else if (block.type === "reasoning") items.push(toResponsesReasoningItem(block));
      }
      const text = messageText(message);
      const calls = message.content.filter((block) => block.type === "tool_use");
      if (text.length > 0 || calls.length === 0) {
        items.push({ role: "assistant", content: [{ type: "output_text", text }], ...(message.phase === undefined ? {} : { phase: message.phase }) });
      }
      for (const block of calls) {
        items.push({
          type: "function_call",
          call_id: block.toolCallId ?? `call_${block.toolName ?? ""}`,
          name: block.toolName ?? "",
          arguments: block.toolArguments ?? block.text ?? "{}",
        });
      }
      return items;
    }
    case "tool": {
      const block = message.content[0];
      return [...prefix, { type: "function_call_output", call_id: block?.toolCallId ?? "", output: message.content.map((item) => item.text ?? "").join("\n") }];
    }
  }
}

