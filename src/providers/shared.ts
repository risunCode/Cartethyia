import type { ApplicationErrorKind, ProviderCallError } from "../domain/contracts";
import { boundedRetryAt, deriveErrorSource, sanitizeMessage } from "../domain/contracts";
import { isUsageLimitOutcome, parseRateLimitReason } from "../domain/rate-limit";
import type { ContextStats, Adapter, ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog, ProviderOutput, ProviderRequest, Surface, RouteTarget, TokenCountInput } from "../domain/contracts";
import type { CredentialKind } from "../domain/contracts";
import type { ModelCapabilityCategory, ModelContextLimits, ModelTokenPricing } from "../domain/contracts";
import type { NetworkSelection } from "../domain/contracts";
import type { NormalizedMessage, RequestLimits } from "../domain/contracts";
import { isTerminalEvent, type StreamEvent } from "../domain/contracts";
import { runtimeMemoryLimits } from "../traffic/limits";
import { buildProxyFetcher } from "../traffic";
import { ProtocolCodecError } from "../open-sse/translate/errors";
import { fetchWithRedirectPolicy } from "../security/redirect-policy";
import { assertPublicUrlAtDispatch } from "../security/ssrf-guard";
import { callChatCompletionsWire, callResponsesWire } from "../transport/protocols/openai";

/**
 * Shared provider-adapter infrastructure: typed errors, abort coordination
 * (connect/total/idle timeouts composed with the caller's AbortSignal), SSE
 * decoding, upstream error mapping, capability/model catalog helpers, and the
 * ProviderAdapter registry.
 *
 * The adapter classes in this slice are intentionally NOT statically imported
 * here; `createDefaultRegistry` composes them through dynamic imports so there
 * is no import cycle between this module and the adapters.
 */

