import { ProtocolCodecError } from "../errors";
import { REASONING_EFFORTS, parseReasoningConfig } from "./openai-responses";
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
MAX_BLOCKS_PER_MESSAGE,
MAX_MESSAGE_COUNT,
MAX_MODEL_LENGTH,
MAX_OUTPUT_TOKENS,
MAX_TEXT_BLOCK_LENGTH,
MAX_TOOL_ARGUMENT_LENGTH,
MAX_TOOL_CALLS_PER_MESSAGE,
MAX_TOOL_NAME_LENGTH,
type NormalizeInput,
type NormalizeResult,
type ProtocolError, } from "../../../application/protocols";
import type { ContentBlock, ImageReference, NormalizedMessage, ProxyRequest, NormalizedTool, ReasoningConfig, ReasoningEffort, ReasoningSummary } from "../../../application/contracts";

/**
 * Strict validation and normalization for OpenAI Chat Completions
 * (`/v1/chat/completions`, surface "openai-chat").
 *
 * External values are narrowed to the application contract shape and bounded; anything that
 * cannot be represented faithfully is rejected with a typed ProtocolError.
 * Tool-call `arguments` and assistant reasoning are retained in dedicated
 * normalized fields so adapters can round-trip provider-required state without
 * exposing reasoning as visible text.
 */
export function normalizeChatRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);

  const responseFormat = normalizeResponseFormat(root["response_format"]);
  if (isProtocolError(responseFormat)) return normalizeFail(responseFormat);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const messages = normalizeMessages(root["messages"], images, reasoningState);
  if (isProtocolError(messages)) return normalizeFail(messages);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const reasoning = finalizeReasoning(root, reasoningState);
  if (isProtocolError(reasoning)) return normalizeFail(reasoning);
  const finalFlag = reasoningState.seen && reasoning.flag === "default" ? "enabled" : reasoning.flag;

  const maxOutputTokens = normalizeMaxOutputTokens(root);
  if (isProtocolError(maxOutputTokens)) return normalizeFail(maxOutputTokens);

  return normalizeOk({
    model,
    messages,
    tools,
    stream,
    responseFormat,
    reasoning: finalFlag,
    reasoningConfig: reasoning.config,
    maxOutputTokens,
    images,
    sourceSurface: "openai-chat",
    signal: input.signal,
    limits: input.limits,
  });
}

function normalizeResponseFormat(raw: unknown): ProxyRequest["responseFormat"] | ProtocolError {
  if (raw === undefined || raw === null) return "text";
  const format = narrowObject(raw, "response_format");
  if (isProtocolError(format)) return format;
  const type = format["type"];
  if (type === "text" || type === "json_object" || type === "json_schema") return type;
  if (typeof type === "string") return protocolError("response_format.type", `response_format.type: unsupported format "${type}"`);
  return protocolError("response_format.type", 'response_format.type: expected "text", "json_object", or "json_schema"');
}

