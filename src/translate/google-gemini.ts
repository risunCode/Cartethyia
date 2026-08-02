import type { OpenAIChatMessage, OpenAIChatRequest } from "./types";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiTool {
  functionDeclarations?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  googleSearch?: Record<string, never>;
}

export interface GeminiRequest {
  project: string;
  requestId: string;
  model: string;
  userAgent: "antigravity";
  requestType: "agent";
  request: {
    systemInstruction?: { role: "user"; parts: Array<{ text: string }> };
    contents: GeminiContent[];
    tools?: GeminiTool[];
    toolConfig?: { functionCallingConfig: { mode: "VALIDATED" | "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } };
    generationConfig?: Record<string, unknown>;
    labels: Record<string, string>;
    sessionId: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeToolId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

function imagePart(url: string): GeminiPart | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (match) return { inlineData: { mimeType: match[1]!, data: match[2]! } };
  return { text: `[Image URL: ${url}]` };
}

function contentParts(message: OpenAIChatMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (typeof message.content === "string" && message.content.trim()) parts.push({ text: message.content });
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) parts.push({ text: part.text });
      if (part.type === "image_url") {
        const image = imagePart(part.image_url.url);
        if (image) parts.push(image);
      }
    }
  }
  if (message.reasoning_content) parts.unshift({ thought: true, text: message.reasoning_content, ...(message.reasoning_signature ? { thoughtSignature: message.reasoning_signature } : {}) });
  for (const call of message.tool_calls ?? []) {
    parts.push({ functionCall: { id: normalizeToolId(call.id), name: call.function.name, args: parseArguments(call.function.arguments) } });
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

function toolResultParts(message: OpenAIChatMessage): GeminiPart[] {
  let response: Record<string, unknown> = { content: typeof message.content === "string" ? message.content : "" };
  if (typeof message.content === "string") {
    try { response = asRecord(JSON.parse(message.content) as unknown) ?? response; } catch { /* keep text response */ }
  }
  return [{ functionResponse: { name: normalizeToolId(message.tool_call_id ?? "tool"), response } }];
}

function convertTools(request: OpenAIChatRequest): GeminiTool[] | undefined {
  const declarations = (request.tools ?? []).flatMap((tool) => {
    if (tool.type !== "function" || !tool.function) return [];
    return [{ name: normalizeToolId(tool.function.name), description: tool.function.description ?? "", parameters: tool.function.parameters ?? { type: "object", properties: {} } }];
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

/** Converts the Cartethyia OpenAI Chat request into Cloud Code Assist's Gemini request shape. */
export type GeminiRequestEnvelope = Pick<GeminiRequest, "project" | "requestId" | "model"> & { labels: Record<string, string>; sessionId: string };

export function translateChatRequestToGemini(request: OpenAIChatRequest, envelope: GeminiRequestEnvelope): GeminiRequest {
  const systemPrompts = request.messages.filter((message) => message.role === "system" || message.role === "developer").flatMap((message) => typeof message.content === "string" && message.content.trim() ? [message.content] : []);
  const contents = request.messages.filter((message) => message.role !== "system" && message.role !== "developer").map((message) => ({
    role: message.role === "assistant" ? "model" as const : "user" as const,
    parts: message.role === "tool" ? toolResultParts(message) : contentParts(message),
  }));
  const tools = convertTools(request);
  const requestPayload: GeminiRequest["request"] = {
    ...(systemPrompts.length > 0 ? { systemInstruction: { role: "user", parts: systemPrompts.map((text) => ({ text })) } } : {}),
    contents,
    ...(tools ? { tools, toolConfig: { functionCallingConfig: { mode: "VALIDATED" as const } } } : {}),
    labels: envelope.labels,
    sessionId: envelope.sessionId,
  };
  return { project: envelope.project, requestId: envelope.requestId, model: envelope.model, userAgent: "antigravity", requestType: "agent", request: requestPayload };
}

/** Converts a non-streaming Gemini candidate into Cartethyia's OpenAI Chat response. */
export function translateGeminiResponseToChat(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const response = asRecord(payload.response) ?? payload;
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text: string[] = [];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const raw of parts) {
    const part = asRecord(raw);
    if (typeof part?.text === "string" && part.thought !== true) text.push(part.text);
    const call = asRecord(part?.functionCall);
    if (call && typeof call.name === "string") toolCalls.push({ id: typeof call.id === "string" ? call.id : crypto.randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } });
  }
  const usage = asRecord(response.usageMetadata);
  return {
    id: typeof response.responseId === "string" ? response.responseId : `antigravity-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text.join(""), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }, finish_reason: candidate?.finishReason === "MAX_TOKENS" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : 0, completion_tokens: typeof usage?.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0, total_tokens: typeof usage?.totalTokenCount === "number" ? usage.totalTokenCount : 0 },
  };
}