// ---------------------------------------------------------------- guards

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function messageText(message: NormalizedMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// ---------------------------------------------------------------- typed errors

export interface ProviderAdapterErrorOptions {
  readonly kind: ApplicationErrorKind;
  readonly message: string;
  readonly statusCode?: number | null;
  readonly retryable?: boolean;
  readonly routeScope?: "account" | "proxy" | "provider" | null;
  readonly retryAt?: string | null;
}

/**
 * Typed failure for adapter-level problems (unsupported surfaces, protocol
 * violations, upstream HTTP statuses, timeouts). Always convertible to the
 * application ProviderCallError shape via {@link toProviderCallError}.
 */
export class ProviderAdapterError extends Error {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly routeScope: "account" | "proxy" | "provider" | null;
  readonly retryAt: string | null;

  constructor(options: ProviderAdapterErrorOptions) {
    super(options.message);
    this.name = "ProviderAdapterError";
    this.kind = options.kind;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? false;
    this.routeScope = options.routeScope ?? "provider";
    this.retryAt = options.retryAt ?? null;
  }

  toProviderCallError(): ProviderCallError {
    return {
      statusCode: this.statusCode,
      kind: this.kind,
      retryable: this.retryable,
      routeScope: this.routeScope,
      source: deriveErrorSource(this.kind, this.routeScope),
      sanitizedMessage: sanitizeMessage(this.message),
      retryAt: this.retryAt,
    };
  }
}

const MAX_RETRY_AFTER_DELAY_MS = 30_000;

function mapUpstreamError(statusCode: number, message: string, retryAfterSeconds: number | null, errorKind: string | null): ProviderAdapterError {
  const retryAt = boundedRetryAt(retryAfterSeconds, Date.now(), MAX_RETRY_AFTER_DELAY_MS);
  switch (statusCode) {
    case 400:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 401:
      return new ProviderAdapterError({ kind: "authentication_failed", message, statusCode, routeScope: "account" });
    case 402:
      // Payment Required: account-local billing cap (xAI Grok Build balance,
      // DeepSeek insufficient balance, OpenRouter credit exhaustion). Rotate
      // to a sibling credential — this is never a transient blip.
      return new ProviderAdapterError({ kind: "quota_exceeded", message, statusCode, retryable: true, routeScope: "account" });
    case 403:
      return new ProviderAdapterError({ kind: "authorization_denied", message, statusCode, routeScope: "account" });
    case 404:
      return new ProviderAdapterError({ kind: "model_not_found", message, statusCode, routeScope: "provider" });
    case 407:
      // The outbound proxy rejected the request (RFC 9110 Proxy-Authentication
      // Required): the proxy route itself is the fault, so the failure is
      // retryable and scoped to the proxy â€” health recording then penalizes
      // the proxy, not the provider or account.
      return new ProviderAdapterError({ kind: "network_unavailable", message, statusCode, retryable: true, routeScope: "proxy" });
    case 408:
      return new ProviderAdapterError({ kind: "provider_unavailable", message, statusCode, retryable: true, routeScope: "provider" });
    case 409:
      return new ProviderAdapterError({ kind: "concurrency_exceeded", message, statusCode, retryable: true, routeScope: "provider" });
    case 413:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 422:
      return new ProviderAdapterError({ kind: "invalid_request", message, statusCode, routeScope: "provider" });
    case 429: {
      const reason = parseRateLimitReason(message);
      const quotaHint = reason === "QUOTA_EXHAUSTED" || isUsageLimitOutcome(statusCode, message);
      return new ProviderAdapterError({
        kind: quotaHint ? "quota_exceeded" : "provider_rate_limited",
        message,
        statusCode,
        retryable: true,
        routeScope: "account",
        retryAt,
      });
    }
    default:
      if (statusCode >= 500) {
        return new ProviderAdapterError({ kind: "provider_unavailable", message, statusCode, retryable: true, routeScope: "provider", retryAt });
      }
      return new ProviderAdapterError({ kind: "provider_protocol_error", message, statusCode, routeScope: "provider" });
  }
}

/**
 * Bounded, retryability-aware mapping of any thrown value into the application
 * ProviderCallError shape. Used by every adapter's `mapError`.
 */
export function toProviderCallError(error: unknown): ProviderCallError {
  if (error instanceof ProviderAdapterError) return error.toProviderCallError();
  if (error instanceof ProtocolCodecError) return error.toProviderCallError(sanitizeMessage(error));
  if (isAbortError(error)) {
    return { statusCode: null, kind: "client_aborted", retryable: false, routeScope: null, source: "client", sanitizedMessage: "Request aborted", retryAt: null };
  }
  if (error instanceof TypeError) {
    return { statusCode: null, kind: "network_unavailable", retryable: true, routeScope: "proxy", source: "upstream", sanitizedMessage: sanitizeMessage(error), retryAt: null };
  }
  // E8: narrow the catch-all. ReferenceError/SyntaxError are internal bugs,
  // not upstream protocol errors — classify them as internal so debugging
  // doesn't chase a phantom provider issue.
  if (error instanceof ReferenceError || error instanceof SyntaxError) {
    return { statusCode: null, kind: "internal_error", retryable: false, routeScope: null, source: "internal", sanitizedMessage: sanitizeMessage(error), retryAt: null };
  }
  return { statusCode: null, kind: "provider_protocol_error", retryable: false, routeScope: "provider", source: "upstream", sanitizedMessage: sanitizeMessage(error), retryAt: null };
}

// ---------------------------------------------------------------- abort coordination

export type AbortCause = "caller" | "connect_timeout" | "total_timeout" | "idle_timeout";

export interface AbortCoordinatorOptions {
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Combines a caller AbortSignal with optional connect/total/idle timers.
 * Every abort is attributed to a cause so callers can map it to a typed
 * error (client_aborted vs network_unavailable vs stream_timeout).
 */
export class AbortCoordinator {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private cause: AbortCause = "caller";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(caller: AbortSignal, options: AbortCoordinatorOptions = {}) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    const onCallerAbort = () => this.fail("caller");
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
      this.cleanups.push(() => caller.removeEventListener("abort", onCallerAbort));
    }
    if ((options.connectTimeoutMs ?? 0) > 0) {
      this.connectTimer = setTimeout(() => this.fail("connect_timeout"), options.connectTimeoutMs);
    }
    if ((options.totalTimeoutMs ?? 0) > 0) {
      this.totalTimer = setTimeout(() => this.fail("total_timeout"), options.totalTimeoutMs);
    }
  }

  /** Call once the response headers arrived; stops the connect timer. */
  markHeadersReceived(): void {
    this.clearTimer("connect");
  }

  /** Re-arms the idle timer (call once per received stream chunk). */
  resetIdle(): void {
    this.clearTimer("idle");
    if (this.idleTimeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.idleTimer = setTimeout(() => this.fail("idle_timeout"), this.idleTimeoutMs);
    }
  }

  /** Invoke `callback` when the coordinator aborts; returns an unsubscribe. */
  onAbort(callback: () => void): () => void {
    if (this.controller.signal.aborted) {
      callback();
      return () => {};
    }
    this.controller.signal.addEventListener("abort", callback, { once: true });
    return () => this.controller.signal.removeEventListener("abort", callback);
  }

  causeOf(): AbortCause {
    return this.cause;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllTimers();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  private fail(cause: AbortCause): void {
    if (this.disposed || this.controller.signal.aborted) return;
    this.cause = cause;
    this.clearAllTimers();
    this.controller.abort();
  }

  private clearAllTimers(): void {
    this.clearTimer("connect");
    this.clearTimer("total");
    this.clearTimer("idle");
  }

  private clearTimer(which: "connect" | "total" | "idle"): void {
    const key = which === "connect" ? "connectTimer" : which === "total" ? "totalTimer" : "idleTimer";
    const timer = this[key];
    if (timer !== null) {
      clearTimeout(timer);
      this[key] = null;
    }
  }
}

// ---------------------------------------------------------------- HTTP plumbing

/**
 * Executes a real fetch bound to the coordinator signal. Connect-phase
 * timeouts surface as network_unavailable (routeScope "proxy"); caller
 * aborts as client_aborted; transport failures as network_unavailable.
 */


export async function executeFetch(url: string, init: RequestInit, coordinator: AbortCoordinator, network?: NetworkSelection): Promise<Response> {
  try {
    const requestInit = { ...init, signal: coordinator.signal };
    // Direct (non-proxied) fetches follow redirects manually so every redirect
    // hop is re-validated through the SSRF guard — a safe initial URL must not
    // be able to redirect to a private/internal target. The initial URL is
    // already validated at the application layer (custom providers) or is a
    // trusted hardcoded constant (built-in providers), so the validator only
    // checks redirect targets, not the first hop. The proxy path tunnels
    // through the SOCKS5/HTTP relay, where the proxy egress (not local DNS)
    // resolves redirect targets, so it keeps native redirect handling.
    let firstHop = true;
    const response = network?.url === null || network?.url === undefined
      ? await fetchWithRedirectPolicy(url, requestInit, {
          validator: (target) => {
            if (firstHop) {
              firstHop = false;
              return;
            }
            return assertPublicUrlAtDispatch(target, { label: "upstream redirect target" }).then(() => {});
          },
        })
      : await buildProxyFetcher({ url: network.url, isRelay: network.isRelay })(url, requestInit);
    coordinator.markHeadersReceived();
    return response;
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    if (isAbortError(error)) {
      if (coordinator.causeOf() === "caller") {
        throw new ProviderAdapterError({ kind: "client_aborted", message: "Request aborted by caller", retryable: false, routeScope: null });
      }
      throw new ProviderAdapterError({ kind: "network_unavailable", message: "Upstream connection timed out", retryable: true, routeScope: "proxy" });
    }
    throw new ProviderAdapterError({ kind: "network_unavailable", message: sanitizeMessage(error), retryable: true, routeScope: "proxy" });
  }
}

/** Maximum bytes accepted when reading a non-stream JSON body. Prevents a
 * malicious/buggy upstream from streaming an arbitrarily large "JSON" body
 * into memory. Matches the error-body cap. */
const MAX_JSON_BODY_BYTES = 1_048_576;

/**
 * Reads a non-stream JSON body under the coordinator's total timeout, capped
 * at {@link MAX_JSON_BODY_BYTES} bytes. Timeouts map to provider_unavailable;
 * parse failures to provider_protocol_error; oversize bodies to
 * provider_protocol_error as well (a well-behaved upstream never sends a
 * >1 MiB JSON object body).
 */
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

const MAX_ERROR_BODY_BYTES = 16_384;

/**
 * Reads at most `maxBytes` BYTES of an error body and decodes them as UTF-8
 * (previously the cap was checked against JS string length, which under-
 * counts multi-byte characters). The decoder is flushed at EOF so a UTF-8
 * sequence split across chunk boundaries is recovered instead of dropped.
 * When the stream exceeds the limit the output is truncated at the last
 * complete character boundary â€” the oversized read stays a diagnostic
 * truncation (as before), never a protocol/parse failure.
 */
async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        result += decoder.decode(); // flush pending tail bytes at EOF
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

const MAX_RETRY_AFTER_SECONDS = MAX_RETRY_AFTER_DELAY_MS / 1_000;

/**
 * Parses an HTTP `Retry-After` header value into bounded, non-negative
 * seconds (RFC 9110 Â§10.2.3). Accepts both the delta-seconds form and the
 * HTTP-date form; an HTTP-date in the past clamps to 0s. Any value beyond
 * {@link MAX_RETRY_AFTER_SECONDS} is clamped to the cap so a bogus or
 * hostile header can never extend a retry window past the safe maximum.
 * Returns null for absent/empty/unparseable values.
 */
export function parseRetryAfterSeconds(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let seconds: number | null = null;
  if (/^-\d/.test(trimmed)) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) seconds = parsed;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) seconds = Math.max(0, (at - nowMs) / 1_000);
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Reads a bounded error body and maps the upstream HTTP status into a typed
 * ProviderAdapterError with sanitized message, retryability, account/proxy
 * route scoping, and a bounded retry-at window.
 */
