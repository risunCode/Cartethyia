import { isRecord, messageText, nullableNumber } from "../../../application/protocols";
import type { ContentBlock, ImageReference, ProxyRequest, Surface, ProviderUsage } from "../../../application/contracts";

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "minProperties",
  "maxProperties",
  "items",
  "anyOf",
]);

function sanitizeGeminiSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && isRecord(child)) {
      schema.properties = Object.fromEntries(Object.entries(child).map(([name, property]) => [name, sanitizeGeminiSchema(property)]));
    } else if (key === "items" && isRecord(child)) {
      schema.items = sanitizeGeminiSchema(child);
    } else if (key === "anyOf" && Array.isArray(child)) {
      schema.anyOf = child.map(sanitizeGeminiSchema);
    } else if (key === "required" && Array.isArray(child)) {
      schema.required = child.filter((name): name is string => typeof name === "string");
    } else {
      schema[key] = child;
    }
  }
  return schema;
}

export function buildGeminiPayload(request: ProxyRequest): Record<string, unknown> {
  const system = request.messages.filter((message) => message.role === "system" || message.role === "developer").flatMap((message) => {
    const t = messageText(message);
    return t ? [{ text: t }] : [];
  });
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.toolCallId && block.toolName) toolNames.set(block.toolCallId, block.toolName);
    }
  }
  const contents = request.messages.filter((message) => message.role !== "system" && message.role !== "developer").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: message.content.flatMap((block) => toGeminiPart(block, toolNames)) }));
  const payload: Record<string, unknown> = { contents };
  if (system.length > 0) payload.systemInstruction = { role: "user", parts: system };
  if (request.tools.length > 0) payload.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: sanitizeGeminiSchema(tool.inputSchema) })) }];
  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== null) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.responseFormat !== "text") generationConfig.responseMimeType = "application/json";
  if (request.reasoning === "enabled") generationConfig.thinkingConfig = { thinkingBudget: Math.min(request.maxOutputTokens ?? 8192, 32_768) };
  if (request.sourceSurface === "images") generationConfig.responseModalities = ["TEXT", "IMAGE"];
  if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;
  return payload;
}

function toGeminiPart(block: ContentBlock, toolNames: ReadonlyMap<string, string>): Record<string, unknown>[] {
  if (block.type === "text") return [{ text: block.text ?? "" }];
  if (block.type === "reasoning" && block.reasoningText !== undefined) return [{ text: block.reasoningText, thought: true }];
  if (block.type === "image" && block.image) return [toGeminiImage(block.image)];
  if (block.type === "tool_use") return [{ functionCall: { name: block.toolName ?? "", args: parseJsonObject(block.toolArguments ?? block.text ?? "{}"), ...(block.toolCallId ? { id: block.toolCallId } : {}) } }];
  if (block.type === "tool_result") return [{ functionResponse: { name: block.toolName ?? (block.toolCallId ? toolNames.get(block.toolCallId) : undefined) ?? block.toolCallId ?? "tool", response: parseJsonObject(block.text ?? ""), ...(block.toolCallId ? { id: block.toolCallId } : {}) } }];
  return [];
}

function toGeminiImage(image: ImageReference): Record<string, unknown> {
  if (image.kind === "data") return { inlineData: { mimeType: image.mediaType ?? "image/png", data: image.value.replace(/^data:[^;,]+;base64,/, "") } };
  return { fileData: { fileUri: image.value, mimeType: image.mediaType ?? "application/octet-stream" } };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

