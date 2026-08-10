import { sanitizeMessage } from "../../application/contracts";
import { isRecord } from "../../application/protocols";
import { ProviderAdapterError } from "./errors";
import type { AbortCoordinator } from "./abort-coordinator";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const MAX_JSON_BODY_BYTES = 1_048_576;

/** Reads a non-stream JSON body under the bounded transport policy. */
export async function readJsonObject(response: Response, coordinator: AbortCoordinator): Promise<Record<string, unknown>> {
  try {
    const text = await readBoundedText(response.body, MAX_JSON_BODY_BYTES);
    if (text.length === 0) {
      throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty body", routeScope: "provider" });
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned a non-object JSON body", routeScope: "provider" });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    if (isAbortError(error)) {
      if (coordinator.causeOf() === "caller") {
        throw new ProviderAdapterError({ kind: "client_aborted", message: "Request aborted by caller", retryable: false, routeScope: null });
      }
      throw new ProviderAdapterError({ kind: "provider_unavailable", message: "Upstream response read timed out", retryable: true, routeScope: "provider" });
    }
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: sanitizeMessage(error), retryable: false, routeScope: "provider" });
  }
}

/** Reads a byte-bounded UTF-8 body and cancels the reader on exit. */
export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        result += decoder.decode();
        break;
      }
      if (!chunk.value || chunk.value.byteLength === 0) continue;
      const nextBytes = bytesRead + chunk.value.byteLength;
      if (nextBytes > maxBytes) {
        const permitted = maxBytes - bytesRead;
        if (permitted > 0) result += decoder.decode(chunk.value.subarray(0, permitted), { stream: true });
        break;
      }
      bytesRead = nextBytes;
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // body already closed or aborted
    }
  }
}
