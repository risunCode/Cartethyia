import type { PayloadCapture } from "../contracts";

export const MAX_CAPTURE_BYTES = 16 * 1024;
const REDACT_KEY = /(authorization|api[_-]?key|token|secret|password|cookie|credential)/i;
const REDACT_TEXT = /((?:authorization|x-api-key|api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie|credential)\s*[:=]\s*(?:Bearer\s+)?)[^,\s&}"']+/gi;
const REDACT_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function redactText(value: string): string {
  return value.replace(REDACT_TEXT, (_match, prefix: string) => `${prefix}[REDACTED]`).replace(REDACT_BEARER, "Bearer [REDACTED]");
}

function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = REDACT_KEY.test(key) ? "[REDACTED]" : redactPayload(item, depth + 1);
  return result;
}
function buildPayloadArtifact(value: unknown, truncated = false, originalBytes?: number): { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } {
  let text: string;
  if (typeof value === "string") {
    try { text = JSON.stringify(redactPayload(JSON.parse(value))) ?? redactText(value); } catch { text = redactText(value); }
  } else {
    text = JSON.stringify(redactPayload(value)) ?? redactText(String(value));
  }
  const bytes = encoder.encode(text);
  const original = originalBytes ?? bytes.byteLength;
  if (bytes.byteLength <= MAX_CAPTURE_BYTES) return { text, truncated, originalBytes: original, capturedBytes: bytes.byteLength };
  return { text: decoder.decode(bytes.slice(0, MAX_CAPTURE_BYTES)), truncated: true, originalBytes: original, capturedBytes: MAX_CAPTURE_BYTES };
}

export function createPayloadCapture(requestId: string, sink: { save(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }): void }): PayloadCapture {
  const pending = new Set<Promise<void>>();
  const save = (kind: "client_request" | "provider_request" | "provider_response" | "client_response", value: unknown, truncated = false, originalBytes?: number): void => {
    sink.save(requestId, kind, buildPayloadArtifact(value, truncated, originalBytes));
  };
  return {
    request(value): void { save("client_request", value); },
    response(value): void { save("client_response", value); },
    observeResponse(response): Response {
      if (response.body === null) return response;
      const [captureBranch, consumerBranch] = response.body.tee();
      const task = (async () => {
        const reader = captureBranch.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        try {
          while (total < MAX_CAPTURE_BYTES) {
            const next = await reader.read();
            if (next.done) break;
            const remaining = MAX_CAPTURE_BYTES - total;
            const chunk = next.value.slice(0, remaining);
            chunks.push(chunk);
            total += chunk.byteLength;
            if (next.value.byteLength > remaining) { truncated = true; break; }
          }
          if (truncated) await reader.cancel();
        } finally { reader.releaseLock(); }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        save("provider_response", decoder.decode(merged), truncated, truncated ? MAX_CAPTURE_BYTES + 1 : total);
      })();
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return new Response(consumerBranch, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    async settle(): Promise<void> { await Promise.all(pending); },
  };
}