function normalizeMaxOutputTokens(root: Record<string, unknown>): number | null | ProtocolError {
  const field = root["max_completion_tokens"] !== undefined ? "max_completion_tokens" : "max_tokens";
  const raw = root["max_completion_tokens"] ?? root["max_tokens"];
  if (raw === undefined || raw === null) return null;
  const value = narrowNumber(raw, field, { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

function finalizeReasoning(root: Record<string, unknown>, state: { readonly seen: boolean }): { flag: "enabled" | "disabled" | "default"; config: ReasoningConfig | undefined } | ProtocolError {
  // An assistant `reasoning_content` block in history forces thinking on, since
  // OpenAI requires it to be replayed whenever the prior turn used thinking.
  const reasoning = root["reasoning"];
  const hasReasoningObject = reasoning !== undefined && reasoning !== null;
  if (hasReasoningObject && !isRecord(reasoning)) return protocolError("reasoning", "reasoning: expected an object");
  const reasoningObj = hasReasoningObject ? (reasoning as Record<string, unknown>) : undefined;
  if (reasoningObj !== undefined && ("mode" in reasoningObj || "context" in reasoningObj)) {
    return protocolError("reasoning", "reasoning.mode and reasoning.context are only supported on the Responses surface");
  }

  // The Chat surface also accepts a top-level `reasoning_effort` string (the
  // legacy spelling). Normalize it into the config effort slot so builders
  // can forward a single canonical value downstream.
  const topEffort = root["reasoning_effort"];
  const parsed = reasoningObj !== undefined ? parseReasoningConfig(reasoningObj, "reasoning", reasoningObj["enabled"]) : null;
  if (parsed !== null && isProtocolError(parsed)) return parsed;

  const config: { effort?: ReasoningEffort; maxTokens?: number; exclude?: boolean; enabled?: boolean; summary?: ReasoningSummary } = {};
  if (parsed !== null && parsed.config !== undefined) Object.assign(config, parsed.config);
  if (typeof topEffort === "string" && topEffort !== "" && config.effort === undefined) {
    const effort = REASONING_EFFORTS.includes(topEffort as ReasoningEffort) ? (topEffort as ReasoningEffort) : null;
    if (effort === null) return protocolError("reasoning_effort", `reasoning_effort: unsupported value "${topEffort}"`);
    config.effort = effort;
  }
  const flag = state.seen || config.effort !== undefined || config.enabled === true || config.maxTokens !== undefined
    ? "enabled"
    : parsed !== null ? parsed.flag : "default";
  return { flag, config: Object.keys(config).length > 0 ? config : undefined };
}

function normalizeMessages(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage[] | ProtocolError {
  const list = narrowMessageArray(raw, "messages", MAX_MESSAGE_COUNT);
  if (isProtocolError(list)) return list;
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `messages[${i}]`;
    if (item === undefined) continue;
    const message = normalizeMessage(item, field, images, reasoningState);
    if (isProtocolError(message)) return message;
    messages.push(message);
  }
  return messages;
}

function normalizeMessage(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") {
    return protocolError(`${field}.role`, `unsupported role "${role}"`);
  }
  const content = normalizeContent(obj["content"], `${field}.content`, images);
  if (isProtocolError(content)) return content;
  let reasoningContent: string | undefined;
  if (role === "assistant") {
    const calls = normalizeToolCalls(obj["tool_calls"], `${field}.tool_calls`);
    if (isProtocolError(calls)) return calls;
    if (calls.length > 0) content.push(...calls);
    const rawReasoningContent = obj["reasoning_content"];
    if (typeof rawReasoningContent === "string" && rawReasoningContent !== "") {
      // Reasoning content is never visible text, but OpenAI requires it to be
      // passed back when a prior assistant turn used thinking mode.
      reasoningContent = rawReasoningContent;
      reasoningState.seen = true;
    }
  } else if (role === "tool") {
    const callId = narrowString(obj["tool_call_id"], `${field}.tool_call_id`, 128);
    if (isProtocolError(callId)) return callId;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block === undefined) continue;
      content[i] = { ...block, type: "tool_result", toolCallId: callId };
    }
  }
  return reasoningContent === undefined ? { role, content } : { role, content, reasoningContent };
}

