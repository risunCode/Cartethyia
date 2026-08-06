import type { ImageReference, NormalizedProviderRequest } from "../contracts";
import { classifyImageReference, isProtocolError, narrowArray, narrowNumber, narrowObject, narrowString, normalizeFail, normalizeOk, protocolError, pushImageReference, MAX_IMAGE_COUNT, MAX_MODEL_LENGTH, MAX_TEXT_BLOCK_LENGTH, type NormalizeInput, type NormalizeResult, type ProtocolError } from "../protocols";

/** Normalizes OpenAI Images API generation/edit JSON requests. */
export function normalizeImageRequest(body: unknown, input: NormalizeInput, operation: "generate" | "edit"): NormalizeResult {
  if (input.signal.aborted) return normalizeFail(protocolError("request", "request was aborted"));
  const root = narrowObject(body, "body");
  if (isProtocolError(root)) return normalizeFail(root);
  const model = narrowString(root.model, "model", MAX_MODEL_LENGTH);
  if (isProtocolError(model) || model.trim().length === 0) return normalizeFail(isProtocolError(model) ? model : protocolError("model", "model: must not be empty"));
  const prompt = narrowString(root.prompt, "prompt", MAX_TEXT_BLOCK_LENGTH);
  if (isProtocolError(prompt)) return normalizeFail(prompt);
  if (prompt.trim().length === 0) return normalizeFail(protocolError("prompt", "prompt: must not be empty"));
  const images: ImageReference[] = [];
  if (operation === "edit") {
    const rawImages = root.images ?? root.image;
    const list = rawImages === undefined ? [] : Array.isArray(rawImages) ? rawImages : [rawImages];
    if (list.length === 0) return normalizeFail(protocolError("image", "image: at least one input image is required"));
    const bounded = narrowArray(list, "image", MAX_IMAGE_COUNT);
    if (isProtocolError(bounded)) return normalizeFail(bounded);
    for (let index = 0; index < bounded.length; index += 1) {
      const value = bounded[index];
      const classification = classifyImageReference(value, `image[${index}]`);
      if (!classification.ok) return normalizeFail(classification.error);
      const bound = pushImageReference(images, classification.reference, `image[${index}]`);
      if (bound !== null) return normalizeFail(bound);
    }
  }
  return normalizeOk({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image" as const, image }))] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images,
    imageOperation: operation,
    sourceSurface: "images",
    signal: input.signal,
    limits: input.limits,
  } satisfies NormalizedProviderRequest);
}
