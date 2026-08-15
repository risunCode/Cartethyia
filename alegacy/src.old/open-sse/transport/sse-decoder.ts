import { sanitizeMessage, type RequestLimits } from "../../application/contracts";
import { runtimeMemoryLimits } from "../../traffic/limits";
import { AbortCoordinator } from "./abort-coordinator";
import { ProviderAdapterError } from "./errors";
import type { SseDecodeConfig, SseEvent } from "./contracts";

// ---------------------------------------------------------------- SSE decoding


export function lineLimit(limits: RequestLimits): number {
  return limits.maxBodyBytes > 0 ? Math.min(limits.maxBodyBytes, 1_048_576) : 65_536;
}

/**
 * Parses the `data` field of an SSE event into an unknown JSON value.
 * The OpenAI terminal sentinel `[DONE]` yields null; any other payload is
 * JSON-parsed. Invalid JSON throws a typed `ProviderAdapterError`.
 */
export function parseSseData(data: string): unknown {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Invalid JSON in stream event", retryable: false, routeScope: "provider" });
  }
}

function mapStreamAbortError(coordinator: AbortCoordinator, error: unknown): ProviderAdapterError {
  if (coordinator.signal.aborted) {
    if (coordinator.causeOf() === "caller") {
      return new ProviderAdapterError({ kind: "client_aborted", message: "Stream aborted by caller", retryable: false, routeScope: null });
    }
    return new ProviderAdapterError({ kind: "stream_timeout", message: "Upstream stream timed out", retryable: true, routeScope: "provider" });
  }
  return new ProviderAdapterError({ kind: "provider_protocol_error", message: sanitizeMessage(error), retryable: false, routeScope: "provider" });
}

/**
 * Decodes a text/event-stream body into discrete SSE events, enforcing the
 * max line byte bound, idle/total timeouts through the coordinator, and
 * caller-abort propagation. Always disposes the coordinator on exit.
 */
export async function* decodeSseEvents(config: SseDecodeConfig): AsyncGenerator<SseEvent> {
  const { body, coordinator } = config;
  const maxLineBytes = Math.min(config.maxLineBytes, runtimeMemoryLimits.streamLineBytes);
  const maxEventBytes = config.maxEventBytes ?? runtimeMemoryLimits.streamEventBytes;
  const reader = body.getReader();
  const textDecoder = new TextDecoder();
  const unsubscribe = coordinator.onAbort(() => {
    void reader.cancel().catch(() => {});
  });
  let buffer = "";
  let eventName: string | null = null;
  let eventBytes = 0;
  let dataLines: string[] = [];
  try {
    while (true) {
      if (config.idleTimeoutMs !== undefined && config.idleTimeoutMs > 0) coordinator.resetIdle();
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        throw mapStreamAbortError(coordinator, error);
      }
      if (chunk.done) {
        buffer += textDecoder.decode(); // flush any split UTF-8 tail at EOF
        break;
      }
      if (chunk.value) buffer += textDecoder.decode(chunk.value, { stream: true });
      // Bound COMPLETE lines one at a time; a chunk carrying many valid
      // short lines is fine â€” only an individual line is compared against
      // the cap, never the aggregate pending buffer.
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const lineByteLength = Buffer.byteLength(line);
        if (lineByteLength > maxLineBytes) {
          throw new ProviderAdapterError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
        }
        if (line.length === 0) {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            dataLines = [];
            const name = eventName;
            eventName = null;
            eventBytes = 0;
            if (data.length > 0) yield { event: name, data };
          } else {
            eventName = null;
            eventBytes = 0;
          }
        } else {
          eventBytes += lineByteLength + 1;
          if (eventBytes > maxEventBytes) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: `SSE event exceeds ${maxEventBytes} bytes`, routeScope: "provider" });
          if (line.startsWith(":")) {
            // SSE comment
          } else {
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") eventName = value;
            else if (field === "data") dataLines.push(value);
          }
        }
      }
      // Only the incomplete (newline-less) tail remains; a single line still
      // being assembled must not be allowed to grow past the cap, so it is
      // bounded after every chunk (and again at EOF below).
      if (Buffer.byteLength(buffer) > maxLineBytes) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
      }
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) {
      throw new ProviderAdapterError({ kind: "provider_protocol_error", message: `SSE line exceeds ${maxLineBytes} bytes`, routeScope: "provider" });
    }
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      if (data.length > 0) yield { event: eventName, data };
    }
  } finally {
    unsubscribe();
    try {
      await reader.cancel();
    } catch {
      // already closed or aborted
    }
    coordinator.dispose();
  }
}