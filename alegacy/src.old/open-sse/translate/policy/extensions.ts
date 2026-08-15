import type { ProxyRequest, Surface } from "../../../application/contracts";
import { isRecord } from "../../../application/protocols";

const ALLOWED_EXTENSIONS: Readonly<Record<Surface, readonly string[]>> = {
  "openai-chat": ["store", "user", "service_tier", "safety_identifier"],
  "openai-responses": ["store", "background", "truncation", "service_tier", "safety_identifier", "additional_tools"],
  "anthropic-messages": ["service_tier", "context_management"],
  images: [],
  "web-search": [],
};

/** Preserves bounded canonical fields and explicitly registered same-surface extensions. */
export function preserveWireExtensions(payload: Record<string, unknown>, request: ProxyRequest, targetSurface: Surface, canonicalFields: readonly string[]): void {
  if (request.sourceSurface !== targetSurface || request.wirePayload === undefined) return;
  for (const field of canonicalFields) {
    const value = request.wirePayload[field];
    if (value !== undefined && isSafeExtension(value)) payload[field] = value;
  }
  for (const field of ALLOWED_EXTENSIONS[targetSurface]) {
    if (canonicalFields.includes(field)) continue;
    const value = request.wirePayload[field];
    if (value !== undefined && isSafeExtension(value)) payload[field] = value;
  }
}

function isSafeExtension(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 8_192;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 128 && value.every(isSafeExtension);
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, child]) => key.length <= 128 && isSafeExtension(child));
}
