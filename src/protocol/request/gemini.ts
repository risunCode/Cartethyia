/**
 * Gemini `generateContent` request encoder: canonical → Gemini wire body
 * (contents/systemInstruction/tools/generationConfig) plus the model-URL and
 * schema-sanitization helpers shared with the Antigravity adapter.
 */
import type { CanonicalRequest } from "../../transport/canonical-model";
import {
  descend,
  isClaudeBillingHeaderText,
  isRecord,
  resolveImageSource,
  ROOT_WALK,
  shouldStop,
  splitDataUrl,
  type RewriteWalk,
} from "../primitives";
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
  return sanitizeGeminiWalk(value, ROOT_WALK);
}

function sanitizeGeminiWalk(value: unknown, walk: RewriteWalk): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (shouldStop(walk, value)) return value;
  const inner = descend(walk, value);
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
      schema["properties"] = Object.fromEntries(
        Object.entries(child).map(([n, p]) => [n, sanitizeGeminiWalk(p, inner)]),
      );
    } else if (key === "items" && isRecord(child)) {
      schema["items"] = sanitizeGeminiWalk(child, inner);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(child)) {
      schema["anyOf"] = child.map((entry) => sanitizeGeminiWalk(entry, inner));
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

/**
 * Encodes a canonical non-image attachment (`file` / `document`) onto the
 * Gemini wire.
 *
 * Gemini takes attachment bytes as `inlineData` (`Blob`) and a reference as
 * `fileData` (`FileData`), so the transport is read from the part instead of
 * guessed:
 * - a Files API id names a file in the *originating* provider's store and has
 *   no Gemini equivalent, so it degrades to a text reference rather than a
 *   `fileUri` this upstream cannot resolve;
 * - a `data:` URL carries its own bytes and is split into `inlineData`;
 * - any other URL stays a reference;
 * - inline `data` is base64 bytes under the part's declared media type.
 */
function geminiMediaPart(part: {
  readonly data: unknown;
  readonly media_type: string;
  readonly file_id?: string | undefined;
  readonly url?: string | undefined;
  readonly source_type?: string | undefined;
}): Record<string, unknown>[] {
  // An Anthropic `text` document source is prose, and Gemini has no document
  // wrapper for prose: it belongs in a plain text part.
  if (part.source_type === "text" && typeof part.data === "string") {
    return [{ text: part.data }];
  }
  // No `source_type === "url"` arm: it would be both redundant and wrong. The
  // surface parsers always set `url` alongside that discriminator, so the
  // reference guard below already covers it — and short-circuiting here would
  // hand a `data:` URI straight to `fileData.fileUri`, the very bug this
  // projection exists to prevent.
  if (part.file_id !== undefined) {
    return [{ text: `[file: ${part.file_id}]` }];
  }
  const candidate = typeof part.data === "string" && part.data.length > 0 ? part.data : part.url;
  if (candidate === undefined) return [{ text: "[file: unsupported source]" }];
  const split = splitDataUrl(candidate);
  if (split !== undefined) {
    return [{ inlineData: { mimeType: split.mediaType, data: split.data } }];
  }
  // A part carrying no bytes holds its URL in `data` (see the surface parsers),
  // so a declared `url` source — or any `http(s)` value — is a reference. The
  // media type is omitted here: `file` parts default it to
  // `application/octet-stream` when the origin declared none, and forwarding
  // that guess as a content type would mislabel the file to the upstream.
  if (part.url !== undefined || /^https?:\/\//i.test(candidate)) {
    return [{ fileData: { fileUri: candidate } }];
  }
  return [{ inlineData: { mimeType: part.media_type, data: candidate } }];
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
    // Resolution goes through the shared `resolveImageSource` primitive rather
    // than a local re-implementation: a Chat/Responses-origin payload is an
    // opaque object this encoder must project, and every arm it failed to
    // recognise here degraded to a text placeholder while the request still
    // succeeded — the attachment was simply lost.
    const source = resolveImageSource(part.payload);
    if (source === undefined) return [{ text: "[image: unsupported source]" }];
    if (source.url !== undefined) {
      const split = splitDataUrl(source.url);
      // Bytes inline: Gemini carries them as `inlineData`. The media type comes
      // from the data URL itself, because that is the caller's own declaration.
      if (split !== undefined) {
        return [{ inlineData: { mimeType: split.mediaType, data: split.data } }];
      }
      // A URL is a reference, so it stays a reference. `mimeType` is omitted
      // rather than guessed: the origin declared no media type, and a
      // hardcoded `image/png` would mislabel a JPEG as a wire lie the upstream
      // has no way to detect. Gemini's `FileData.mimeType` is optional.
      return [{ fileData: { fileUri: source.url } }];
    }
    if (source.fileId !== undefined) {
      // A Files API id names a file in the *originating* provider's store; it
      // is not a Gemini file URI and cannot be fetched by this upstream. Naming
      // it keeps the attachment visible to the model instead of dropping it.
      return [{ text: `[image: ${source.fileId}]` }];
    }
    // Fail-closed, and deliberately kept. `resolveImageSource` documents that a
    // defined result carries a URL or a file id, so no input reaches this arm
    // today — a mutation that replaces it with a bare `[image]` placeholder
    // fails no test, which is how that was confirmed. It stays because the
    // resolver's type permits a result carrying neither, and the alternative to
    // a visible placeholder is an undefined part in `parts` that the provider
    // rejects, taking the caller's text with it. Do not delete this as dead
    // code: deleting it moves the failure from "attachment named" to
    // "request rejected".
    return [{ text: "[image: unsupported source]" }];
  }
  if (part.kind === "file" || part.kind === "document") {
    // Gemini accepts non-image payloads as inline bytes (`application/pdf`,
    // `audio/*`, `text/*`) or as a file URI. There was no arm for either kind,
    // so a document the capability layer had already granted this route was
    // dropped here without an error.
    return geminiMediaPart(part);
  }
  if (part.kind === "audio") {
    if (typeof part.data !== "string" || part.data.length === 0) {
      return [{ text: "[audio: unsupported source]" }];
    }
    const split = splitDataUrl(part.data);
    return [
      {
        inlineData: {
          mimeType: split?.mediaType ?? part.media_type,
          data: split?.data ?? part.data,
        },
      },
    ];
  }
  if (part.kind === "toolCall") {
    const args = typeof part.arguments === "string" ? parseJsonObject(part.arguments) : ((part.arguments as Record<string, unknown> | null) ?? {});
    return [{ functionCall: { name: part.name, args, ...(part.call_id ? { id: part.call_id } : {}) } }];
  }
  if (part.kind === "toolResult") {
    const name = toolNames.get(part.call_id) ?? part.call_id ?? "tool";
    // Gemini's functionResponse accepts a JSON object. Canonical tool content
    // is either text or a ContentPart array; the existing parser wraps an array's
    // JSON text in `{ content }`, so preserve that wire shape without parsing a
    // just-stringified array back into a value that will be rejected as non-record.
    const response =
      typeof part.content === "string"
        ? parseJsonObject(part.content)
        : { content: JSON.stringify(part.content) };
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
