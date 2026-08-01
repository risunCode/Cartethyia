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

import { ProviderCallError, providerHttpError, safeReadText } from "./index";
import type { ProviderResult } from "./index";
import type { StreamEvent } from "../bridge";

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
  const res = await doFetch(opts.url, {
    method: opts.method ?? "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  } as RequestInit);

  if (!res.ok) throw providerHttpError(res.status, opts.providerLabel, undefined, await safeReadText(res));
  if (!res.body) throw new ProviderCallError(502, "unavailable", `${opts.providerLabel} returned an empty response body.`);

  if (opts.isStreaming) return { type: "stream", events: opts.decodeStream(res.body) };

  const jsonBody: unknown = await res.json();
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
