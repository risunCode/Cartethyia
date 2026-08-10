import { isTerminalEvent, type StreamEvent } from "../../application/contracts";
import { ProviderAdapterError } from "./errors";
import { decodeSseEvents } from "./sse-decoder";
import type { SseDecodeConfig, StreamMapper } from "./contracts";


/**
 * Maps a decoded SSE stream into application StreamEvents via the protocol mapper,
 * failing typed (stream_truncated) when the stream ends without a terminal
 * event.
 */
export async function* mapSseStream(config: SseDecodeConfig, mapper: StreamMapper): AsyncGenerator<StreamEvent> {
  let terminal = false;
  for await (const sse of decodeSseEvents(config)) {
    const mapped = mapper(sse);
    if (mapped === null) continue;
    const events = Array.isArray(mapped) ? mapped : [mapped];
    for (const event of events) {
      yield event;
      if (isTerminalEvent(event)) terminal = true;
    }
  }
  if (!terminal) {
    throw new ProviderAdapterError({ kind: "stream_truncated", message: "Upstream stream ended before a terminal event", retryable: true, routeScope: "provider" });
  }
}