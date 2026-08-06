import { ProtocolCodecError } from "./errors";
import type { ProviderCapabilities, ProviderUsage } from "../contracts";

const DEFAULT_MAX_TOKENS = 4_096;
const MAX_THINKING_BUDGET = 32_000;
import {
  abortedError,
  boundJsonLength,
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

export function normalizeMessagesRequest(body: unknown, input: NormalizeInput): NormalizeResult {
  const aborted = abortedError(input.signal);
  if (aborted !== null) return normalizeFail(aborted);
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);

  const model = narrowString(root["model"], "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model)) return normalizeFail(model);
  if (model.trim() === "") return normalizeFail(protocolError("model", "model: must not be empty"));

  const stream = normalizeStream(root["stream"]);
  if (isProtocolError(stream)) return normalizeFail(stream);

  const maxTokens = normalizeMaxTokens(root);
  if (isProtocolError(maxTokens)) return normalizeFail(maxTokens);

  const thinking = normalizeThinking(root["thinking"]);
  if (isProtocolError(thinking)) return normalizeFail(thinking);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const messages = normalizeMessages(root["messages"], images, reasoningState);
  if (isProtocolError(messages)) return normalizeFail(messages);

  const system = normalizeSystem(root["system"]);
  if (isProtocolError(system)) return normalizeFail(system);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);

  const metadata = root["metadata"];
  const metadataUserId = isRecord(metadata) && typeof metadata.user_id === "string" && metadata.user_id.length <= 4096 ? metadata.user_id : undefined;
  const reasoning = reasoningState.seen ? "enabled" : thinking;

  return normalizeOk({
    model,
    messages: [...system, ...messages],
    tools,
    stream,
    responseFormat: "text",
    reasoning,
    maxOutputTokens: maxTokens,
    images,
    sourceSurface: "anthropic-messages",
    signal: input.signal,
    limits: input.limits,
    ...(metadataUserId === undefined ? {} : { metadataUserId }),
  });
}

function normalizeMaxTokens(root: Record<string, unknown>): number | ProtocolError {
  const raw = root["max_tokens"];
  if (raw === undefined || raw === null) return protocolError("max_tokens", "max_tokens: is required for Anthropic Messages");
  const value = narrowNumber(raw, "max_tokens", { integer: true, min: 1, max: MAX_OUTPUT_TOKENS });
  if (isProtocolError(value)) return value;
  return value;
}

function normalizeThinking(raw: unknown): "enabled" | "disabled" | "default" | ProtocolError {
  if (raw === undefined || raw === null) return "default";
  const obj = narrowObject(raw, "thinking");
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  if (type === "enabled") return "enabled";
  if (type === "disabled") return "disabled";
  if (typeof type === "string") return protocolError("thinking.type", `thinking.type: unsupported mode "${type}"`);
  return protocolError("thinking.type", 'thinking.type: expected "enabled" or "disabled"');
}

