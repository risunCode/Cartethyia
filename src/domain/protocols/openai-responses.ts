import { toOpenAIImageUrl } from "./openai-chat";
import type { ProviderUsage } from "../contracts";
import {
  abortedError,
  classifyImageReference,
  isProtocolError,
  isRecord,
  messageText,
  narrowArray,
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
  MAX_IMAGE_COUNT,
  MAX_IMAGE_URL_LENGTH,
  MAX_DATA_URL_LENGTH,
  MAX_MEDIA_TYPE_LENGTH,
  MAX_MESSAGE_COUNT,
  MAX_MODEL_LENGTH,
  MAX_OUTPUT_TOKENS,
  MAX_TEXT_BLOCK_LENGTH,
  MAX_TOOL_ARGUMENT_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_TOOL_NAME_LENGTH,
  type NormalizeInput,
  type NormalizeResult,
  type ProtocolError,
} from "../protocols";
import type { ContentBlock, ImageReference, NormalizedMessage, NormalizedProviderRequest, NormalizedTool } from "../contracts";

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

  const maxOutputTokens = normalizeMaxOutputTokens(root["max_output_tokens"]);
  if (isProtocolError(maxOutputTokens)) return normalizeFail(maxOutputTokens);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const inputMessages = normalizeInput(root["input"], images, reasoningState);
  if (isProtocolError(inputMessages)) return normalizeFail(inputMessages);

  const instructions = normalizeInstructions(root["instructions"]);
  if (isProtocolError(instructions)) return normalizeFail(instructions);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const finalReasoning = reasoningState.seen ? "enabled" : reasoning;

  return normalizeOk({
    model,
    messages: [...instructions, ...inputMessages],
    tools,
    stream,
    responseFormat,
    reasoning: finalReasoning,
    maxOutputTokens,
    images,
    sourceSurface: "openai-responses",
    signal: input.signal,
    limits: input.limits,
  });
}

function normalizeInstructions(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") return protocolError("instructions", "instructions: expected a string");
  if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("instructions", `instructions: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
  return [{ role: "system", content: [{ type: "text", text: raw }] }];
}

function normalizeResponseFormat(raw: unknown): NormalizedProviderRequest["responseFormat"] | ProtocolError {
  if (raw === undefined || raw === null) return "text";
  const text = narrowObject(raw, "text");
  if (isProtocolError(text)) return text;
  const format = text["format"];
  if (format === undefined || format === null) return "text";
  const formatObj = narrowObject(format, "text.format");
  if (isProtocolError(formatObj)) return formatObj;
  const type = formatObj["type"];
  if (type === "text" || type === "json_object" || type === "json_schema") return type;
  if (typeof type === "string") return protocolError("text.format.type", `text.format.type: unsupported format "${type}"`);
  return protocolError("text.format.type", 'text.format.type: expected "text", "json_object", or "json_schema"');
}

function normalizeReasoning(raw: unknown): "enabled" | "disabled" | "default" | ProtocolError {
  if (raw === undefined || raw === null) return "default";
  const obj = narrowObject(raw, "reasoning");
  if (isProtocolError(obj)) return obj;
  if (obj["enabled"] === false) return "disabled";
  if (obj["enabled"] === true) return "enabled";
  if (typeof obj["effort"] === "string" && obj["effort"] !== "") return "enabled";
  return "default";
}

function normalizeMaxOutputTokens(raw: unknown): number | null | ProtocolError {
  if (raw === undefined || raw === null) return null;
  const value = narrowNumber(raw, "max_output_tokens", { integer: true, min: 0, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

function normalizeInput(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage[] | ProtocolError {
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("input", `input: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return [{ role: "user", content: [{ type: "text", text: raw }] }];
  }
  const list = narrowArray(raw, "input", MAX_MESSAGE_COUNT);
  if (isProtocolError(list)) return list;
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `input[${i}]`;
    if (item === undefined) continue;
    if (typeof item === "string") {
      if (item.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
      messages.push({ role: "user", content: [{ type: "text", text: item }] });
      continue;
    }
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "message") {
      const message = normalizeMessageItem(obj, field, images, reasoningState);
      if (isProtocolError(message)) return message;
      messages.push(message);
    } else if (type === "function_call") {
      const block = normalizeFunctionCallItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push({ role: "assistant", content: [block] });
    } else if (type === "function_call_output") {
      const block = normalizeFunctionCallOutputItem(obj, field);
      if (isProtocolError(block)) return block;
      messages.push({ role: "tool", content: [block] });
    } else if (type === "reasoning") {
      // Item-level reasoning carries no visible text.
      reasoningState.seen = true;
    } else if (typeof type === "string") {
      return protocolError(`${field}.type`, `unsupported input item type "${type}"`);
    } else {
      return protocolError(`${field}.type`, "input item type must be a string");
    }
  }
  return messages;
}