export async function readUpstreamError(response: Response): Promise<never> {
  const statusCode = response.status;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"), Date.now());
  const bodyText = await readBoundedText(response.body, MAX_ERROR_BODY_BYTES);
  let message = "";
  let errorKind: string | null = null;
  if (bodyText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (isRecord(parsed)) {
        if (isRecord(parsed.error)) {
          if (typeof parsed.error.message === "string") message = parsed.error.message;
          errorKind = typeof parsed.error.type === "string" ? parsed.error.type : typeof parsed.error.code === "string" ? parsed.error.code : null;
        } else if (typeof parsed.message === "string") {
          message = parsed.message;
        }
      }
    } catch {
      message = bodyText.slice(0, 500);
    }
  }
  throw mapUpstreamError(statusCode, message.length > 0 ? message : `Upstream provider returned HTTP ${statusCode}`, retryAfterSeconds, errorKind);
}

// ---------------------------------------------------------------- SSE decoding

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

export interface SseDecodeConfig {
  readonly body: ReadableStream<Uint8Array>;
  readonly coordinator: AbortCoordinator;
  readonly maxLineBytes: number;
  readonly maxEventBytes?: number;
  readonly idleTimeoutMs?: number;
}

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
    return new ProviderAdapterError({ kind: "stream_timeout", message: "Upstream stream timed out", retryable: false, routeScope: "provider" });
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

