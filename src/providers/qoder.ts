import { createCipheriv, createHash, constants, publicEncrypt, randomUUID } from "node:crypto";

import { AbortCoordinator,
ProviderAdapterError,
aggregateCapabilities,
capabilitiesOf,
createModelCatalog,
decodeSseEvents,
executeFetch,
lineLimit,
modelOf,
readUpstreamError,
toProviderCallError, } from "../open-sse/transport/shared";
import { isRecord } from "../application/protocols";
import type { SseEvent } from "../open-sse/transport/shared";
import { createChatMapper } from "../open-sse/transport/protocols/openai";
import { isTerminalEvent, type ContentBlock, type NormalizedMessage, type ProxyRequest, type Adapter, type ProviderCaps, type ProviderCallError, type ProviderMeta, type ProviderModel, type ProviderModelCatalog, type ProviderOutput, type ProviderRequest, type Surface, type ProviderUsage, type RequestLimits, type RouteTarget, type StopReason, type StreamEvent } from "../application/contracts";

/**
 * Qoder — the Qoder CLI's `agent_chat_generation` SSE gateway
 * (https://api2.qoder.sh), restored from the legacy provider. A Qoder
 * personal access token (PAT) is exchanged per request for short-lived COSY
 * signing credentials (RSA-wrapped AES session key, MD5 request signature,
 * stable per-PAT machine id), then the OpenAI-shaped chat payload is encoded
 * with Qoder's custom base64 reorder alphabet and POSTed as raw bytes.
 *
 * The upstream is streaming-only: the adapter always requests `stream: true`
 * and unwraps Qoder's `{statusCodeValue, body}` SSE envelopes into plain
 * OpenAI chat-completion-chunk frames, which the shared chat mapper turns
 * into canonical stream events. Non-stream clients get the same wire
 * response materialized into a complete `chat.completion` body.
 *
 * Credential kind is `api_key` on the application contract: the PAT is
 * injected read-only through the standard credential string and never
 * retained beyond the request-local exchange (only a hashed key for the
 * machine-id cache is kept).
 */

const QODER_SURFACES: readonly Surface[] = ["openai-chat"];
const QODER_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true });

// ---------------------------------------------------------------- wire constants

const APPCODE = "cosy";
const COSY_VERSION = "1.0.22";
const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
export const QODER_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
export const QODER_CHAT_URL = "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  machineId: string;
}

export interface QoderModelConfig {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  source?: string;
}

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- model catalog

