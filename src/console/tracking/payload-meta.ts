/**
 * Payload metadata — counts and hashes describing a request payload without
 * keeping its contents (used in TRACK_PAYLOADS=meta mode and as the base for
 * store mode).
 */

export interface PayloadMeta {
  messageCount: number;
  toolNames: string[];
  imageCount: number;
  bytes: number;
  sha256: string;
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function countImagesDeep(value: unknown): number {
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += countImagesDeep(item);
    return count;
  }
  const obj = asObj(value);
  if (!obj) return 0;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "image_url" || type === "image" || type === "input_image" || type === "tool_image") return 1;
  let count = 0;
  for (const key of Object.keys(obj)) count += countImagesDeep(obj[key]);
  return count;
}

function collectToolNames(value: unknown): string[] {
  const names = new Set<string>();
  const root = asObj(value);
  const tools = Array.isArray(root?.tools) ? root.tools : [];
  for (const tool of tools) {
    const t = asObj(tool);
    const fn = asObj(t?.function);
    const name = fn?.name ?? t?.name;
    if (typeof name === "string" && name) names.add(name);
  }
  return [...names];
}

function countMessages(surface: string, body: Record<string, unknown>): number {
  if (surface === "responses") return Array.isArray(body.input) ? body.input.length : 0;
  return Array.isArray(body.messages) ? body.messages.length : 0;
}

/** Flattens an OpenAI/Anthropic-shaped `content` (string or content-parts array) down to its text, ignoring images/tool payloads. */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = asObj(part);
      if (!p) return "";
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * A short, single-line preview of the *last user turn* — cheap enough to run
 * unconditionally for the console log tail (unlike the redacted payload copy
 * kept under TRACK_PAYLOADS, this never touches disk).
 */
export function extractLastUserMessagePreview(surface: string, body: unknown, maxLen = 60): string | undefined {
  const root = asObj(body);
  if (!root) return undefined;
  const list = surface === "responses" ? root.input : root.messages;
  if (!Array.isArray(list)) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = asObj(list[i]);
    if (!entry || entry.role !== "user") continue;
    const text = textFromContent(entry.content).trim().replace(/\s+/g, " ");
    if (!text) continue;
    return text.length > maxLen ? `${text.slice(0, maxLen)}\u2026` : text;
  }
  return undefined;
}

export function computePayloadMeta(surface: string, body: unknown): PayloadMeta {
  const root = asObj(body) ?? {};
  const json = (() => {
    try {
      return JSON.stringify(body ?? null);
    } catch {
      return "";
    }
  })();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(json);
  return {
    messageCount: countMessages(surface, root),
    toolNames: collectToolNames(body),
    imageCount: countImagesDeep(body),
    bytes: json.length,
    sha256: hasher.digest("hex"),
  };
}
