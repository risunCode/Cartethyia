/**
 * Shared fetch+decode skeleton for "simple" providers: POST a JSON body,
 * classify failure via `providerHttpError`, then hand back either a decoded
 * event stream or a parsed (optionally translated) JSON body.
 *
 * Only providers whose non-streaming path is a plain `res.json()` fit this
 * shape. A provider that must materialize a stream into a response even for
 * non-streaming calls (Command Code's NDJSON transport, Devin's connect
 * protocol) does NOT fit and keeps its own hand-rolled `call()`.
 */

import { ProviderCallError, providerHttpError, safeReadText } from "./errors";
import type { ProviderResult } from "./types";
import type { StreamEvent } from "../bridge";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

/**
 * Decompresses a body according to a content-encoding header. Returns a
 * Buffer/Uint8Array of decoded bytes, or null if no decoding needed.
 * Handles the encodings a relay proxy commonly passes through (br/gzip/deflate).
 */
function decodeBodyEncoding(input: ArrayBuffer | Uint8Array, encoding: string): Uint8Array | null {
  if (!encoding) return null;
  const buf = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(input as ArrayBuffer);
  try {
    if (encoding.includes("gzip") || encoding === "x-gzip") return new Uint8Array(gunzipSync(buf));
    if (encoding.includes("br")) return new Uint8Array(brotliDecompressSync(buf));
    if (encoding.includes("deflate")) {
      // raw deflate may lack the zlib wrapper — try both
      try {
        return new Uint8Array(inflateSync(buf));
      } catch {
        return new Uint8Array(inflateSync(buf, { flush: 0 }));
      }
    }
  } catch {
    // decompression failed — return null so caller uses original bytes (best effort)
  }
  return new Uint8Array(buf);
}

export interface SimpleProviderCallOptions {
  url: string;
  method?: string;
  headers: Record<string, string>;
  /** Already-transformed outbound request body (e.g. through translateChatRequestToAnthropic); JSON-stringified as-is. */
  body: unknown;
  signal: AbortSignal;
  /** Display name used in error messages ("Anthropic", `Custom provider "X"`). */
  providerLabel: string;
  isStreaming: boolean;
  decodeStream: (body: ReadableStream<Uint8Array>) => AsyncGenerator<StreamEvent>;
  /** Post-processes the parsed non-streaming JSON body (e.g. Anthropic response -> Chat response translation). Identity if omitted. */
  translateJson?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** Defaults to the global `fetch`; pass `fetchWithSsrfGuard` for user-configured upstream URLs. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

export async function callSimpleProvider(opts: SimpleProviderCallOptions): Promise<ProviderResult> {
  const doFetch = opts.fetcher ?? fetch;
  let res = await doFetch(opts.url, {
    method: opts.method ?? "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  } as RequestInit);

  if (!res.ok) throw providerHttpError(res.status, opts.providerLabel, undefined, await safeReadText(res));

  // Some gateways (AgentRouter) advertise content-encoding: br/gzip but the
  // response passes through a relay proxy that does NOT auto-decompress, so
  // res.json()/res.text() would see compressed bytes → "invalid JSON". Strip
  // the encoding here by decompressing manually so we always parse JSON.
  let contentEncoding = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (contentEncoding) {
    // Bun/node fetch auto-decompress for `gzip`/`deflate` on direct fetch,
    // but a proxied response may carry the header without being decoded.
    // We rebuild a Response from decoded bytes (or the compressed buffer).
    const raw = await res.arrayBuffer();
    const decoded = await decodeBodyEncoding(raw, contentEncoding);
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    const full = new Response(decoded ? new Uint8Array(decoded) : raw, { status: res.status, headers });
    res = full as Response;
  }

  if (!res.ok) throw providerHttpError(res.status, opts.providerLabel, undefined, await safeReadText(res));
  if (!res.body) throw new ProviderCallError(502, "unavailable", `${opts.providerLabel} returned an empty response body.`);

  if (opts.isStreaming) return { type: "stream", events: opts.decodeStream(res.body) };

  let jsonBody: unknown;
  try {
    // Bun's Response.json() is strict about content-type — some gateways
    // (AgentRouter) return JSON bodies with `text/plain`, which makes
    // res.json() throw even though the body parses fine. Fall back to
    // explicit JSON.parse on the raw text so a valid JSON payload with an
    // unusual content-type is still honored.
    jsonBody = await res.json();
  } catch {
    try {
      const rawText = await res.text();
      jsonBody = rawText ? JSON.parse(rawText) : null;
    } catch {
      jsonBody = undefined;
    }
  }
  if (jsonBody === undefined) {
    // A truncated gateway response commonly surfaces as Bun's bare
    // "Failed to parse JSON" SyntaxError. Give dispatch a typed 502 so it
    // retries the transient upstream failure instead of stopping at once.
    throw new ProviderCallError(502, "malformed_response", `${opts.providerLabel} returned invalid JSON.`);
  }
  if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
    throw new ProviderCallError(502, "malformed_response", `${opts.providerLabel} returned an unreadable JSON response.`);
  }
  const parsed = jsonBody as Record<string, unknown>;
  return { type: "json", body: opts.translateJson ? opts.translateJson(parsed) : parsed };
}

// ── Materializing provider skeleton ────────────────────────────────────────
//
// For providers whose upstream protocol is streaming-only (Command Code,
// Devin, Qoder): every response is a decoded stream. Non-streaming callers
// get it materialized into a Chat response. Shares the fetch/check/error
// pattern with callSimpleProvider; the decode+materialize tail is the
// differentiator.

export interface MaterializingProviderCallOptions {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  providerLabel: string;
  /** The stream is ALWAYS decoded; this field determines whether to return it raw or materialize. */
  isStreaming: boolean;
  /** Provider-specific stream decoder (e.g. `decodeCommandCodeNdjsonStream`, `decodeDevinChatStream`). */
  decodeStream: (body: ReadableStream<Uint8Array>) => AsyncGenerator<StreamEvent>;
  /** Model name embedded into the materialized Chat response. */
  model: string;
  /** Defaults to the global `fetch`. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

export async function callMaterializingProvider<M>(
  opts: MaterializingProviderCallOptions,
  materialize: (events: AsyncGenerator<StreamEvent>) => Promise<M>,
  toResponse: (result: M, model: string) => unknown,
): Promise<ProviderResult> {
  const doFetch = opts.fetcher ?? fetch;
  const res = await doFetch(opts.url, {
    method: opts.method ?? "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  } as RequestInit);

  if (!res.ok) throw providerHttpError(res.status, opts.providerLabel, undefined, await safeReadText(res));
  if (!res.body) throw new ProviderCallError(502, "unavailable", `${opts.providerLabel} returned an empty response body.`);

  const events = opts.decodeStream(res.body);
  if (opts.isStreaming) return { type: "stream", events };

  const materialized = await materialize(events);
  return { type: "json", body: toResponse(materialized, opts.model) as Record<string, unknown> };
}