function normalizeSystem(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError("system", `system: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return [{ role: "system", content: [{ type: "text", text: raw }] }];
  }
  const list = narrowArray(raw, "system", MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `system[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text") {
      const text = narrowString(obj["text"], `${field}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "text", text });
    } else if (typeof type === "string") {
      blocks.push({ type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined });
    } else {
      return protocolError(`${field}.type`, "system block type must be a string");
    }
  }
  return [{ role: "system", content: blocks }];
}

function normalizeMessages(raw: unknown, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage[] | ProtocolError {
  const list = narrowArray(raw, "messages", MAX_MESSAGE_COUNT);
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
  if (role !== "user" && role !== "assistant") {
    return protocolError(`${field}.role`, `unsupported role "${role}" (Anthropic messages use only "user" and "assistant")`);
  }
  const content = normalizeContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content };
}

function normalizeContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentBlock[] | ProtocolError {
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
    if (isRecord(item) && item["type"] === "thinking") {
      // Thinking blocks carry reasoning, never visible text; the
      // request-level `reasoning` flag preserves the distinction.
      reasoningState.seen = true;
      continue;
    }
    if (isRecord(item) && item["type"] === "tool_result") {
      const callId = narrowString(item["tool_use_id"], `${blockField}.tool_use_id`, 128);
      if (isProtocolError(callId)) return callId;
      if (callId === "") return protocolError(`${blockField}.tool_use_id`, "tool_use_id must not be empty");
      const isError = item["is_error"] === true;
      const results = normalizeToolResult(item["content"], blockField, callId, images);
      if (isProtocolError(results)) return results;
      blocks.push(...results.map((block) => isError ? { ...block, toolResultIsError: true } : block));
      continue;
    }
    const block = normalizeBlock(item, blockField, images);
    if (isProtocolError(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

function normalizeBlock(raw: unknown, field: string, images: ImageReference[]): ContentBlock | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const type = obj["type"];
  switch (type) {
    case "text": {
      const text = narrowString(obj["text"], `${field}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      return { type: "text", text };
    }
    case "image": {
      const image = normalizeImage(obj["source"], `${field}.source`, images);
      if (isProtocolError(image)) return image;
      return { type: "image", image };
    }
    case "tool_use": {
      const id = narrowString(obj["id"], `${field}.id`, 128);
      if (isProtocolError(id)) return id;
      if (id === "") return protocolError(`${field}.id`, "tool use id must not be empty");
      const name = narrowString(obj["name"], `${field}.name`, MAX_TOOL_NAME_LENGTH);
      if (isProtocolError(name)) return name;
      if (name.trim() === "") return protocolError(`${field}.name`, "tool use name must not be empty");
      const input = narrowObject(obj["input"] ?? {}, `${field}.input`);
      if (isProtocolError(input)) return input;
      const bound = boundJsonLength(input, `${field}.input`, MAX_TOOL_ARGUMENT_LENGTH);
      if (bound !== null) return bound;
      return { type: "tool_use", toolName: name, toolCallId: id, toolArguments: JSON.stringify(input) };
    }
    default:
      if (typeof type === "string") {
        return { type: "unknown", text: typeof obj["text"] === "string" ? obj["text"] : undefined };
      }
      return protocolError(`${field}.type`, "content block type must be a string");
  }
}

function normalizeToolResult(raw: unknown, field: string, callId: string, images: ImageReference[]): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [{ type: "tool_result", toolCallId: callId }];
  if (typeof raw === "string") {
    if (raw.length > MAX_TEXT_BLOCK_LENGTH) return protocolError(field, `${field}: text exceeds ${MAX_TEXT_BLOCK_LENGTH} characters`);
    return [{ type: "tool_result", text: raw, toolCallId: callId }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const itemField = `${field}[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, itemField);
    if (isProtocolError(obj)) return obj;
    const type = obj["type"];
    if (type === "text") {
      const text = narrowString(obj["text"], `${itemField}.text`, MAX_TEXT_BLOCK_LENGTH);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "tool_result", text, toolCallId: callId });
    } else if (type === "image") {
      const image = normalizeImage(obj["source"], `${itemField}.source`, images);
      if (isProtocolError(image)) return image;
      blocks.push({ type: "tool_result", image, toolCallId: callId });
    } else if (typeof type === "string") {
      blocks.push({ type: "tool_result", text: typeof obj["text"] === "string" ? obj["text"] : undefined, toolCallId: callId });
    } else {
      return protocolError(`${itemField}.type`, "tool result block type must be a string");
    }
  }
  return blocks;
}

function normalizeImage(raw: unknown, field: string, images: ImageReference[]): ImageReference | ProtocolError {
  const source = narrowObject(raw, field);
  if (isProtocolError(source)) return source;
  const type = source["type"];
  if (type === "base64") {
    const mediaType = narrowString(source["media_type"], `${field}.media_type`, MAX_MEDIA_TYPE_LENGTH);
    if (isProtocolError(mediaType)) return mediaType;
    if (mediaType === "") return protocolError(`${field}.media_type`, "media_type must not be empty");
    const data = narrowString(source["data"], `${field}.data`, MAX_DATA_URL_LENGTH);
    if (isProtocolError(data)) return data;
    if (data === "") return protocolError(`${field}.data`, "base64 data must not be empty");
    const reference: ImageReference = { kind: "data", value: data, mediaType };
    const bound = pushImageReference(images, reference, field);
    if (bound !== null) return bound;
    return reference;
  }
  if (type === "url") {
    const classification = classifyImageReference(source["url"], `${field}.url`);
    if (!classification.ok) return classification.error;
    const bound = pushImageReference(images, classification.reference, field);
    if (bound !== null) return bound;
    return classification.reference;
  }
  if (typeof type === "string") return protocolError(`${field}.type`, `unsupported image source type "${type}"`);
  return protocolError(`${field}.type`, "image source type must be a string");
}

function normalizeTools(raw: unknown): NormalizedTool[] | ProtocolError {
  return normalizeToolList(raw, { unwrapFunction: false, schemaField: "input_schema", schemaRequired: true });
}

/**
 * Strict validation and normalization for OpenAI Responses
 * (`/v1/responses`, surface "openai-responses").
 *
 * `instructions` becomes the leading system message; message items and
 * top-level `function_call`/`function_call_output` items fold into the
 * normalized message list. `reasoning` items/blocks and `refusal` content
 * never surface as visible text. Function-call arguments are retained as
 * bounded JSON for provider adapters.
 */


// Anthropic Messages wire codec
/**
 * Translates the normalized request into the Anthropic Messages wire
 * payload. max_tokens is required upstream and defaults to 4096. Explicit
 * prompt caching (cache_control on system and the last user text block,
 * plus the beta header in `call`) is emitted only when the adapter declares
 * explicitCache and promptCacheKey.
 */
export function buildMessagesPayload(request: NormalizedProviderRequest, capabilities: ProviderCapabilities): Record<string, unknown> {
  const systemText = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => messageText(message))
    .filter((text) => text.length > 0)
    .join("\n\n");
  const cacheEnabled = capabilities.explicitCache && capabilities.promptCacheKey && request.cacheKey !== undefined;
  const payload: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stream: request.stream,
    messages: request.messages
      .filter((message) => message.role !== "system" && message.role !== "developer")
      .map((message) => toAnthropicMessage(message)),
  };
  if (systemText.length > 0) {
    payload.system = cacheEnabled ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] : systemText;
  }
  if (request.metadataUserId !== undefined) payload.metadata = { user_id: request.metadataUserId };
  if (request.tools.length > 0) {
    payload.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? undefined,
      input_schema: tool.inputSchema,
    }));
  }
  if (request.reasoning === "enabled" && capabilities.reasoning) {
    payload.thinking = { type: "enabled", budget_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, MAX_THINKING_BUDGET) };
  }
  if (cacheEnabled) applyLastUserCacheControl(payload);
  return payload;
}

function applyLastUserCacheControl(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (isRecord(block) && block.type === "text") {
        block.cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
}

function toAnthropicMessage(message: NormalizedMessage): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content.flatMap(toAnthropicUserBlock) };
    case "assistant": {
      const content: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text ?? "" });
        else if (block.type === "tool_use") content.push(toAnthropicToolUse(block));
      }
      return { role: "assistant", content };
    }
    case "tool": {
      const block = message.content[0];
      return { role: "user", content: [{ type: "tool_result", tool_use_id: block?.toolCallId ?? "", content: block?.text ?? "", ...(block?.toolResultIsError ? { is_error: true } : {}) }] };
    }
    case "system":
    case "developer":
      // filtered out by buildMessagesPayload; defensive fallback
      return { role: "user", content: [{ type: "text", text: messageText(message) }] };
  }
}

function toAnthropicToolUse(block: ContentBlock): Record<string, unknown> {
  const raw = block.toolArguments ?? block.text ?? "{}";
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ProtocolCodecError({
      kind: "invalid_request",
      message: `Tool_use arguments for "${block.toolName ?? ""}" are not valid JSON`,
      statusCode: 400,
      routeScope: null,
    });
  }
  return {
    type: "tool_use",
    id: block.toolCallId ?? `toolu_${block.toolName ?? ""}`,
    name: block.toolName ?? "",
    input: isRecord(input) ? input : {},
  };
}

function toAnthropicUserBlock(block: ContentBlock): readonly Record<string, unknown>[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text ?? "" }];
    case "image":
      return [{ type: "image", source: toAnthropicImageSource(block.image) }];
    case "tool_result":
      return [{ type: "tool_result", tool_use_id: block.toolCallId ?? "", content: block.text ?? "", ...(block.toolResultIsError ? { is_error: true } : {}) }];
    default:
      return [];
  }
}

function toAnthropicImageSource(image: ImageReference | undefined): Record<string, unknown> {
  if (!image) return { type: "url", url: "" };
  if (image.kind === "url") return { type: "url", url: image.value };
  if (image.kind === "data") {
    let data = image.value;
    let mediaType = image.mediaType ?? "image/png";
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma !== -1) {
        const meta = data.slice(5, comma);
        data = data.slice(comma + 1);
        const extracted = meta.split(";")[0];
        if (extracted) mediaType = extracted;
      }
    }
    return { type: "base64", media_type: mediaType, data };
  }
  throw new ProtocolCodecError({
    kind: "capability_unsupported",
    message: "file-kind image references cannot be inlined to upstream providers",
    statusCode: 400,
    routeScope: null,
  });
}

/**
 * Maps an Anthropic usage record into application ProviderUsage. Cache read
 * and write tokens are always surfaced when the upstream reports them.
 */
export function mapAnthropicUsage(usage: Record<string, unknown>): ProviderUsage {
  const inputTokens = nullableNumber(usage.input_tokens);
  const outputTokens = nullableNumber(usage.output_tokens);
  const cacheReadTokens = nullableNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = nullableNumber(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheReadTokens,
    cacheWriteTokens,
    source: "provider",
  };
}