const QODER_MODELS: readonly ProviderModel[] = [
  modelOf("auto", "Qoder Auto", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("ultimate", "Qoder Ultimate", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("performance", "Qoder Performance", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("efficient", "Qoder Efficient", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("lite", "Qoder Lite", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true })),
  modelOf("qmodel", "Qoder Qwen 3.6 Plus", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("qmodel_latest", "Qoder Qwen 3.7 Max", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("qmodel_preview", "Qoder Qwen 3.8 Max", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("dmodel", "Qoder DeepSeek V4 Pro", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("dfmodel", "Qoder DeepSeek V4 Flash", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("gm51model", "Qoder GLM 5.2", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("kmodel", "Qoder Kimi K2.7", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  modelOf("mmodel", "Qoder MiniMax M2.7", capabilitiesOf({ surfaces: QODER_SURFACES, reasoning: true, images: true })),
  // Present in the legacy static config (and accepted by the legacy call
  // path) even though the legacy catalog omitted it — catalog membership is
  // what makes it resolvable in the catalog-driven registry.
  modelOf("kmodel_latest", "Qoder Kimi K2.7 Latest", capabilitiesOf({ surfaces: QODER_SURFACES, images: true })),
];

export const qoderModelCatalog: readonly ProviderModel[] = QODER_MODELS;

/**
 * Static per-model configuration — mirrors OmniArk's QODER_MODELS. Used
 * instead of fetching Qoder's model catalog API (which has token propagation
 * issues and returns 403 "Login expired" intermittently).
 */
export const QODER_MODEL_CONFIGS: Record<string, QoderModelConfig> = {
  auto:          { id: "auto",          display_name: "Auto",              max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  ultimate:      { id: "ultimate",      display_name: "Ultimate",          max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  performance:   { id: "performance",   display_name: "Performance",       max_input_tokens: 272000, is_vl: true,  is_reasoning: false },
  efficient:     { id: "efficient",     display_name: "Efficient",         max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  lite:          { id: "lite",          display_name: "Lite",              max_input_tokens: 180000, is_vl: false, is_reasoning: false },
  qmodel:        { id: "qmodel",        display_name: "Qwen 3.6 Plus",    max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen 3.7 Max",     max_input_tokens: 1000000, is_vl: true,  is_reasoning: false },
  qmodel_preview:{ id: "qmodel_preview",display_name: "Qwen 3.8 Max",     max_input_tokens: 1000000, is_vl: true,  is_reasoning: false },
  dmodel:        { id: "dmodel",        display_name: "DeepSeek V4 Pro",   max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  dfmodel:       { id: "dfmodel",       display_name: "DeepSeek V4 Flash", max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  gm51model:     { id: "gm51model",     display_name: "GLM 5.1",           max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  kmodel:        { id: "kmodel",        display_name: "Kimi K2.6",         max_input_tokens: 256000, is_vl: true,  is_reasoning: false },
  mmodel:        { id: "mmodel",        display_name: "MiniMax M2.7",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi K2.7 Latest",  max_input_tokens: 256000, is_vl: true,  is_reasoning: false },
};

// ---------------------------------------------------------------- request encoding

/** Encodes a Qoder body using the CLI's request encoding. */
export function encodeQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

const MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const MAX_MACHINE_IDS = 1_024;
const machineIds = new Map<string, { id: string; expiresAt: number }>();

/**
 * Keeps a request-local PAT's ephemeral client identity stable without
 * retaining the PAT itself (only a SHA-256 fingerprint is stored, TTL-bounded
 * and size-capped).
 */
function machineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex");
  const now = Date.now();
  const existing = machineIds.get(key);
  if (existing && existing.expiresAt > now) return existing.id;

  const id = randomUUID();
  machineIds.delete(key);
  machineIds.set(key, { id, expiresAt: now + MACHINE_ID_TTL_MS });
  for (const [candidate, value] of machineIds) {
    if (value.expiresAt <= now) machineIds.delete(candidate);
  }
  while (machineIds.size > MAX_MACHINE_IDS) {
    const oldest = machineIds.keys().next();
    if (oldest.done) break;
    machineIds.delete(oldest.value);
  }
  return id;
}

function md5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

function pathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

function staticHeaders(machineId: string): Record<string, string> {
  const date = new Date().toUTCString();
  return {
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "5",
    "cosy-machineid": machineId,
    "cosy-clienttype": "5",
    "cosy-version": COSY_VERSION,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date,
    signature: md5(`${APPCODE}&${SIG_SECRET}&${date}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

/**
 * Exchanges an inbound Qoder personal access token for request-local COSY
 * signing credentials. The PAT is sent only inside the encoded exchange body
 * and never retained.
 */
export async function exchangeQoderPat(
  pat: string,
  signal: AbortSignal,
  fetcher: QoderFetcher = fetch,
): Promise<QoderAuth> {
  const machineId = machineIdFromPat(pat);
  const encodedBody = encodeQoderBody(JSON.stringify({
    payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }),
    encodeVersion: "1",
  }));
  const response = await fetcher(QODER_JOB_TOKEN_URL, { method: "POST", headers: staticHeaders(machineId), body: encodedBody, signal });
  if (!response.ok) throw qoderHttpError(response.status, "PAT exchange");
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned invalid JSON.", routeScope: "provider" });
  }
  if (!isRecord(responseBody)) {
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned an unexpected response.", routeScope: "provider" });
  }
  if (typeof responseBody.id !== "string" || typeof responseBody.securityOauthToken !== "string") {
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Qoder PAT exchange returned incomplete credentials.", routeScope: "provider" });
  }
  return {
    userId: responseBody.id,
    userName: typeof responseBody.name === "string" ? responseBody.name : "",
    userType: typeof responseBody.userType === "string" ? responseBody.userType : "personal_standard",
    securityOauthToken: responseBody.securityOauthToken,
    refreshToken: typeof responseBody.refreshToken === "string" ? responseBody.refreshToken : "",
    machineId,
  };
}

function buildCosyHeaders(body: Uint8Array, url: string, auth: QoderAuth): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = JSON.stringify({
    name: auth.userName,
    aid: auth.userId,
    uid: auth.userId,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: auth.userType,
    security_oauth_token: auth.securityOauthToken,
    refresh_token: auth.refreshToken,
  });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(JSON.stringify({ version: "v1", requestId: randomUUID(), info, cosyVersion: COSY_VERSION, ideVersion: "" })).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = md5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${pathSignature(url)}`);

  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": "x86_64_windows",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": md5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": pathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    "cosy-business-product": "cli",
    "cosy-business-type": "agent",
    "cosy-scene": "assistant",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": auth.machineId,
    "cosy-machinetoken": auth.machineId,
    "login-version": "v2",
    "content-type": "application/json",
    accept: "text/event-stream",
    "accept-encoding": "identity",
    "cache-control": "no-cache",
    "user-agent": "Go-http-client/2.0",
  };
}

/** Fetches Qoder account credit usage using the same COSY identity as the CLI. */
export async function fetchQoderUsage(auth: QoderAuth, signal: AbortSignal, fetcher: QoderFetcher = fetch): Promise<unknown> {
  const response = await fetcher(QODER_USAGE_URL, { method: "GET", headers: { authorization: `Bearer ${auth.securityOauthToken}`, accept: "application/json", "user-agent": "pi-provider-qoder" }, signal });
  if (!response.ok) throw qoderHttpError(response.status, "usage");
  try {
    return await response.json();
  } catch {
    throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Qoder usage returned invalid JSON.", routeScope: "provider" });
  }
}

/** Maps Qoder inner/HTTP status codes onto typed adapter errors (legacy semantics, current kinds). */
function qoderHttpError(status: number, operation: string): ProviderAdapterError {
  if (status === 401) return new ProviderAdapterError({ kind: "authentication_failed", message: `Qoder ${operation} rejected the supplied credential.`, statusCode: status, routeScope: "account" });
  if (status === 403) return new ProviderAdapterError({ kind: "authorization_denied", message: `Qoder ${operation} rejected the supplied credential.`, statusCode: status, routeScope: "account" });
  if (status === 429) return new ProviderAdapterError({ kind: "provider_rate_limited", message: `Qoder ${operation} is rate-limited.`, statusCode: status, retryable: true, routeScope: "account" });
  if (status >= 400 && status < 500) return new ProviderAdapterError({ kind: "invalid_request", message: `Qoder ${operation} rejected this request.`, statusCode: status, routeScope: "provider" });
  return new ProviderAdapterError({ kind: "provider_unavailable", message: `Qoder ${operation} is unavailable.`, statusCode: status, retryable: true, routeScope: "provider" });
}

/** Sends the encoded, COSY-signed Qoder inference request. */
export async function callQoder(
  url: string,
  body: Record<string, unknown>,
  modelId: string,
  auth: QoderAuth,
  signal: AbortSignal,
  fetcher: QoderFetcher = fetch,
): Promise<Response> {
  const encoded = encodeQoderBody(JSON.stringify(body));
  const modelConfig = isRecord(body.model_config) ? body.model_config : null;
  return fetcher(url, {
    method: "POST",
    headers: {
      ...buildCosyHeaders(encoded, url, auth),
      "x-model-key": modelId,
      "x-model-source": typeof modelConfig?.source === "string" ? modelConfig.source : "system",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
    },
    body: encoded,
    signal,
  });
}

// ---------------------------------------------------------------- request shaping

function stableHash(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(p);
  }
  return h.digest("hex").slice(0, 16);
}

function stableRecordId(modelId: string, messages: readonly NormalizedMessage[], maxTokens: number): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(modelId);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    const text = flattenContent(m.content);
    if (text) {
      h.update("\0");
      h.update(text);
    }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function flattenContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" || block.type === "tool_result")
    .map((block) => block.text ?? "")
    .join("\n");
}

function requestedMaxTokens(body: ProxyRequest, modelConfig: QoderModelConfig): number {
  const configured = typeof modelConfig.max_output_tokens === "number" ? modelConfig.max_output_tokens : 32768;
  const requested = body.maxOutputTokens;
  return typeof requested === "number" && requested > 0 ? Math.min(requested, configured) : configured;
}

function buildQoderRequest(
  modelId: string,
  body: ProxyRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
): Record<string, unknown> {
  const messages = body.messages;
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => flattenContent(m.content))
    .filter(Boolean)
    .join("\n\n");
  const qoderMessages = messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => {
      const flat = flattenContent(m.content);
      const mapped: Record<string, unknown> = {
        role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user",
        content: flat,
        contents: [{ type: "text", text: flat }],
      };
      if (m.role === "tool") {
        const block = m.content[0];
        if (block?.toolCallId) mapped.tool_call_id = block.toolCallId;
      }
      return mapped;
    });
  const latestUserMessage = [...qoderMessages].reverse().find((m) => m.role === "user");
  const latestUserText = typeof latestUserMessage?.content === "string" ? latestUserMessage.content : "";
  const maxTokens = requestedMaxTokens(body, modelConfig);
  const reasoning = modelConfig.is_reasoning === true;

  // Stable IDs for upstream cache hits (aligned with 9router):
  //   session_id = hash(userId + modelKey) → same user+model = same session
  //   record_id  = hash(model + messages + maxTokens) → same conversation = same record
  const sessionId = stableHash("qoder-session", auth.userId, modelId);
  const recordId = stableRecordId(modelId, messages, maxTokens);

  return {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    aliyun_user_type: "",
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    // chat_context: plain strings not objects
   chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelId, is_reasoning: reasoning },
        originalContent: latestUserText,
      },
      features: [],
      text: latestUserText,
    },
    model_config: {
      key: modelId,
      display_name: modelConfig.display_name,
      is_vl: modelConfig.is_vl,
      is_reasoning: modelConfig.is_reasoning,
      max_input_tokens: modelConfig.max_input_tokens,
      format: "openai",
      source: "system",
    },
    system,
    messages: qoderMessages,
    tools: body.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.inputSchema } })),
    parameters: { max_tokens: maxTokens },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: randomUUID(),
      name: latestUserText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

// ---------------------------------------------------------------- SSE unwrap

/**
 * Maps one Qoder SSE data line (an `{statusCodeValue, body}` envelope) to
 * zero or more OpenAI chat-completion-chunk frames. Malformed/telemetry
 * envelopes are skipped; non-200 envelope statuses throw a typed adapter
 * error (current contracts replace the legacy "inject an error chunk"
 * 9router pattern).
 */
function qoderEnvelopeToFrames(data: string): SseEvent[] {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return []; // skip malformed lines instead of throwing
  }
  if (!isRecord(envelope)) return [];
  if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
    throw qoderHttpError(typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 502, "stream");
  }
  const body = envelope.body;
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body !== "string") {
    // Qoder finish event (firstTokenDuration, totalDuration, etc.) — skip.
    return [];
  }
  // Strip embedded newlines so the re-emitted frame stays a single SSE
  // event (9router pattern).
  return [{ event: null, data: body.replace(/\r?\n/g, "") }];
}

/**
 * Decodes Qoder's raw SSE envelope stream into OpenAI chat-completion-chunk
 * frames, re-emitting a synthetic `[DONE]` at EOF when the upstream closed
 * without one (legacy flush behavior).
 */
async function* unwrapQoderEnvelopes(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator, limits: RequestLimits): AsyncGenerator<SseEvent> {
  let doneEmitted = false;
  for await (const sse of decodeSseEvents({ body, coordinator, maxLineBytes: lineLimit(limits), idleTimeoutMs: limits.idleTimeoutMs })) {
    for (const frame of qoderEnvelopeToFrames(sse.data)) {
      yield frame;
      if (frame.data === "[DONE]") doneEmitted = true;
    }
  }
  if (!doneEmitted) yield { event: null, data: "[DONE]" };
}

/** Decodes the unwrapped Qoder stream into canonical StreamEvents with the shared chat mapper. */
async function* decodeQoderStream(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator, limits: RequestLimits): AsyncGenerator<StreamEvent> {
  let terminal = false;
  const mapper = createChatMapper();
  for await (const sse of unwrapQoderEnvelopes(body, coordinator, limits)) {
    const mapped = mapper(sse);
    if (mapped === null) continue;
    const events = Array.isArray(mapped) ? mapped : [mapped];
    for (const event of events) {
      yield event;
      if (isTerminalEvent(event)) terminal = true;
    }
  }
  if (!terminal) {
    throw new ProviderAdapterError({ kind: "stream_truncated", message: "Qoder stream ended before a terminal event", retryable: true, routeScope: "provider" });
  }
}

// ---------------------------------------------------------------- non-stream materialization

interface MaterializedChat {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  stopReason: StopReason;
  usage: ProviderUsage;
}

/** Drains a stream of canonical events into a materialized chat result. */
async function materializeChatEvents(events: AsyncIterable<StreamEvent>): Promise<MaterializedChat> {
  let text = "";
  const toolsById = new Map<string, { id: string; name: string; arguments: string }>();
  let stopReason: StopReason = "completed";
  let usage: ProviderUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" };
  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "tool_call_start": {
        const existing = toolsById.get(ev.callId);
        if (!existing) toolsById.set(ev.callId, { id: ev.callId, name: ev.name, arguments: "" });
        else if (existing.name !== ev.name) existing.name = ev.name;
        break;
      }
      case "tool_call_delta": {
        const existing = toolsById.get(ev.callId);
        if (existing) existing.arguments += ev.delta;
        break;
      }
      case "message_stop":
        stopReason = ev.reason;
        break;
      case "usage":
        usage = ev.usage;
        break;
    }
  }
  return { text, toolCalls: [...toolsById.values()], stopReason, usage };
}

function stopReasonToOpenAIFinish(reason: StopReason): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "length":
      return "length";
    case "tool_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function materializedToChatResponse(result: MaterializedChat, model: string): Record<string, unknown> {
  const finishReason = result.toolCalls.length > 0 ? "tool_calls" : stopReasonToOpenAIFinish(result.stopReason);
  const message: Record<string, unknown> = { role: "assistant", content: result.text };
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }));
  }
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: (result.usage.inputTokens ?? 0) + (result.usage.cacheReadTokens ?? 0),
      completion_tokens: result.usage.outputTokens ?? 0,
      total_tokens: (result.usage.totalTokens ?? 0) || ((result.usage.inputTokens ?? 0) + (result.usage.cacheReadTokens ?? 0) + (result.usage.outputTokens ?? 0)),
      prompt_tokens_details: { cached_tokens: result.usage.cacheReadTokens ?? 0 },
      cache_write_tokens: result.usage.cacheWriteTokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------- adapter

