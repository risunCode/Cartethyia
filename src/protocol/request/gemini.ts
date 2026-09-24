/**
 * Gemini `generateContent` request encoder: canonical → Gemini wire body
 * (contents/systemInstruction/tools/generationConfig) plus the model-URL and
 * schema-sanitization helpers shared with the Antigravity adapter.
 */
import type { CanonicalRequest } from "../../transport/canonical-model";
import { isRecord } from "../primitives";
import { isClaudeBillingHeaderText } from "../primitives";
import { geminiThinkingOutputFloor } from "../../providers/reasoning";

export function geminiModelUrl(base: string, model: string, action: string): string {
  return `${base}/models/${encodeURIComponent(model)}:${action}`;
}

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "const",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "minProperties",
  "maxProperties",
  "items",
  "anyOf",
  "oneOf",
]);

function sanitizeGeminiSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "type") {
      if (typeof child === "string") {
        if (child === "null") schema["nullable"] = true;
        else schema["type"] = child;
      } else if (Array.isArray(child)) {
        const types = child.filter((t): t is string => typeof t === "string");
        const nonNull = types.filter((t) => t !== "null");
        if (types.includes("null")) schema["nullable"] = true;
        if (nonNull.length === 1) schema["type"] = nonNull[0];
        else if (nonNull.length > 1) schema["anyOf"] = nonNull.map((t) => ({ type: t }));
      }
    } else if (key === "const") {
      // Gemini has no `const`: express it as a single-value enum.
      schema["enum"] = [child];
    } else if (key === "properties" && isRecord(child)) {
      schema["properties"] = Object.fromEntries(Object.entries(child).map(([n, p]) => [n, sanitizeGeminiSchema(p)]));
    } else if (key === "items" && isRecord(child)) {
      schema["items"] = sanitizeGeminiSchema(child);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(child)) {
      schema["anyOf"] = child.map(sanitizeGeminiSchema);
    } else if (key === "required" && Array.isArray(child)) {
      schema["required"] = child.filter((n): n is string => typeof n === "string");
    } else {
      schema[key] = child;
    }
  }
  // Gemini rejects unknown `required` names and typeless arrays: prune the
  // former, and give ARRAY nodes without items an empty items schema.
  const properties = schema["properties"];
  if (Array.isArray(schema["required"]) && isRecord(properties)) {
    const known = new Set(Object.keys(properties));
    schema["required"] = (schema["required"] as string[]).filter((n) => known.has(n));
  }
  if (schema["type"] === "array" && schema["items"] === undefined) {
    schema["items"] = {};
  }
  return schema;
}

function toGeminiPart(
  part: CanonicalRequest["messages"][number]["content"][number],
  toolNames: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
  if (part.kind === "text") return [{ text: part.text }];
  if (part.kind === "reasoning") {
    const summary = part.summary ?? (typeof part.payload === "string" ? part.payload : "");
    return [{ text: summary, thought: true, ...(part.signature ? { thoughtSignature: part.signature } : {}) }];
  }
  if (part.kind === "image") {
    // Canonical image payload may be {url} or {source:{data,media_type}} or inlineData shape. Try to extract data uri.
    const payload = part.payload as Record<string, unknown>;
    if (payload && typeof payload["url"] === "string") {
      const url = payload["url"] as string;
      if (url.startsWith("data:")) {
        const m = /^data:([^;,]+);base64,(.*)$/.exec(url);
        if (m) return [{ inlineData: { mimeType: m[1], data: m[2] } }];
      }
      return [{ fileData: { fileUri: url, mimeType: "image/png" } }];
    }
    if (payload && payload["source"] && typeof payload["source"] === "object") {
      const src = payload["source"] as Record<string, unknown>;
      if (src["type"] === "base64" && typeof src["data"] === "string") return [{ inlineData: { mimeType: (src["media_type"] as string) ?? "image/png", data: src["data"] as string } }];
      if (src["type"] === "url" && typeof src["url"] === "string") return [{ fileData: { fileUri: src["url"] as string, mimeType: (src["media_type"] as string) ?? "image/png" } }];
    }
    // fallback inlineData with placeholder
    return [{ text: "[image]" }];
  }
  if (part.kind === "toolCall") {
    const args = typeof part.arguments === "string" ? parseJsonObject(part.arguments) : ((part.arguments as Record<string, unknown> | null) ?? {});
    return [{ functionCall: { name: part.name, args, ...(part.call_id ? { id: part.call_id } : {}) } }];
  }
  if (part.kind === "toolResult") {
    const name = toolNames.get(part.call_id) ?? part.call_id ?? "tool";
    const response = typeof part.content === "string" ? parseJsonObject(part.content) : parseJsonObject(JSON.stringify(part.content));
    return [{ functionResponse: { name, response, ...(part.call_id ? { id: part.call_id } : {}) } }];
  }
  return [];
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { content: value };
  } catch {
    return value.length > 0 ? { content: value } : {};
  }
}

