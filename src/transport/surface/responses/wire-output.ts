/**
 * Canonical → Responses wire projection: content parts and computer-call
 * outputs rendered back into provider-facing blocks.
 *
 * Lives beside `encode.ts` (its only production consumer) rather than in
 * `parse.ts`, so the inbound parser and the outbound projection stop sharing
 * a file they only happened to grow up in.
 */
import type { ContentPart } from "../../../protocol/canonical-model";
import { isRecord } from "../../../protocol/codecs";
import { resolveImageSource } from "../../../protocol/codecs";

export function computerOutputToWire(content: readonly ContentPart[] | string): Record<string, unknown> {
  if (typeof content === "string") return { type: "computer_screenshot", image_url: content };
  const image = content.find((part) => part.kind === "image");
  if (image !== undefined && image.kind === "image" && isRecord(image.payload)) {
    const output: Record<string, unknown> = { type: "computer_screenshot" };
    const imageUrl = image.payload["image_url"] ?? image.payload["url"];
    const fileId = image.payload["file_id"];
    const detail = image.payload["detail"];
    if (imageUrl !== undefined) output["image_url"] = imageUrl;
    if (fileId !== undefined) output["file_id"] = fileId;
    if (detail !== undefined) output["detail"] = detail;
    return output;
  }
  return { type: "computer_screenshot", image_url: outputToWire(content) };
}

function partToResponsesContent(part: ContentPart, contentType?: string): Record<string, unknown> | undefined {
  if (part.kind === "text") {
    const type = contentType === "output_text" ? "output_text" : "input_text";
    return { type, text: part.text };
  }
  if (part.kind === "image") {
    const source = resolveImageSource(part.payload);
    if (source?.url !== undefined) {
      return {
        type: "input_image",
        image_url: source.url,
        ...(source.detail === undefined ? {} : { detail: source.detail }),
      };
    }
    if (source?.fileId !== undefined) {
      return {
        type: "input_image",
        file_id: source.fileId,
        ...(source.detail === undefined ? {} : { detail: source.detail }),
      };
    }
    // Unrecognized source: preserve the origin payload rather than dropping bytes.
    return part.payload as Record<string, unknown>;
  }
  if (part.kind === "file") {
    const block: Record<string, unknown> = { type: "input_file" };
    if (part.file_id !== undefined) block.file_id = part.file_id;
    else if (
      part.url !== undefined &&
      (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
    )
      block.file_url = part.url;
    else if (part.data !== undefined) block.file_data = part.data;
    if (part.media_type !== undefined) block.mime_type = part.media_type;
    if (part.filename !== undefined) block.filename = part.filename;
    return block;
  }
  if (part.kind === "audio") {
    return { type: "input_audio", data: part.data, media_type: part.media_type };
  }
  if (part.kind === "document") {
    if (part.source_type === "text" && typeof part.data === "string")
      return { type: "input_text", text: part.data };
    const block: Record<string, unknown> = { type: "input_file", mime_type: part.media_type };
    if (part.file_id !== undefined) block.file_id = part.file_id;
    else if (
      part.url !== undefined &&
      (part.data === undefined || part.data === null || part.data === "" || part.data === part.url)
    )
      block.file_url = part.url;
    else if (part.data !== undefined) block.file_data = part.data;
    if (part.title !== undefined) block.filename = part.title;
    return block;
  }
  // reasoning / refusal / extension carry no message-input block;
  // reasoning is emitted as its own item upstream and the rest degrade away.
  return undefined;
}

export function outputToWire(content: readonly ContentPart[] | string): unknown {
  if (typeof content === "string") return content;
  return content
    .map((part) => partToResponsesContent(part))
    .filter((block): block is Record<string, unknown> => block !== undefined);
}