export type StreamMapper = (sse: SseEvent) => StreamEvent | readonly StreamEvent[] | null;

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
    throw new ProviderAdapterError({ kind: "stream_truncated", message: "Upstream stream ended before a terminal event", retryable: false, routeScope: "provider" });
  }
}

// ---------------------------------------------------------------- catalogs

export function createModelCatalog(models: readonly ProviderModel[]): ProviderModelCatalog {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) byId.set(model.id, model);
  return {
    list: Object.freeze([...models]),
    get: (modelId: string): ProviderModel | null => byId.get(modelId) ?? null,
  };
}

export interface CapabilitySeed {
  readonly surfaces: readonly Surface[];
  readonly streaming?: boolean;
  readonly reasoning?: boolean;
  readonly toolCalls?: boolean;
  readonly images?: boolean;
  readonly explicitCache?: boolean;
  readonly promptCacheKey?: boolean;
}

export function capabilitiesOf(seed: CapabilitySeed): ProviderCaps {
  return {
    surfaces: [...seed.surfaces],
    streaming: seed.streaming ?? true,
    reasoning: seed.reasoning ?? false,
    toolCalls: seed.toolCalls ?? true,
    images: seed.images ?? false,
    explicitCache: seed.explicitCache ?? false,
    promptCacheKey: seed.promptCacheKey ?? false,
  };
}

/**
 * Projects the normalized capability categories from a model's capability
 * booleans: "vision" when the model accepts images, "text" for any chat- or
 * message-shaped surface, "reasoning" when extended thinking is supported.
 * Pure image-generation models (surfaces `["images"]`) are not tagged "text".
 */
export function categoriesOf(capabilities: ProviderCaps): readonly ModelCapabilityCategory[] {
  const categories: ModelCapabilityCategory[] = [];
  if (capabilities.images) categories.push("vision");
  if (capabilities.surfaces.some((surface) => surface !== "images")) categories.push("text");
  if (capabilities.reasoning) categories.push("reasoning");
  return categories;
}

/** Optional normalized metadata overrides for {@link modelOf}. */
export interface ModelMetadataSeed {
  /**
   * Upstream model id when it differs from the client-facing id. When set,
   * transport layers send this to the upstream API instead of the id.
   */
  readonly upstreamId?: string;
  readonly context?: Partial<ModelContextLimits> | null;
  /** Explicit category list; defaults to a projection of the capability booleans. */
  readonly categories?: readonly ModelCapabilityCategory[] | null;
  readonly pricing?: Partial<ModelTokenPricing> | null;
}