/** Qoder is a PAT-exchanged, COSY-signed, streaming-only OpenAI-chat gateway. */
export class QoderAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "qoder",
    displayName: "Qoder",
    protocol: "openai",
    credentialKind: "api_key",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(QODER_MODELS);
  readonly capabilities: ProviderCaps = aggregateCapabilities(QODER_MODELS, QODER_FALLBACK_CAPABILITIES);

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Qoder personal access token is required.", statusCode: 401, routeScope: "account" });
    }
    const { request, signal, network } = input;
    const modelConfig = QODER_MODEL_CONFIGS[input.target.modelId];
    if (!modelConfig) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Qoder model "${input.target.modelId}" is not supported.`, statusCode: 400, routeScope: "provider" });
    }

    const coordinator = new AbortCoordinator(signal, {
      connectTimeoutMs: request.limits.connectTimeoutMs,
      totalTimeoutMs: request.limits.totalTimeoutMs,
    });
    // Route every upstream call (PAT exchange + inference) through the same
    // coordinator so proxy selection and connect/total timeouts cover the
    // whole exchange-then-call sequence.
    const fetcher: QoderFetcher = (url, init) => executeFetch(url, init, coordinator, network, input.capture);
    let streamHandedOff = false;
    try {
      const auth = await exchangeQoderPat(input.credential, coordinator.signal, fetcher);
      const qoderBody = buildQoderRequest(input.target.modelId, request, modelConfig, auth);
      const response = await callQoder(QODER_CHAT_URL, qoderBody, input.target.modelId, auth, coordinator.signal, fetcher);
      if (!response.ok) throw await readUpstreamError(response);
      if (!response.body) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Qoder returned an empty response body", routeScope: "provider" });
      }
      const events = decodeQoderStream(response.body, coordinator, request.limits);
      if (request.stream) {
        streamHandedOff = true;
        return { mode: "stream", events };
      }
      const materialized = await materializeChatEvents(events);
      return { mode: "non_stream", body: materializedToChatResponse(materialized, request.model), usage: materialized.usage };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}