import { GatewayError } from "./gateway-error";

/**
 * Single shared SSE event decoder for all provider wire families.
 *
 * Replaces three hand-rolled line loops that each buffered unboundedly and
 * disagreed on the SSE spec: `factory.ts` `sseLines` (dropped `event:`
 * semantics, no bounds, no abort wiring), `claude/adapter.ts`
 * `parseClaudeSseStream` (correct join but unbounded + reader never
 * cancelled), and `codex/adapter.ts` (`await res.text()` + `split("\n")`,
 * defeating incremental decoding entirely).
 *
 * Semantics, per RFC 8895 / the WHATWG SSE fragment all three upstreams
 * actually emit:
 * - `event: <name>` sets the pending event name (preserved on the yielded
 *   event so Claude's `error`-event detection keeps working).
 * - `data: <text>` appends a data line; multiple lines join with `\n`.
 * - A blank line dispatches the pending event (only when it carries data —
 *   bare `event:` blocks with no `data:` yield nothing, matching the old
 *   Claude `flush()` early return).
 * - `:` comments (keepalives), `id:`, and `retry:` lines are ignored.
 * - Anything else is a malformed stream and throws 502 — the old factory
 *   silently skipped garbage lines while Claude threw; strict wins because
 *   a corrupt stream must never decode as valid deltas.
 */

export interface SseEvent {
  /** Value of the preceding `event:` line, or null for data-only events. */
  readonly event: string | null;
  /** Joined `data:` lines (without the `data:` prefixes). */
  readonly data: string;
}

export interface SseDecodeOptions {
  /**
   * Max UTF-16 length of a single line; default equals `maxEventBytes`.
   *
   * A `data:` line's content is always accumulated into `eventBytes`, so the
   * per-event cap is the real defense against unbounded memory growth. The
   * per-line cap only exists to bound the pre-newline buffer when a stream
   * has no line breaks at all; keeping it at the event cap avoids rejecting
   * legitimate providers (Responses `response.created` packs the full tool
   * schema — including every tool description — into a single JSON line).
   */
  readonly maxLineBytes?: number;
  /** Max accumulated `data:` length per event; default 4 MiB. */
  readonly maxEventBytes?: number;
  /** Aborting stops the stream promptly and cancels the reader. */
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_MAX_EVENT_BYTES = 4 * 1024 * 1024;

// A corrupt SSE stream is an upstream protocol failure, not a client mistake:
// labelling it `invalid_request` told the client its request was wrong and
// invited a retry of the identical request against a broken upstream. The
// `upstream` origin keeps the public envelope from prefixing it
// "Cartethyia Error:", which blamed the gateway for the provider's bytes.
function oversized(what: string): GatewayError {
  return new GatewayError("platform_unavailable", 502, `SSE ${what} exceeds size bound`, {}, "upstream");
}

export async function* decodeSseEvents(
  body: ReadableStream<Uint8Array> | null,
  opts: SseDecodeOptions = {},
): AsyncIterable<SseEvent> {
  if (body === null) throw new GatewayError("platform_unavailable", 502, "SSE response has no body", {}, "upstream");
  const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? maxEventBytes;
  const signal = opts.signal;
  if (signal?.aborted) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let eventBytes = 0;

  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  function* dispatchEvent(): Iterable<SseEvent> {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    const data = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = null;
    eventBytes = 0;
    yield { event: name, data };
  }

  function* emitLine(line: string): Iterable<SseEvent> {
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      const name = line.slice(6).trim();
      eventName = name.length > 0 ? name : null;
      return;
    }
    if (line.startsWith("data:")) {
      const piece = line.slice(5).trimStart();
      dataLines.push(piece);
      eventBytes += piece.length;
      if (eventBytes > maxEventBytes) throw oversized("event");
      return;
    }
    if (line.startsWith("id:") || line.startsWith("retry:")) return;
    if (line.trim() === "") {
      yield* dispatchEvent();
      return;
    }
    throw new GatewayError("platform_unavailable", 502, "Malformed SSE line", {}, "upstream");
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      if (!buffer.includes("\n") && buffer.length > maxLineBytes) throw oversized("line");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > maxLineBytes) throw oversized("line");
        yield* emitLine(line);
        newline = buffer.indexOf("\n");
      }
      if (chunk.done) break;
    }
    if (buffer.length > 0) {
      if (buffer.length > maxLineBytes) throw oversized("line");
      yield* emitLine(buffer);
    }
    yield* dispatchEvent();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // `onAbort` cancels the reader, and `cancel()` releases the lock itself —
    // an unconditional `releaseLock()` then throws ERR_INVALID_STATE, which
    // would replace whatever actually ended the stream (a 499 abort, a
    // provider error, a normal close). Release only while this reader still
    // holds the lock; a read can also still be pending, which throws too.
    try {
      if (body.locked) reader.releaseLock();
    } catch {
      // Already released by cancel(), or a pending read owns the lock.
    }
  }
}