export function buildGeminiPayload(request: CanonicalRequest): Record<string, unknown> {
  const systemParts: Array<{ text: string }> = [];
  const pushSystemText = (text: string): void => {
    if (!isClaudeBillingHeaderText(text)) systemParts.push({ text });
  };
  if (request.system) for (const p of request.system) if (p.kind === "text") pushSystemText(p.text);
  if (request.instructions) for (const p of request.instructions) if (p.kind === "text") pushSystemText(p.text);
  for (const m of request.messages) {
    if (m.role === "system" || m.role === "developer") {
      const t = m.content.filter((p) => p.kind === "text").map((p) => (p as Extract<typeof p, { kind: "text" }>).text).join("\n");
      if (t) pushSystemText(t);
    }
  }
  const toolNames = new Map<string, string>();
  for (const m of request.messages) for (const b of m.content) if (b.kind === "toolCall") toolNames.set(b.call_id, b.name);
  const contents = request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => {
      // Gemini roles: user or model (assistant -> model)
      const role = message.role === "assistant" ? "model" : message.role === "tool" ? "user" : "user";
      const parts = message.content.flatMap((block) => toGeminiPart(block, toolNames));
      return { role, parts: parts.length ? parts : [{ text: "" }] };
    });
  const payload: Record<string, unknown> = { contents };
  if (systemParts.length > 0) payload["systemInstruction"] = { role: "user", parts: systemParts };
  const functionTools = (request.tools ?? []).filter((t) => t.name);
  if (functionTools.length > 0) {
    payload["tools"] = [
      {
        functionDeclarations: functionTools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: sanitizeGeminiSchema(tool.jsonSchema),
        })),
      },
    ];
  }
  const generationConfig: Record<string, unknown> = {};
  const controls = request.generation_controls as Record<string, unknown>;
  const maxOut = controls["max_tokens"] ?? controls["max_output_tokens"] ?? controls["max_completion_tokens"];
  if (typeof maxOut === "number") generationConfig["maxOutputTokens"] = maxOut;
  if (request.reasoning?.budget_tokens !== undefined && request.reasoning.thinking_type !== "disabled") {
    generationConfig["thinkingConfig"] = { thinkingBudget: request.reasoning.budget_tokens };
  }
  // Thinking needs room to reason: floor maxOutputTokens from the thinking
  // budget/level so a narrow caller ceiling cannot silently truncate the
  // thinking trace into a 400 or a cut response.
  const thinkingFloor = geminiThinkingOutputFloor(request.reasoning);
  if (thinkingFloor !== undefined) {
    const current = generationConfig["maxOutputTokens"];
    if (typeof current !== "number" || current < thinkingFloor) {
      generationConfig["maxOutputTokens"] = thinkingFloor;
    }
  }
  if (Object.keys(generationConfig).length > 0) payload["generationConfig"] = generationConfig;
  return payload;
}