function normalizeContent(raw: unknown, field: string, images: ImageReference[]): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return [{ type: "text", text: raw }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, blockField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = narrowString(obj["text"], `${blockField}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "text", text });
    } else if (type === "image_url") {
      const image = normalizeImageUrl(obj["image_url"], `${blockField}.image_url`, images);
      if (isProtocolError(image)) return image;
      blocks.push({ type: "image", image });
    } else if (typeof type === "string") {
      // Unknown block types are narrowed to a typed "unknown" block, never
      // dropped or assumed to be visible text.
      blocks.push({ type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined });
    } else {
      return protocolError(`${blockField}.type`, "content block type must be a string");
    }
  }
  return blocks;
}

function normalizeImageUrl(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const url = isRecord(raw) ? raw["url"] : raw;
  const classification = classifyImageReference(url, `${field}.url`);
  if (!classification.ok) return classification.error;
  const bound = pushImageReference(images, classification.reference, field);
  if (bound !== null) return bound;
  return classification.reference;
}

function normalizeToolCalls(raw: unknown, field: string): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, field, MAX_TOOL_CALLS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const itemField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, itemField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type !== undefined && type !== "function") {
      return protocolError(`${itemField}.type`, `unsupported tool call type "${String(type)}"`);
    }
    const fn = narrowObject(obj["function"], `${itemField}.function`);
    if (isProtocolError(fn)) return fn;
    const name = narrowString(fn["name"], `${itemField}.function.name`, MAX_TOOL_NAME_LENGTH);
    if (isProtocolError(name)) return name;
    if (name.trim() === "") return protocolError(`${itemField}.function.name`, "tool call name must not be empty");
    const id = narrowString(obj["id"], `${itemField}.id`, 128);
    if (isProtocolError(id)) return id;
    if (id === "") return protocolError(`${itemField}.id`, "tool call id must not be empty");
    const argumentsValue = narrowString(fn["arguments"] ?? "{}", `${itemField}.function.arguments`, MAX_TOOL_ARGUMENT_LENGTH);
    if (isProtocolError(argumentsValue)) return argumentsValue;
    blocks.push({ type: "tool_use", toolName: name, toolCallId: id, toolArguments: argumentsValue });
  }
  return blocks;
}

function normalizeTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: true, schemaField: "parameters", schemaRequired: false });
}

/**
 * Strict validation and normalization for Anthropic Messages
 * (`/v1/messages`, surface "anthropic-messages").
 *
 * `max_tokens` is required by this protocol and enforced. `thinking` maps to
 * the request-level reasoning flag, and `thinking` blocks in history are
 * excluded from visible content. Tool-use `input` is retained as bounded JSON
 * for protocol adapters.
 */


// OpenAI Chat wire codec
/**
 * Translates the normalized request into the OpenAI Chat Completions wire
 * payload. json_schema response formats are approximated as json_object
 * because the normalized request carries no schema body.
 */
export function buildChatPayload(request: ProxyRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    stream: request.stream,
    messages: request.messages.map((message) => toChatMessage(message)),
  };
  if (request.tools.length > 0) {
    payload.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.inputSchema },
    }));
  }
  if (request.maxOutputTokens !== null) payload.max_tokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) payload.prompt_cache_key = request.cacheKey;
  if (request.responseFormat !== "text") payload.response_format = { type: "json_object" };
  if (request.reasoning === "enabled" || request.reasoningConfig !== undefined) {
    const cfg = request.reasoningConfig;
    if (cfg?.effort !== undefined) payload.reasoning_effort = cfg.effort;
    else if (request.reasoning === "enabled") payload.reasoning_effort = "medium";
    if (cfg !== undefined && (cfg.summary !== undefined || cfg.maxTokens !== undefined || cfg.exclude !== undefined || cfg.enabled !== undefined)) {
      const reasoningWire: Record<string, unknown> = {};
      if (cfg.summary !== undefined) reasoningWire.summary = cfg.summary;
      if (cfg.maxTokens !== undefined) reasoningWire.max_tokens = cfg.maxTokens;
      if (cfg.exclude !== undefined) reasoningWire.exclude = cfg.exclude;
      if (cfg.enabled !== undefined) reasoningWire.enabled = cfg.enabled;
      // `include` is intentionally omitted: the Chat surface rejects
      // `reasoning.include` (Blackbox returns `unknown_parameter`).
      payload.reasoning = reasoningWire;
    }
  }
  if (request.stream) payload.stream_options = { include_usage: true };
  return payload;
}

function toChatMessage(message: NormalizedMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "developer":
      return { role: "system", content: messageText(message) };
    case "user": {
      const hasImage = message.content.some((block) => block.type === "image");
      const content = [
        messageText(message),
        ...message.content.filter((block) => block.type === "tool_result").map((block) => block.text ?? ""),
      ].filter((part) => part.length > 0).join("\n");
      if (!hasImage) return { role: "user", content };
      return { role: "user", content: message.content.flatMap(toChatUserBlock) };
    }
    case "assistant": {
      const text = messageText(message);
      const calls = message.content.filter((block) => block.type === "tool_use").map(toChatToolCall);
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = text.length > 0 ? text : calls.length > 0 ? null : "";
      if (calls.length > 0) msg.tool_calls = calls;
      if (message.reasoningContent !== undefined) msg.reasoning_content = message.reasoningContent;
      return msg;
    }
    case "tool": {
      const block = message.content[0];
      return { role: "tool", tool_call_id: block?.toolCallId ?? "", content: block?.text ?? "" };
    }
  }
}

function toChatUserBlock(block: ContentBlock): readonly Record<string, unknown>[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text ?? "" }];
    case "image":
      return [{ type: "image_url", image_url: { url: toOpenAIImageUrl(block.image) } }];
    case "tool_result":
      return [{ type: "text", text: block.text ?? "" }];
    default:
      return [];
  }
}

function toChatToolCall(block: ContentBlock): Record<string, unknown> {
  const name = block.toolName ?? "";
  return {
    id: block.toolCallId ?? `call_${name}`,
    type: "function",
    function: { name, arguments: block.toolArguments ?? block.text ?? "{}" },
  };
}

export function toOpenAIImageUrl(image: ImageReference | undefined): string {
  if (!image) return "";
  if (image.kind === "url") return image.value;
  if (image.kind === "data") {
    if (image.value.startsWith("data:")) return image.value;
    return `data:${image.mediaType ?? "image/png"};base64,${image.value}`;
  }
  throw new ProtocolCodecError({
    kind: "capability_unsupported",
    message: "file-kind image references cannot be inlined to upstream providers",
    statusCode: 400,
    routeScope: null,
  });
}

/**
 * Maps an OpenAI chat usage record into application ProviderUsage. Cache read
 * tokens and reasoning tokens are surfaced when the upstream reports them.
 */
export function mapChatUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputTokens = nullableNumber(usage.prompt_tokens);
  const outputTokens = nullableNumber(usage.completion_tokens);
  const totalTokens = nullableNumber(usage.total_tokens);
  const inputDetails = usage.prompt_tokens_details;
  const outputDetails = usage.completion_tokens_details;
  const cachedTokens = isRecord(inputDetails) ? nullableNumber(inputDetails.cached_tokens) : null;
  const reasoningTokens = isRecord(outputDetails) ? nullableNumber(outputDetails.reasoning_tokens) : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: null,
    reasoningTokens,
    source: "provider",
  };
}
