// Bespoke by wire protocol: MiniMax Agent (`agent.minimax.io`) is a
// session-based agent API, not an [OI]-compatible chat wire, so it cannot use
// the [OI]-compatible factory. Dispatch performs a three-call handshake —
// agent list → session create → message SSE — and every call carries an
// `x-signature: md5(timestamp + salt + body)` plus the account JWT in both the
// `token` header and the query string.
//
// Credential shape: the account secret is the JSON object harvested by
// `minimax-agent-automation` (`{email, password, cookie, jwt, realUserID}`), so
// one credential carries the bearer JWT, the browser cookie jar the upstream
// WAF expects, and the account id its query envelope is keyed on. That id is
// the harvester's `realUserID`, not the JWT's `user.id` — the two differ for
// every harvested account, and the upstream answers 401 for the JWT's value and
// for an absent one alike — so it cannot be recovered from the token and a
// secret without it is rejected rather than dispatched.
//
// The upstream is a stateful agent, not a completion endpoint: each dispatch
// opens a fresh session and sends the canonical conversation as one message, so
// concurrent requests never share mutable server-side history.
import { createHash, randomUUID } from "node:crypto";
import { GatewayError } from "../../transport/gateway-error";
import { joinTextParts } from "../../transport/canonical-model";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  ContentPart,
  UsageRecord,
} from "../../transport/canonical-model";
import { normalizeUsage } from "../usage";
import { defineModel } from "../model-definition";
import { providerBaseUrl } from "../provider-metadata";
import { createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import {
  readCredentialSecret,
  type ModelDefinition,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../provider-registry";

export const MINIMAX_PROVIDER_ID = "minimax" as const;
export const MINIMAX_BASE_URL = providerBaseUrl("minimax");
/** The message endpoint lives on a second host; both are public and DNS-validated at dispatch. */
export const MINIMAX_STREAM_BASE_URL = "https://agent-stream.minimax.io";
/**
 * Request-signing salt read off the shipped web client. The upstream signs
 * `md5(timestamp + salt + body)` and does not validate the derived value
 * against the session, so it is a client fingerprint rather than a secret.
 */
export const MINIMAX_REQUEST_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";
const MINIMAX_CLIENT_VERSION = "22201";
const MINIMAX_APP_ID = "3001";
const MINIMAX_BIZ_ID = "3";
const MINIMAX_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const MINIMAX_DEFAULT_CONTEXT_LIMIT = 512_000;

/** One model the agent upstream advertises through `/minimax-cloud/api/v1/config`. */
export interface MinimaxModelConfig {
  readonly id: string;
  readonly contextLimit: number;
  readonly reasoning: boolean;
}

/**
 * Static catalog. Context limits are the ones the upstream declares in its own
 * `/minimax-cloud/api/v1/config` payload (`context_limit`), not base-catalog
 * guesses. `free: true` because these accounts are subscription agent seats —
 * the base catalog prices the paid MiniMax API, which these credentials never
 * bill.
 */
export const MINIMAX_MODELS: readonly ModelDefinition[] = (
  [
    { id: "MiniMax-M3.1-Flash-Preview", contextLimit: 512_000, reasoning: true },
    { id: "MiniMax-M3", contextLimit: 450_000, reasoning: true },
    { id: "MiniMax-M2.7", contextLimit: 200_000, reasoning: true },
    { id: "MiniMax-M2.7-highspeed", contextLimit: 200_000, reasoning: true },
  ] as const satisfies readonly MinimaxModelConfig[]
).map((model) =>
  defineModel({
    id: model.id,
    providerId: MINIMAX_PROVIDER_ID,
    ctx: model.contextLimit,
    reasoning: model.reasoning,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    // The agent wire accepts no tool declarations, so a tool-bearing request
    // cannot be honoured upstream. Declared false rather than silently dropped.
    toolCall: false,
    free: true,
  }),
);

const MINIMAX_MODEL_CONFIGS: Readonly<Record<string, MinimaxModelConfig>> = Object.fromEntries(
  MINIMAX_MODELS.map((model) => [
    model.modelId,
    { id: model.modelId, contextLimit: model.contextLimit ?? MINIMAX_DEFAULT_CONTEXT_LIMIT, reasoning: model.reasoning },
  ]),
);

/** Account credential carried in the provider account's secret. */
export interface MinimaxCredential {
  readonly jwt: string;
  readonly cookie: string;
  /**
   * The account id every query envelope is keyed on.
   *
   * This is the harvester's `realUserID`, and it cannot be derived from the
   * JWT: that token's `user.id` is a different number (the two differ for
   * every harvested account), and the upstream answers 401 for it and for an
   * absent `user_id` alike. So the credential has to carry it, and a secret
   * without it is rejected here rather than dispatched into a bare 401.
   */
  readonly userId: string;
}

/**
 * Parses the stored account secret: the JSON object `minimax-agent-automation`
 * harvests, which carries the JWT, the browser cookie jar the upstream WAF
 * expects, and the account id the query envelope is keyed on.
 */
export function parseMinimaxCredential(secret: string): MinimaxCredential {
  const trimmed = secret.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new GatewayError(
      "authentication_failed",
      401,
      "MiniMax Agent credential must be the harvested JSON object ({email, password, cookie, jwt, realUserID})",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError("authentication_failed", 401, "MiniMax Agent credential is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const jwt = typeof record["jwt"] === "string" ? record["jwt"].trim() : "";
  if (!jwt) throw new GatewayError("authentication_failed", 401, "MiniMax Agent credential has no JWT");
  const cookie = typeof record["cookie"] === "string" ? record["cookie"] : "";
  const storedUserId = record["realUserID"] ?? record["userID"];
  if (typeof storedUserId !== "string" || storedUserId.length === 0) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "MiniMax Agent credential has no realUserID; the upstream keys its query envelope on it and cannot recover it from the JWT",
    );
  }
  return { jwt, cookie, userId: storedUserId };
}

/** `md5(timestamp + salt + body)`, the upstream's per-request signature. */
export function minimaxSignature(timestamp: string, body: string): string {
  return createHash("md5").update(`${timestamp}${MINIMAX_REQUEST_SALT}${body}`).digest("hex");
}

/** Query parameters every `agent.minimax.io` call carries. */
export function buildMinimaxParams(
  credential: MinimaxCredential,
  extra: Readonly<Record<string, string>> = {},
): string {
  // Stable per-account numeric device id: the upstream echoes it back in its
  // analytics envelope and expects a value, not a UUID.
  let deviceId = 0;
  for (const char of credential.userId) deviceId = (deviceId * 31 + char.charCodeAt(0)) % 100_000_000;
  const params: Record<string, string> = {
    device_platform: "web",
    biz_id: MINIMAX_BIZ_ID,
    app_id: MINIMAX_APP_ID,
    version_code: MINIMAX_CLIENT_VERSION,
    unix: String(Date.now()),
    timezone_offset: "0",
    sys_language: "en",
    lang: "en",
    uuid: randomUUID(),
    device_id: String(deviceId).padStart(8, "0"),
    os_name: "macOS",
    browser_name: "Chrome",
    device_memory: "16",
    cpu_core_num: "8",
    browser_language: "en-US",
    browser_platform: "Linux x86_64",
    user_id: credential.userId,
    screen_width: "1440",
    screen_height: "900",
    token: credential.jwt,
    client: "web",
    region: "en",
    ...extra,
  };
  return new URLSearchParams(params).toString();
}

/** The model block the session-create and message calls both carry. */
export function buildMinimaxModelBlock(
  modelId: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  const config = MINIMAX_MODEL_CONFIGS[modelId];
  const effort = request.reasoning?.effort;
  const block: Record<string, unknown> = {
    provider_id: MINIMAX_PROVIDER_ID,
    model_id: modelId,
    reasoning: config?.reasoning ?? false,
    context_limit: config?.contextLimit ?? MINIMAX_DEFAULT_CONTEXT_LIMIT,
  };
  // The upstream accepts only the five named efforts; an unset or "none"/"minimal"
  // intent must omit the block entirely rather than name a default, because
  // `effort: "default"` is rejected with `invalid reasoning_effort`.
  if (config?.reasoning && effort !== undefined && effort !== "none" && effort !== "minimal") {
    block["thinking"] = { effort };
  }
  return block;
}

/**
 * Flattens the canonical conversation into the single `content` string the
 * agent endpoint accepts. Assistant/tool turns keep a role prefix so a
 * multi-turn history stays readable; the opening user text is passed through
 * unchanged, which is the shape a single-turn chat request produces.
 */
export function buildMinimaxContent(request: CanonicalRequest): string {
  const sections: string[] = [];
  const systemText = joinTextParts([
    ...(request.system ?? []),
    ...(request.instructions ?? []),
  ] as readonly ContentPart[]);
  if (systemText.length > 0) sections.push(systemText);
  for (const message of request.messages) {
    const text = joinTextParts(message.content);
    if (text.length === 0) continue;
    if (message.role === "user") {
      sections.push(text);
      continue;
    }
    sections.push(`${message.role}: ${text}`);
  }
  return sections.join("\n\n");
}

/** Canonical stop reason for the agent's own `finish_reason`. */
export const MINIMAX_STOP_REASONS: Readonly<Record<string, CanonicalStopReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_use",
  content_filter: "content_filter",
};

/** Request-scoped accumulator for the agent SSE transform. */
export interface MinimaxStreamState {
  sawChunk: boolean;
  finishReason: string | undefined;
  usage: Record<string, unknown> | undefined;
}

/** One `data:` payload from the agent stream, mapped to canonical events. */
export function transformMinimaxPayload(
  payload: string,
  state: MinimaxStreamState,
): CanonicalEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = event["type"];
  if (type === 6) {
    const chunk = event["agent_message_chunk"];
    if (typeof chunk !== "object" || chunk === null) return [];
    const record = chunk as Record<string, unknown>;
    if (record["finish"] === true && typeof record["finish_reason"] === "string") {
      state.finishReason = record["finish_reason"];
    }
    const text = typeof record["msg_content"] === "string" ? record["msg_content"] : "";
    if (text.length === 0) return [];
    state.sawChunk = true;
    return [
      {
        type: "content_delta",
        sequence_number: 0,
        content: { kind: "text", text },
      } as CanonicalEvent,
    ];
  }
  if (type === 2) {
    const message = event["agent_message"];
    if (typeof message !== "object" || message === null) return [];
    const record = message as Record<string, unknown>;
    if (record["role"] !== "assistant") return [];
    if (typeof record["finish_reason"] === "string") state.finishReason = record["finish_reason"];
    if (typeof record["usage"] === "object" && record["usage"] !== null) {
      state.usage = record["usage"] as Record<string, unknown>;
    }
    // The final assistant envelope repeats the text already streamed as chunks;
    // emitting it again would duplicate the answer, so it only carries text
    // when the upstream answered without streaming chunks at all.
    if (state.sawChunk) return [];
    const text = typeof record["msg_content"] === "string" ? record["msg_content"] : "";
    if (text.length === 0) return [];
    state.sawChunk = true;
    return [
      {
        type: "content_delta",
        sequence_number: 0,
        content: { kind: "text", text },
      } as CanonicalEvent,
    ];
  }
  return [];
}

