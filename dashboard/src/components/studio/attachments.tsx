import type { StudioAttachment } from "../../lib/contracts";

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const AUDIO_MIMES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"];
export const ACCEPT_STRING = [...IMAGE_MIMES, "application/pdf", ...AUDIO_MIMES].join(",");
export const MAX_ATTACH_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;

export function kindForMime(mime: string): StudioAttachment["kind"] | null {
  if (mime === "application/pdf") return "file";
  if (IMAGE_MIMES.includes(mime)) return "image";
  if (AUDIO_MIMES.includes(mime)) return "audio";
  return null;
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("unreadable"));
    };
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(file);
  });
}

/** Downscales pasted screenshots and normalizes webp → jpeg so every vision wire can decode it. */
export function downscaleImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const needsTranscode = dataUrl.startsWith("data:image/webp");
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.naturalWidth, img.naturalHeight);
        const mustDownscale = longest > 1568 && longest !== 0;
        if (!mustDownscale && !needsTranscode) {
          resolve(dataUrl);
          return;
        }
        const scale = mustDownscale ? 1568 / longest : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function autoTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= 42 ? flat : `${flat.slice(0, 42)}…`;
}

/** OpenAI `input_audio` only speaks wav/mp3; everything else rides as mp3. */
function audioFormatFor(mime: string): string {
  return /wav|wave|x-wav/.test(mime) ? "wav" : "mp3";
}

export function attachmentToWirePart(attachment: StudioAttachment): Record<string, unknown> | null {
  if (attachment.kind === "image") {
    return { type: "image_url", image_url: { url: attachment.dataUrl } };
  }
  const base64 = attachment.dataUrl.split(",", 2)[1] ?? "";
  if (base64.length === 0) return null;
  if (attachment.kind === "audio") {
    return {
      type: "input_audio",
      input_audio: { data: base64, format: audioFormatFor(attachment.mime) },
    };
  }
  return {
    type: "file",
    file: { file_data: base64, filename: attachment.name, mime_type: attachment.mime },
  };
}
