/**
 * Outbound request transforms, applied exactly once immediately before an
 * upstream fetch. Keeping them after format translation means the same
 * behavior covers native forwarding and every cross-provider route.
 *
 * The system prompt is server-controlled configuration — client request
 * fields cannot enable or replace it.
 */

export type UpstreamFormat = "openai" | "anthropic";

export interface RequestTransformSettings {
  systemPrompt: string | undefined;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: JsonObject, key: string): unknown {
  return value[key];
}

function setField(value: JsonObject, key: string, replacement: unknown): void {
  value[key] = replacement;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function objectArray(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value) || !value.every(isObject)) return undefined;
  return value;
}

function appendOpenAISystemMessage(message: JsonObject, prompt: string): void {
  const content = field(message, "content");
  if (typeof content === "string") {
    setField(message, "content", `${content}\n\n${prompt}`);
    return;
  }
  const parts = objectArray(content);
  if (parts) {
    const hasInputText = parts.some((part) => part.type === "input_text");
    parts.push(hasInputText ? { type: "input_text", text: prompt } : { type: "text", text: prompt });
    return;
  }
  setField(message, "content", prompt);
}

function injectOpenAISystemPrompt(body: JsonObject, prompt: string): void {
  const instructions = stringField(body, "instructions");
  if (instructions !== undefined || Object.hasOwn(body, "instructions")) {
    setField(body, "instructions", instructions ? `${instructions}\n\n${prompt}` : prompt);
    return;
  }
  const messages = objectArray(field(body, "messages"));
  if (!messages) return;
  const existing = messages.find((message) => message.role === "system" || message.role === "developer");
  if (existing) appendOpenAISystemMessage(existing, prompt);
  else messages.unshift({ role: "system", content: prompt });
}

function injectAnthropicSystemPrompt(body: JsonObject, prompt: string): void {
  const system = field(body, "system");
  if (typeof system === "string") {
    setField(body, "system", system ? `${system}\n\n${prompt}` : prompt);
    return;
  }
  const blocks = objectArray(system);
  if (blocks) {
    const lastCacheControl = blocks.findLastIndex((block) => Object.hasOwn(block, "cache_control"));
    const injected = { type: "text", text: prompt };
    if (lastCacheControl === -1) blocks.push(injected);
    else blocks.splice(lastCacheControl, 0, injected);
    return;
  }
  setField(body, "system", prompt);
}

/** Appends the configured server prompt into the format's system-instruction location. */
export function injectSystemPrompt(body: unknown, format: UpstreamFormat, prompt: string): void {
  if (!isObject(body) || prompt.length === 0) return;
  if (format === "anthropic") injectAnthropicSystemPrompt(body, prompt);
  else injectOpenAISystemPrompt(body, prompt);
}

/**
 * Returns an outgoing request ready for upstream dispatch. No configured
 * system prompt returns the original object without allocating a clone;
 * otherwise the transform operates on a structured clone so route-local
 * request data stays untouched.
 */
export function prepareOutboundRequest(body: unknown, format: UpstreamFormat, settings: RequestTransformSettings): unknown {
  if (settings.systemPrompt === undefined) return body;
  try {
    const transformed = structuredClone(body);
    injectSystemPrompt(transformed, format, settings.systemPrompt);
    return transformed;
  } catch (error) {
    console.warn("[transforms] could not clone outbound request; forwarding it unchanged", error);
    return body;
  }
}