function normalizeMessageItem(obj: Record<string, unknown>, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    return protocolError(`${field}.role`, `unsupported message role "${role}"`);
  }
  const content = normalizeMessageContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content };
}

function normalizeMessageContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (item === undefined) continue;
    if (isRecord(item) && item["type"] === "reasoning") {
      // Reasoning blocks carry no visible text; the request-level flag
      // preserves the reasoning/text distinction.
      reasoningState.seen = true;
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
      const argumentsValue = narrowString(obj["arguments"] ?? "{}", `${field}.arguments`, MAX_TOOL_ARGUMENT_LENGTH);
      if (isProtocolError(argumentsValue)) return argumentsValue;
      return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
    }
    case "function_call_output": {
      const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
      const output = narrowString(obj["output"], `${field}.output`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(output)) return output;
      return { type: "tool_result", text: output, toolCallId: callId };
    }
    case "refusal":
      // Refusal content is never visible text.
      return { type: "unknown" };
    default:
      if (typeof type === "string") {
        return { type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined };
      }
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
  const argumentsValue = narrowString(obj["arguments"] ?? "{}", `${field}.arguments`, MAX_TOOL_ARGUMENT_LENGTH);
  if (isProtocolError(argumentsValue)) return argumentsValue;
  return { type: "tool_use", toolName: name, toolCallId: callId, toolArguments: argumentsValue };
}

function normalizeFunctionCallOutputItem(obj: Record<string, unknown>, field: string): ContentBlock | ProtocolError {
  const callId = narrowString(obj["call_id"], `${field}.call_id`, 128);
  if (isProtocolError(callId)) return callId;
  if (callId === "") return protocolError(`${field}.call_id`, "call_id must not be empty");
  const output = narrowString(obj["output"], `${field}.output`, MAX_TEXT_BLOCK_LENGTH);
  if (isProtocolError(output)) return output;
  return { type: "tool_result", text: output, toolCallId: callId };
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
export function buildResponsesPayload(request: NormalizedProviderRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    stream: request.stream,
    input: request.messages.flatMap(toResponsesItem),
  };
  if (request.tools.length > 0) {
    payload.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? undefined,
      parameters: tool.inputSchema,
    }));
  }
  if (request.maxOutputTokens !== null) payload.max_output_tokens = request.maxOutputTokens;
  if (request.cacheKey !== undefined) payload.prompt_cache_key = request.cacheKey;
  if (request.responseFormat !== "text") payload.text = { format: { type: "json_object" } };
  if (request.reasoning === "enabled") payload.reasoning = { effort: "medium" };
  return payload;
}

function toResponsesItem(message: NormalizedMessage): readonly Record<string, unknown>[] {
  switch (message.role) {
    case "system":
    case "developer":
      return [{ role: message.role, content: messageText(message) }];
    case "user": {
      const hasImage = message.content.some((block) => block.type === "image");
      if (!hasImage) return [{ role: "user", content: messageText(message) }];
      const blocks: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") blocks.push({ type: "input_text", text: block.text ?? "" });
        else if (block.type === "image") blocks.push({ type: "input_image", image_url: toOpenAIImageUrl(block.image) });
      }
      return [{ role: "user", content: blocks }];
    }
    case "assistant": {
      const items: Record<string, unknown>[] = [];
      const text = messageText(message);
      const calls = message.content.filter((block) => block.type === "tool_use");
      // A tool-call-only assistant turn (function_call items round-tripping)
      // must not fabricate an empty visible assistant message.
      if (text.length > 0 || calls.length === 0) {
        items.push({ role: "assistant", content: [{ type: "output_text", text }] });
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
      return [{ role: "user", content: [{ type: "function_call_output", call_id: block?.toolCallId ?? "", output: block?.text ?? "" }] }];
    }
  }
}

/**
 * Maps an OpenAI Responses usage record into application ProviderUsage. Cache
 * read tokens are always surfaced when the upstream reports them.
 */
export function mapResponsesUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputTokens = nullableNumber(usage.input_tokens);
  const outputTokens = nullableNumber(usage.output_tokens);
  const totalTokens = nullableNumber(usage.total_tokens);
  const details = usage.input_tokens_details;
  const cachedTokens = isRecord(details) ? nullableNumber(details.cached_tokens) : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: null,
    source: "provider",
  };
}
