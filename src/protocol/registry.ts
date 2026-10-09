import type { CanonicalEvent, CanonicalRequest, WireFamily } from "./canonical-model";

export interface CodecContext {
  readonly isOAuth?: boolean;
  readonly sessionId?: string;
  readonly supportsPromptCaching?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * One loaded codec for a single wire family.
 *
 * A union rather than one shape: `messages` takes an options object while
 * `chat`/`responses` take a positional boolean, because those are the shapes the
 * codecs actually declare. Modelling it as a single signature forced a cast at
 * the call site, which hid the real difference instead of expressing it.
 */
type CodecModule =
  | {
      readonly family: "messages";
      readonly encodeWireRequest: (
        request: CanonicalRequest,
        options?: { isOAuth?: boolean },
      ) => Record<string, unknown>;
      readonly decodeWireResponse: (
        json: Record<string, unknown>,
        request: CanonicalRequest,
        isOAuth?: boolean,
      ) => readonly CanonicalEvent[];
      readonly decodeWireStream: (
        body: ReadableStream<Uint8Array>,
        signal?: AbortSignal,
        isOAuth?: boolean,
      ) => AsyncIterable<CanonicalEvent>;
    }
  | {
      readonly family: "chat" | "responses";
      readonly encodeWireRequest: (
        request: CanonicalRequest,
        supportsPromptCaching?: boolean,
      ) => Record<string, unknown>;
      readonly decodeWireResponse: (
        json: Record<string, unknown>,
        request: CanonicalRequest,
      ) => readonly CanonicalEvent[];
      readonly decodeWireStream: (
        body: ReadableStream<Uint8Array>,
        request: CanonicalRequest,
        signal?: AbortSignal,
      ) => AsyncIterable<CanonicalEvent>;
    };

/**
 * Loads the codec for one wire family, caching the module after the first load.
 *
 * Only one family is ever needed per gateway instance, so the other two stay
 * unloaded — each codec is ~10 MiB of module graph and loading all three
 * eagerly cost ~50 MiB of resident memory for no benefit.
 *
 * The dynamic import is awaited by the caller. Wire encoding happens before the
 * upstream request is issued, so the cost is paid once, on the first request,
 * and is subsequently free. `preloadCodecs()` warms it during boot to remove
 * even that first-request delay.
 */
const codecCache = new Map<WireFamily, Promise<CodecModule>>();

/**
 * Loads the codec for one wire family, caching the module after the first load.
 *
 * Dynamic import is required rather than a style choice: the specifier is
 * selected by the runtime `wireFamily` value, and a static import of all three
 * codecs is exactly the ~50 MiB of resident memory this indirection removes —
 * a gateway instance only ever serves one family.
 *
 * The cost is paid once, on the first request for that family, because wire
 * encoding happens before the upstream request is issued. `preloadCodec()`
 * warms it during boot so even that first-request delay disappears.
 */
async function loadCodec(wireFamily: WireFamily): Promise<CodecModule> {
  const cached = codecCache.get(wireFamily);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<CodecModule> => {
    switch (wireFamily) {
      case "chat":
        return (await import("./request/chat")).chatCodecModule;
      case "responses":
        return (await import("./request/responses")).responsesCodecModule;
      case "messages":
        return (await import("./request/messages")).messagesCodecModule;
      default:
        throw new Error(`unsupported wire family: ${wireFamily}`);
    }
  })();
  codecCache.set(wireFamily, promise);
  return promise;
}

/**
 * Warms the codec module for a wire family during boot so the first request
 * does not pay the dynamic-import cost. Safe to call concurrently; the cache
 * deduplicates.
 */
export function preloadCodec(wireFamily: WireFamily): Promise<void> {
  return loadCodec(wireFamily).then(() => undefined);
}

export async function encodeWireRequest(
  wireFamily: WireFamily,
  request: CanonicalRequest,
  context?: CodecContext,
): Promise<Record<string, unknown>> {
  const codec = await loadCodec(wireFamily);
  if (codec.family === "messages") {
    return codec.encodeWireRequest(request, {
      ...(context?.isOAuth === undefined ? {} : { isOAuth: context.isOAuth }),
    });
  }
  return codec.encodeWireRequest(request, context?.supportsPromptCaching !== false);
}

export async function decodeWireResponse(
  wireFamily: WireFamily,
  json: Record<string, unknown>,
  request: CanonicalRequest,
  context?: CodecContext,
): Promise<readonly CanonicalEvent[]> {
  const codec = await loadCodec(wireFamily);
  if (codec.family === "messages") {
    return codec.decodeWireResponse(json, request, context?.isOAuth ?? false);
  }
  return codec.decodeWireResponse(json, request);
}

export function decodeWireStream(
  wireFamily: WireFamily,
  body: ReadableStream<Uint8Array>,
  request: CanonicalRequest,
  context?: CodecContext,
): AsyncIterable<CanonicalEvent> {
  // A lazy async generator: the module is imported on first iteration, which
  // happens before the first byte is read, so no import cost lands inside the
  // streaming loop itself.
  async function* decode(): AsyncIterable<CanonicalEvent> {
    const codec = await loadCodec(wireFamily);
    if (codec.family === "messages") {
      // The Anthropic decoder does not take the canonical request: it rebuilds
      // its state from the SSE frames alone.
      yield* codec.decodeWireStream(body, context?.signal, context?.isOAuth ?? false);
      return;
    }
    yield* codec.decodeWireStream(body, request, context?.signal);
  }
  return decode();
}