export function modelOf(id: string, displayName: string, capabilities: ProviderCaps, metadata: ModelMetadataSeed = {}): ProviderModel {
  return {
    id,
    displayName,
    capabilities,
    ...(metadata.upstreamId !== undefined ? { upstreamId: metadata.upstreamId } : {}),
    context: {
      inputTokens: metadata.context?.inputTokens ?? null,
      outputTokens: metadata.context?.outputTokens ?? null,
    },
    categories: metadata.categories ?? categoriesOf(capabilities),
    pricing: {
      inputPerMillion: metadata.pricing?.inputPerMillion ?? null,
      outputPerMillion: metadata.pricing?.outputPerMillion ?? null,
    },
  };
}

/**
 * Aggregates a model catalog into adapter-level capabilities (union of
 * surfaces, OR of boolean flags). Falls back to `fallback` for empty
 * catalogs, which keeps catalog-less providers (routers, local servers)
 * permissive.
 */
export function aggregateCapabilities(models: readonly ProviderModel[], fallback: ProviderCaps): ProviderCaps {
  if (models.length === 0) return { ...fallback, surfaces: [...fallback.surfaces] };
  const surfaces: Surface[] = [];
  let streaming = false;
  let reasoning = false;
  let toolCalls = false;
  let images = false;
  let explicitCache = false;
  let promptCacheKey = false;
  for (const model of models) {
    const caps = model.capabilities;
    for (const surface of caps.surfaces) {
      if (!surfaces.includes(surface)) surfaces.push(surface);
    }
    streaming ||= caps.streaming;
    reasoning ||= caps.reasoning;
    toolCalls ||= caps.toolCalls;
    images ||= caps.images;
    explicitCache ||= caps.explicitCache;
    promptCacheKey ||= caps.promptCacheKey;
  }
  return { surfaces, streaming, reasoning, toolCalls, images, explicitCache, promptCacheKey };
}

// ---------------------------------------------------------------- openai adapter factory

const OPENAI_SURFACES: readonly Surface[] = ["openai-chat", "openai-responses"];
const OPENAI_FALLBACK_CAPS: ProviderCaps = capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true, images: true });

export interface OpenAIAdapterConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credentialKind: CredentialKind;
  readonly credentialUrl?: string;
  readonly auth?: "bearer" | "x-api-key" | "none";
  readonly models?: readonly ProviderModel[];
}

/**
 * Creates a standalone OpenAI-compatible Chat Completions adapter.
 * Each provider file imports this to create its own adapter instance.
 */
export function makeOpenAIAdapter(config: OpenAIAdapterConfig): Adapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const models = config.models ?? [];
  const modelCatalog = createModelCatalog(models);
  const capabilities = aggregateCapabilities(models, OPENAI_FALLBACK_CAPS);
  const metadata: ProviderMeta = {
    id: config.id,
    displayName: config.displayName,
    protocol: "openai",
    credentialKind: config.credentialKind,
    ...(config.credentialUrl ? { credentialUrl: config.credentialUrl } : {}),
  };
  const auth = config.auth ?? "bearer";

  function assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== metadata.id) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.request.stream && !capabilities.streaming) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }

  return {
    metadata,
    capabilities,
    models: modelCatalog,
    resolveTarget(modelId: string, surface: Surface): RouteTarget {
      if (!capabilities.surfaces.includes(surface)) {
        throw new ProviderAdapterError({
          kind: "capability_unsupported",
          message: `Provider "${metadata.id}" does not support surface "${surface}"`,
          statusCode: 400,
          routeScope: null,
        });
      }
      const entry = modelCatalog.get(modelId);
      const upstreamModelId = entry?.upstreamId ?? modelId;
      return { providerId: metadata.id, modelId, upstreamModelId, surface };
    },
    async call(input: ProviderRequest): Promise<ProviderOutput> {
      assertSupported(input);
      const { request, credential } = input;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
        ...(input.headers?.get("user-agent") ? { "user-agent": input.headers.get("user-agent")! } : {}),
      };
      if (auth === "bearer" && credential.length > 0) headers.authorization = `Bearer ${credential}`;
      else if (auth === "x-api-key" && credential.length > 0) headers["x-api-key"] = credential;
      if (input.target.surface === "openai-responses") return callResponsesWire(input, baseUrl, headers);
      return callChatCompletionsWire(input, baseUrl, headers);
    },
    async countTokens(_input: TokenCountInput): Promise<ContextStats> {
      return { tokens: null, source: "unknown" };
    },
    mapError(error: unknown): ProviderCallError {
      return toProviderCallError(error);
    },
  };
}
