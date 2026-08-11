import { findCacheBreakpoint } from "../../../application/cache";
import { ProtocolCodecError } from "../errors";
import type { ProviderCaps, ProviderUsage } from "../../../application/contracts";

const DEFAULT_MAX_TOKENS = 4_096;
const MAX_THINKING_BUDGET = 32_000;
import { abortedError,
boundJsonLength,
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
MAX_DATA_URL_LENGTH,
MAX_MEDIA_TYPE_LENGTH,
MAX_MESSAGE_COUNT,
MAX_MODEL_LENGTH,
MAX_OUTPUT_TOKENS,
MAX_TEXT_BLOCK_LENGTH,
MAX_TOOL_ARGUMENT_LENGTH,
MAX_TOOL_COUNT,
MAX_TOOL_NAME_LENGTH,
type NormalizeInput,
type NormalizeResult,
type ProtocolError, } from "../../../application/protocols";
import type { ContentBlock, ImageReference, NormalizedMessage, ProxyRequest, NormalizedTool } from "../../../application/contracts";
import { preserveWirePayload } from "../policy/fields";

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

  const contextManagement = normalizeContextManagement(root["context_management"]);
  if (isProtocolError(contextManagement)) return normalizeFail(contextManagement);

  const reasoningState = { seen: false };
  const images: ImageReference[] = [];
  const messages = normalizeMessages(root["messages"], images, reasoningState);
  if (isProtocolError(messages)) return normalizeFail(messages);

  const system = normalizeSystem(root["system"]);
  if (isProtocolError(system)) return normalizeFail(system);

  const tools = normalizeTools(root["tools"]);
  if (isProtocolError(tools)) return normalizeFail(tools);
  const mcpServers = normalizeMcpServers(root["mcp_servers"]);
  if (isProtocolError(mcpServers)) return normalizeFail(mcpServers);

  const metadata = root["metadata"];
  const metadataUserId = isRecord(metadata) && typeof metadata.user_id === "string" && metadata.user_id.length <= 4096 ? metadata.user_id : undefined;
  const reasoning = reasoningState.seen ? "enabled" : thinking;
  return normalizeOk({
    model,
    stream,
    messages: [...system, ...messages],
    tools,
    responseFormat: "text",
    reasoning,
    maxOutputTokens: maxTokens,
    images,
    sourceSurface: "anthropic-messages",
    signal: input.signal,
    limits: input.limits,
    wirePayload: root,
    ...(contextManagement === undefined ? {} : { contextManagement }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
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
  if (type === "enabled" || type === "adaptive") return "enabled";
  if (type === "disabled") return "disabled";
  if (typeof type === "string") return protocolError("thinking.type", `thinking.type: unsupported mode "${type}"`);
  return protocolError("thinking.type", 'thinking.type: expected "enabled", "adaptive", or "disabled"');
}
function normalizeContextManagement(raw: unknown): Readonly<Record<string, unknown>> | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = narrowObject(raw, "context_management");
  if (isProtocolError(value)) return value;
  const bound = boundJsonLength(value, "context_management", 64 * 1024);
  return bound === null ? value : bound;
}

function normalizeSystem(raw: unknown): NormalizedMessage[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, "system");
    if (isProtocolError(text)) return text;
    return [{ role: "system", content: [{ type: "text", text }] }];
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
      const text = normalizeTextBlock(obj["text"], `${field}.text`);
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

/**
 * Validates context text without imposing a smaller proxy-side limit. The
 * request body is already bounded at the transport layer, and cross-protocol
 * adapters must receive the client's exact text.
 */
function normalizeTextBlock(value: unknown, field: string): string | ProtocolError {
  if (typeof value !== "string") return protocolError(field, `${field}: expected a string`);
  return value;
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
    messages.push(...expandToolResultMessages(message));
  }
  return messages;
}

function expandToolResultMessages(message: NormalizedMessage): NormalizedMessage[] {
  if (!message.content.some((block) => block.type === "tool_result")) return [message];
  const expanded: NormalizedMessage[] = [];
  let visibleBlocks: ContentBlock[] = [];
  const flushVisible = () => {
    if (visibleBlocks.length > 0) {
      expanded.push({ ...message, role: "user", content: visibleBlocks });
      visibleBlocks = [];
    }
  };
  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushVisible();
      expanded.push({ ...message, role: "tool", content: [block] });
    } else {
      visibleBlocks.push(block);
    }
  }
  flushVisible();
  return expanded;
}

function normalizeMessage(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): NormalizedMessage | ProtocolError {
  const obj = narrowObject(raw, field);
  if (isProtocolError(obj)) return obj;
  const role = narrowString(obj["role"], `${field}.role`, 32);
  if (isProtocolError(role)) return role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return protocolError(`${field}.role`, `unsupported role "${role}" (Anthropic messages use user, assistant, or system)`);
  }
  const content = normalizeContent(obj["content"], `${field}.content`, images, reasoningState);
  if (isProtocolError(content)) return content;
  return { role, content };
}

