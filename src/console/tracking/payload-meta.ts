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