/** Normalizes the agent's usage envelope into a canonical usage record. */
export function minimaxUsageRecord(usage: Record<string, unknown>): UsageRecord {
  const number = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return normalizeUsage({
    input_tokens: number("input_tokens") ?? 0,
    output_tokens: number("output_tokens") ?? 0,
    total_tokens: number("total_tokens"),
    cached_tokens: number("cache_read") ?? 0,
  } as unknown as Record<string, unknown>);
}

/** Signal-aware SSE reader: `data:` lines in, canonical events out. */
export async function* transformMinimaxSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  modelId: string,
): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: MinimaxStreamState = { sawChunk: false, finishReason: undefined, usage: undefined };
  let buffer = "";
  let seq = 1;

  yield { type: "response_start", sequence_number: seq++, model: modelId } as CanonicalEvent;

  const readWithAbort = (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (signal.aborted) throw new GatewayError("transport_closed", 499, "MiniMax Agent stream aborted");
    const { promise, resolve, reject } = Promise.withResolvers<{ done: boolean; value?: Uint8Array }>() as unknown as {
      promise: Promise<{ done: boolean; value?: Uint8Array }>;
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    };
    const onAbort = (): void => {
      reject(
        signal.aborted
          ? new GatewayError("transport_closed", 499, "MiniMax Agent stream aborted")
          : new GatewayError("platform_unavailable", 502, "MiniMax Agent stream error", {}, "upstream"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    return promise;
  };

  try {
    while (true) {
      const { done, value } = await readWithAbort();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        for (const event of emitMinimaxLine(line, state)) {
          (event as unknown as Record<string, unknown>)["sequence_number"] = seq++;
          yield event;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    for (const event of emitMinimaxLine(buffer.trim(), state)) {
      (event as unknown as Record<string, unknown>)["sequence_number"] = seq++;
      yield event;
    }
    const terminal: Record<string, unknown> = {
      type: "terminal",
      sequence_number: seq++,
      state: "complete",
      stop_reason: (state.finishReason && MINIMAX_STOP_REASONS[state.finishReason]) || "stop",
      ...(state.finishReason === undefined ? {} : { provider_stop_reason: state.finishReason }),
    };
    if (state.usage) terminal["usage"] = minimaxUsageRecord(state.usage);
    yield terminal as unknown as CanonicalEvent;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Best-effort reader unlock during stream cleanup.
    }
    void reader.cancel().catch(() => {});
  }
}

function emitMinimaxLine(line: string, state: MinimaxStreamState): CanonicalEvent[] {
  if (!line.startsWith("data:")) return [];
  const payload = line.slice("data:".length).trim();
  if (payload.length === 0) return [];
  return transformMinimaxPayload(payload, state);
}

interface MinimaxAgent {
  readonly name: string;
  readonly role: string;
}

/** Picks the agent a new session is created under. */
export function selectMinimaxAgent(agents: readonly MinimaxAgent[]): MinimaxAgent {
  const chosen = agents.find((agent) => agent.role === "mavis") ?? agents[0];
  if (!chosen) {
    throw new GatewayError("platform_unavailable", 502, "MiniMax Agent account exposes no agents", {}, "upstream");
  }
  return chosen;
}

interface MinimaxAdapterOptions {
  readonly fetch?: typeof fetch;
}

interface MinimaxCall {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: string;
}

class MinimaxAdapter implements ProviderAdapter {
  readonly provider_id = MINIMAX_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: MinimaxAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `minimax supports chat only, got ${candidate.wire_family}`,
      );
    }
    const credential = parseMinimaxCredential(
      readCredentialSecret(context.credential, "MiniMax Agent credential is required"),
    );
    const modelId = candidate.model_id || request.model;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const call = async (call: MinimaxCall): Promise<Response> => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = call.body ?? "";
      const headers: Record<string, string> = {
        "user-agent": MINIMAX_WEB_USER_AGENT,
        referer: `${MINIMAX_BASE_URL}/`,
        accept: call.method === "GET" ? "application/json" : "text/event-stream, application/json",
        token: credential.jwt,
        "x-timestamp": timestamp,
        "x-signature": minimaxSignature(timestamp, body),
      };
      if (credential.cookie.length > 0) headers["cookie"] = credential.cookie;
      if (body.length > 0) headers["content-type"] = "application/json";
      return await outboundFetch(call.url, {
        method: call.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        signal: lifecycle.signal,
      });
    };

    try {
      // 1. Agent list — the session is created under one of the account's agents.
      const agentResponse = await call({
        method: "GET",
        url: `${MINIMAX_BASE_URL}/minimax-cloud/api/v1/agent?${buildMinimaxParams(credential, { limit: "20" })}`,
      });
      if (!agentResponse.ok) throw await mapUpstreamHttpError(agentResponse, MINIMAX_PROVIDER_ID);
      const agentBody = (await agentResponse.json()) as { agents?: MinimaxAgent[] };
      const agent = selectMinimaxAgent(agentBody.agents ?? []);

      // 2. Session create — one fresh session per dispatch, so concurrent
      // requests never share the upstream's mutable conversation state.
      const modelBlock = buildMinimaxModelBlock(modelId, request);
      const sessionResponse = await call({
        method: "POST",
        url: `${MINIMAX_BASE_URL}/minimax-cloud/api/v1/agent/${encodeURIComponent(agent.name)}/session?${buildMinimaxParams(credential)}`,
        body: JSON.stringify({ model: modelBlock }),
      });
      if (!sessionResponse.ok) throw await mapUpstreamHttpError(sessionResponse, MINIMAX_PROVIDER_ID);
      const sessionBody = (await sessionResponse.json()) as { session_id?: string };
      const sessionId = sessionBody.session_id;
      if (!sessionId) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "MiniMax Agent session create returned no session id",
          {},
          "upstream",
        );
      }

      // 3. Message — the answer streams back as SSE.
      const messageResponse = await call({
        method: "POST",
        url: `${MINIMAX_STREAM_BASE_URL}/minimax-cloud/api/v1/session/${encodeURIComponent(sessionId)}/message?${buildMinimaxParams(credential)}`,
        body: JSON.stringify({
          content: buildMinimaxContent(request),
          model: modelBlock,
          turn_id: randomUUID(),
          worktreeMode: false,
        }),
      });
      if (!messageResponse.ok) throw await mapUpstreamHttpError(messageResponse, MINIMAX_PROVIDER_ID);
      if (!messageResponse.body) {
        throw new GatewayError("platform_unavailable", 502, "MiniMax Agent returned empty body", {}, "upstream");
      }
      // Headers arrived: the pre-stream deadline has served its purpose. From
      // here the gateway stall/first-chunk watchdog governs the body.
      lifecycle.release();
      yield* transformMinimaxSse(messageResponse.body as ReadableStream<Uint8Array>, lifecycle.signal, modelId);
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      if (lifecycle.signal.aborted || (err as Error).name === "AbortError") {
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      }
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createMinimaxAdapter(options: MinimaxAdapterOptions = {}): ProviderAdapter {
  return new MinimaxAdapter(options);
}
