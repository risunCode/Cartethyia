/**
 * Shared image-generation request and response helpers.
 *
 * `/v1/images/generations` arrives as an opaque `{prompt, size, …}` body.
 * Gemini, Antigravity, and Codex each speak a different upstream, but they
 * all start from the same prompt and all finish as OpenAI `b64_json` rows.
 * The provider adapters own auth and the envelope; this module owns the
 * parts that would otherwise be copied three times.
 */
import { GatewayError } from "./gateway-error";
import { isRecord } from "./codecs";

const OPENAI_ASPECT_RATIOS: Readonly<Record<string, string>> = {
  "1024x1024": "1:1",
  "1024x1792": "9:16",
  "1792x1024": "16:9",
  "1024x1536": "2:3",
  "1536x1024": "3:2",
};

/** Prompt text from an image body, accepting either `prompt` or a chat `messages` array. */
export function imagePrompt(body: Record<string, unknown>): string {
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) return body.prompt;
  if (!Array.isArray(body.messages)) {
    throw new GatewayError("invalid_request", 400, "prompt is required");
  }
  const texts: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role === "system" || message.role === "developer") continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim().length > 0) texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string" && part.trim().length > 0) texts.push(part);
      else if (isRecord(part) && typeof part.text === "string" && part.text.trim().length > 0) {
        texts.push(part.text);
      }
    }
  }
  const prompt = texts.join("\n").trim();
  if (prompt.length === 0) throw new GatewayError("invalid_request", 400, "prompt is required");
  return prompt;
}

/** Maps an OpenAI `size` (`1024x1024`) to a Gemini/Antigravity aspect ratio. */
export function imageAspectRatio(size: unknown): string | undefined {
  if (typeof size !== "string" || size.length === 0) return undefined;
  return OPENAI_ASPECT_RATIOS[size];
}

/**
 * Pulls generated image bytes out of a Gemini-family body.
 *
 * Antigravity streams the same candidate under `response`, so both the native
 * `generateContent` body and one SSE chunk are accepted. A part without bytes
 * is skipped; the caller decides whether zero images is a failure.
 */
export function geminiInlineImages(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const response = isRecord(body.response) ? body.response : body;
  const candidates = response.candidates;
  if (!Array.isArray(candidates)) return [];
  const images: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.inlineData)) continue;
      const data = part.inlineData.data;
      if (typeof data !== "string" || data.length === 0) continue;
      const mimeType = part.inlineData.mimeType;
      images.push({
        b64_json: data,
        ...(typeof mimeType === "string" && mimeType.length > 0 ? { mime_type: mimeType } : {}),
      });
    }
  }
  return images;
}

/**
 * Pulls a completed Responses `image_generation_call` result.
 *
 * Codex streams the finished bytes on `response.output_item.done` and repeats
 * them on `response.completed`. Either event is enough; partial frames are
 * ignored because they are not the image the caller asked to open.
 */
export function responsesImageResult(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const item = isRecord(event.item) ? event.item : undefined;
  if (isRecord(item) && item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
    return item.result;
  }
  const response = isRecord(event.response) ? event.response : event;
  const output = response.output;
  if (!Array.isArray(output)) return undefined;
  for (const entry of output) {
    if (
      isRecord(entry) &&
      entry.type === "image_generation_call" &&
      typeof entry.result === "string" &&
      entry.result.length > 0
    ) {
      return entry.result;
    }
  }
  return undefined;
}

/** Created timestamp in unix seconds, matching the [OI] image response. */
export function imageCreatedSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