function normalizeContent(raw: unknown, field: string, images: ImageReference[], reasoningState: { seen: boolean }): ContentBlock[] | ProtocolError {
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, field);
    if (isProtocolError(text)) return text;
    return [{ type: "text", text }];
  }
  const list = narrowArray(raw, field, MAX_BLOCKS_PER_MESSAGE);
  if (isProtocolError(list)) return list;
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const blockField = `${field}[${i}]`;
    if (item === undefined) continue;
    if (isRecord(item) && item["type"] === "thinking") {
      const thinking = normalizeTextBlock(item["thinking"], `${blockField}.thinking`);
      if (isProtocolError(thinking)) return thinking;
      reasoningState.seen = true;
      blocks.push({ type: "reasoning", nativeType: "thinking", reasoningText: thinking, nativePayload: { ...item }, raw: item });
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
      const text = normalizeTextBlock(obj["text"], `${field}.text`);
      if (isProtocolError(text)) return text;
      const cacheControl = isRecord(obj["cache_control"]) && obj["cache_control"]["type"] === "ephemeral" ? "ephemeral" as const : undefined;
      return { type: "text", text, ...(cacheControl === undefined ? {} : { cacheControl }) };
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
    case "compaction": {
      const content = obj["content"];
      if (content !== undefined && content !== null && typeof content !== "string") return protocolError(`${field}.content`, `${field}.content: expected a string or null`);
      return { type: "compaction", text: typeof content === "string" ? content : undefined, raw: obj };
    }
    default:
      if (typeof type === "string") {
        return { type: "native", nativeType: type, nativePayload: { ...obj }, raw: obj };
      }
      return protocolError(`${field}.type`, "content block type must be a string");
  }
}

function normalizeToolResult(raw: unknown, field: string, callId: string, images: ImageReference[]): ContentBlock[] | ProtocolError {
  if (raw === undefined || raw === null) return [{ type: "tool_result", toolCallId: callId }];
  if (typeof raw === "string") {
    const text = normalizeTextBlock(raw, field);
    if (isProtocolError(text)) return text;
    return [{ type: "tool_result", text, toolCallId: callId }];
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
      const text = normalizeTextBlock(obj["text"], `${itemField}.text`);
      if (isProtocolError(text)) return text;
      blocks.push({ type: "tool_result", text, toolCallId: callId });
    } else if (type === "image") {
      const image = normalizeImage(obj["source"], `${itemField}.source`, images);
      if (isProtocolError(image)) return image;
      blocks.push({ type: "tool_result", image, toolCallId: callId });
      const serialized = typeof obj["text"] === "string" ? obj["text"] : JSON.stringify(obj);
      blocks.push({ type: "tool_result", text: serialized, toolCallId: callId, raw: obj });
    } else if (typeof type === "string") {
      const serialized = typeof obj["text"] === "string" ? obj["text"] : JSON.stringify(obj);
      blocks.push({ type: "tool_result", text: serialized, toolCallId: callId, nativeType: type, nativePayload: { ...obj }, raw: obj });
    } else {
      return protocolError(`${itemField}.type`, "tool result block must have a string type");
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

function normalizeMcpServers(raw: unknown): readonly Readonly<Record<string, unknown>>[] | ProtocolError | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = narrowArray(raw, "mcp_servers", MAX_TOOL_COUNT);
  if (isProtocolError(list)) return list;
  const servers: Readonly<Record<string, unknown>>[] = [];
  for (let i = 0; i < list.length; i++) {
    const field = `mcp_servers[${i}]`;
    const server = narrowObject(list[i], field);
    if (isProtocolError(server)) return server;
    const sizeError = boundJsonLength(server, field, MAX_TEXT_BLOCK_LENGTH);
    if (sizeError !== null) return sizeError;
    servers.push(server);
  }
  return servers;
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
export function buildMessagesPayload(request: ProxyRequest, capabilities: ProviderCaps, options: { readonly includeContextManagement?: boolean } = {}): Record<string, unknown> {
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
      .map((message) => toAnthropicMessage(message, capabilities)),
  };
  if (systemText.length > 0) {
    payload.system = systemText;
  }
  if (request.metadataUserId !== undefined) payload.metadata = { user_id: request.metadataUserId };
  if (request.mcpServers !== undefined) payload.mcp_servers = request.mcpServers;
  if (request.tools.length > 0) {
    payload.tools = request.tools.map((tool) => {
      if (tool.nativeType !== undefined) {
        return tool.nativeType === "mcp_toolset"
          ? { type: tool.nativeType, ...(tool.nativeOptions ?? {}) }
          : { type: tool.nativeType, name: tool.name, ...(tool.nativeOptions ?? {}) };
      }
      const definition: Record<string, unknown> = {
        name: tool.name,
        description: tool.description ?? undefined,
        input_schema: tool.inputSchema,
      };
      if (tool.deferLoading !== undefined) definition.defer_loading = tool.deferLoading;
      if (tool.allowedCallers !== undefined) definition.allowed_callers = tool.allowedCallers;
      if (tool.inputExamples !== undefined) definition.input_examples = tool.inputExamples;
      return definition;
    });
  }
  if (options.includeContextManagement !== false && request.contextManagement !== undefined) payload.context_management = request.contextManagement;
  if (request.reasoning === "enabled" && capabilities.reasoning) {
    payload.thinking = { type: "enabled", budget_tokens: Math.min(request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, MAX_THINKING_BUDGET) };
  }
  preserveWirePayload(payload, request, "anthropic-messages", options.includeContextManagement === false ? ["model", "max_tokens", "stream", "messages", "system", "metadata", "mcp_servers", "tools", "thinking"] : ["model", "max_tokens", "stream", "messages", "system", "metadata", "mcp_servers", "tools", "context_management", "thinking"]);
  if (cacheEnabled) applyAnthropicCacheControl(payload, request);
  return payload;
}

function applyAnthropicCacheControl(payload: Record<string, unknown>, request: ProxyRequest): void {
  const position = findCacheBreakpoint(request);
  if (position !== null) {
    const target = request.messages[position.messageIndex];
    if (target?.role === "system" || target?.role === "developer") {
      applySystemCacheControl(payload);
      return;
    }
    const messages = payload.messages;
    if (Array.isArray(messages)) {
      let wireIndex = 0;
      for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
        const message = request.messages[messageIndex];
        if (message === undefined || message.role === "system" || message.role === "developer") continue;
        if (messageIndex === position.messageIndex && markAnthropicMessage(messages[wireIndex])) return;
        wireIndex += 1;
      }
    }
  }
  applySystemCacheControl(payload);
  applyLastUserCacheControl(payload);
}

function markAnthropicMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    message.content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block) || block.type !== "text") continue;
    content[index] = { ...block, cache_control: { type: "ephemeral" } };
    return true;
  }
  return false;
}

function applySystemCacheControl(payload: Record<string, unknown>): void {
  const system = payload.system;
  if (typeof system === "string" && system.length > 0) {
    payload.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (!Array.isArray(system)) return;
  let marked = false;
  const blocks = system.map((block) => {
    if (!isRecord(block) || block.type !== "text" || marked) return block;
    marked = true;
    return { ...block, cache_control: { type: "ephemeral" } };
  });
  if (marked) payload.system = blocks;
}

function applyLastUserCacheControl(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      payload.messages = messages.map((item, index) => index === i ? { ...message, content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }] } : item);
      return;
    }
    if (!Array.isArray(content)) continue;
    let marked = false;
    const updatedContent = content.map((block) => {
      if (!isRecord(block) || block.type !== "text" || marked) return block;
      marked = true;
      return { ...block, cache_control: { type: "ephemeral" } };
    });
    if (marked) {
      payload.messages = messages.map((item, index) => index === i ? { ...message, content: updatedContent } : item);
      return;
    }
  }
}


function toAnthropicMessage(message: NormalizedMessage, capabilities: ProviderCaps): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content.flatMap(toAnthropicUserBlock) };
    case "assistant": {
      const content: Record<string, unknown>[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text ?? "" });
        else if (block.type === "reasoning" && capabilities.reasoning && block.reasoningText !== undefined) content.push({ type: "thinking", thinking: block.reasoningText });
        else if (block.type === "compaction") content.push(block.raw ?? { type: "compaction", content: block.text ?? null });
        else if (block.type === "tool_use") content.push(toAnthropicToolUse(block));
        else if (block.type === "native" && capabilities.toolCalls && isRecord(block.nativePayload)) content.push({ ...block.nativePayload });
      }
      return { role: "assistant", content };
    }
    case "tool": {
      const first = message.content[0];
      const content: Array<string | Readonly<Record<string, unknown>>> = [];
      for (const block of message.content) {
        if (block.raw !== undefined) content.push(block.raw);
        else if (block.image !== undefined) content.push({ type: "image", source: toAnthropicImageSource(block.image) });
        else content.push(block.text ?? "");
      }
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: first?.toolCallId ?? "",
          content: content.length === 1 && first?.raw === undefined ? content[0] : content,
          ...(first?.toolResultIsError ? { is_error: true } : {}),
        }],
      };
    }
    case "system":
    case "developer":
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
      return [{ type: "text", text: block.text ?? "", ...(block.cacheControl === "ephemeral" ? { cache_control: { type: "ephemeral" } } : {}) }];
    case "image":
      return [{ type: "image", source: toAnthropicImageSource(block.image) }];
    case "tool_result":
      return [{ type: "tool_result", tool_use_id: block.toolCallId ?? "", content: block.text ?? "", ...(block.toolResultIsError ? { is_error: true } : {}) }];
    case "native":
      return isRecord(block.nativePayload) ? [{ ...block.nativePayload }] : [];
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

