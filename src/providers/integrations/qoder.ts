// Factory-blocked (Phase C4): PAT-to-jobToken session handshake, COSY
// AES/RSA request signing, alphabet-scrambled binary body, enveloped SSE
// frames — session/crypto protocol outside factory reach; stays bespoke.
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { extractUpstreamMessage, mapUpstreamHttpError, statusToGatewayErrorCode } from "../../transport/failure-policy";
import { GatewayError } from "../../transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason, ContentPart } from "../../transport/canonical-model";
import { toolResultParts } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { usageFromProvider, readReasoningText } from "../usage";
import { readCredentialSecret, type ProviderDispatchTarget, type ModelDefinition, type ProviderAdapter, type ProviderDispatchContext } from "../provider-registry";
import { defineModel } from "../model-definition";
import { getQoderVersion, resolveQoderVersion } from "../operations/client-versions";
import { createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";

interface QoderModeProfile {
  readonly chatUrl: string;
  readonly businessProduct: string;
  readonly businessType: string;
  readonly businessVersion: string;
  readonly cosyScene: string;
  readonly mirrorTopLevelSystem: boolean;
  readonly sendBusinessHeaders: boolean;
  readonly sendModelSourceHeaders: boolean;
  readonly emptyAliyunUserType: boolean;
}

export const MODERN_PROFILE: QoderModeProfile = {
  chatUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
  businessProduct: "cli",
  businessType: "agent",
  businessVersion: "1.0.22",
  cosyScene: "assistant",
  mirrorTopLevelSystem: true,
  sendBusinessHeaders: true,
  sendModelSourceHeaders: true,
  emptyAliyunUserType: true,
};

const QODER_PROVIDER_ID = "qoder" as const;

export const QODER_MODEL_CONFIGS: Record<
  string,
  { id: string; display_name: string; max_input_tokens: number; max_output_tokens?: number; is_vl: boolean; is_reasoning: boolean; source?: string }
> = {
  auto: { id: "auto", display_name: "Auto", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  ultimate: { id: "ultimate", display_name: "Ultimate", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  performance: { id: "performance", display_name: "Performance", max_input_tokens: 272000, is_vl: true, is_reasoning: false },
  efficient: { id: "efficient", display_name: "Efficient", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  lite: { id: "lite", display_name: "Lite", max_input_tokens: 180000, is_vl: false, is_reasoning: true },
  qmodel: { id: "qmodel", display_name: "Qwen 3.6 Plus", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen 3.7 Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  qmodel_preview: { id: "qmodel_preview", display_name: "Qwen 3.8 Max", max_input_tokens: 1000000, is_vl: true, is_reasoning: false },
  dmodel: { id: "dmodel", display_name: "DeepSeek V4 Pro", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  dfmodel: { id: "dfmodel", display_name: "DeepSeek V4 Flash", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  gm51model: { id: "gm51model", display_name: "GLM 5.1", max_input_tokens: 180000, is_vl: true, is_reasoning: true },
  kmodel: { id: "kmodel", display_name: "Kimi K2.6", max_input_tokens: 256000, is_vl: true, is_reasoning: false },
  mmodel: { id: "mmodel", display_name: "MiniMax M2.7", max_input_tokens: 180000, is_vl: true, is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi K2.7 Latest", max_input_tokens: 256000, is_vl: true, is_reasoning: false },
};

const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
interface QoderModelConfig {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  source?: string;
}


function qoderMd5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}
function qoderPathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

const QODER_MACHINE_ID_TTL_MS = 60 * 60 * 1000;
const QODER_MAX_MACHINE_IDS = 1_024;
const qoderMachineIds = new Map<string, { id: string; expiresAt: number }>();

function qoderMachineIdFromPat(pat: string): string {
  const key = createHash("sha256").update(pat).digest("hex");
  const now = Date.now();
  const existing = qoderMachineIds.get(key);
  if (existing && existing.expiresAt > now) return existing.id;
  const id = randomUUID();
  qoderMachineIds.delete(key);
  qoderMachineIds.set(key, { id, expiresAt: now + QODER_MACHINE_ID_TTL_MS });
  for (const [candidate, value] of qoderMachineIds) {
    if (value.expiresAt <= now) qoderMachineIds.delete(candidate);
  }
  while (qoderMachineIds.size > QODER_MAX_MACHINE_IDS) {
    const oldest = qoderMachineIds.keys().next();
    if (oldest.done) break;
    qoderMachineIds.delete(oldest.value);
  }
  return id;
}

function qoderStaticHeaders(machineId: string, version = getQoderVersion()): Record<string, string> {
  const date = new Date().toUTCString();
  return {
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "5",
    "cosy-machineid": machineId,
    "cosy-clienttype": "5",
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date,
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${date}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

function transformQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

function qoderBuildCosyHeaders(
  body: Uint8Array,
  url: string,
  auth: QoderAuth,
  version = getQoderVersion(),
): Record<string, string> {
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
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: randomUUID(), info, cosyVersion: version, ideVersion: "" }),
  ).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = qoderMd5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${qoderPathSignature(url)}`);
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": "x86_64_windows",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": qoderMd5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": qoderPathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    ...(MODERN_PROFILE.sendBusinessHeaders
      ? {
          "cosy-business-product": MODERN_PROFILE.businessProduct,
          "cosy-business-type": MODERN_PROFILE.businessType,
          "cosy-business-version": version,
          "cosy-scene": MODERN_PROFILE.cosyScene,
        }
      : {}),
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date: new Date().toUTCString(),
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

async function exchangeQoderPat(
  pat: string,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
): Promise<QoderAuth> {
  const machineId = qoderMachineIdFromPat(pat);
  const encodedBody = transformQoderBody(JSON.stringify({ payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }), encodeVersion: "1" }));
  const response = await fetcher(QODER_JOB_TOKEN_URL, { method: "POST", headers: qoderStaticHeaders(machineId, version), body: encodedBody as unknown as BodyInit, signal });
  if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned invalid JSON", {}, "upstream");
  }
  if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned unexpected response", {}, "upstream");
  }
  const rec = responseBody as Record<string, unknown>;
  if (typeof rec["id"] !== "string" || typeof rec["securityOauthToken"] !== "string") {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned incomplete credentials", {}, "upstream");
  }
  return {
    userId: rec["id"] as string,
    userName: typeof rec["name"] === "string" ? (rec["name"] as string) : "",
    userType: typeof rec["userType"] === "string" ? (rec["userType"] as string) : "personal_standard",
    securityOauthToken: rec["securityOauthToken"] as string,
    refreshToken: typeof rec["refreshToken"] === "string" ? (rec["refreshToken"] as string) : "",
    machineId,
  };
}

async function callQoder(
  url: string,
  body: Record<string, unknown>,
  modelId: string,
  auth: QoderAuth,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
): Promise<Response> {
  const encoded = transformQoderBody(JSON.stringify(body));
  const modelConfig = (body["model_config"] as Record<string, unknown> | null) ?? null;
  return fetcher(url, {
    method: "POST",
    headers: {
      ...qoderBuildCosyHeaders(encoded, url, auth, version),
      ...(MODERN_PROFILE.sendModelSourceHeaders
        ? { "x-model-key": modelId, "x-model-source": typeof modelConfig?.["source"] === "string" ? (modelConfig["source"] as string) : "system" }
        : {}),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
    },
    body: encoded as unknown as BodyInit,
    signal,
  });
}

/**
 * The human-readable text out of a Qoder error envelope.
 *
 * The envelope is Qoder's own wrapper around the stream, and it does not use
 * one field for the message: the text has been seen as a nested `error`
 * object, a bare string `body`, and a top-level `message`/`msg`. The canonical
 * extractor covers the structured shapes; a string body and the top-level
 * fields cover the rest. Whatever survives is bounded the same way an upstream
 * message is, so a verbose envelope cannot blow up the public error line.
 */
function qoderEnvelopeMessage(rec: Record<string, unknown>): string {
  const structured = extractUpstreamMessage(rec["body"]);
  if (structured.length > 0) return structured;
  if (typeof rec["body"] === "string" && rec["body"].trim().length > 0 && rec["body"] !== "[DONE]")
    return rec["body"].replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return extractUpstreamMessage(rec);
}

function qoderEnvelopeToFrames(data: string): Array<{ event: string | null; data: string }> {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return [];
  const rec = envelope as Record<string, unknown>;
  if (rec["statusCodeValue"] !== undefined && rec["statusCodeValue"] !== 200) {
    const status = typeof rec["statusCodeValue"] === "number" ? (rec["statusCodeValue"] as number) : 502;
    // Qoder reports the failure inside the stream envelope rather than as an
    // HTTP status, so `mapUpstreamHttpError` never sees it. The code still comes
    // from the one canonical status table, and the details carry the same
    // evidence that function would have attached: a 401/403 is credential
    // evidence (the account is flagged, not silently retried forever) and the
    // envelope body is surfaced instead of a bare status line.
    const detail = qoderEnvelopeMessage(rec);
    throw new GatewayError(
      statusToGatewayErrorCode(status),
      status,
      detail.length > 0 ? detail : `Qoder stream envelope returned HTTP ${status}`,
      {
        providerId: QODER_PROVIDER_ID,
        providerStatus: status,
        ...(status === 401 || status === 403 ? { credentialEvidence: true } : {}),
        ...(status === 429 ? { rateLimitScope: "provider" } : {}),
      },
      "upstream",
    );
  }
  const body = rec["body"];
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body !== "string") return [];
  return [{ event: null, data: body.replace(/\r?\n/g, "") }];
}

function qoderStableHash(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(p);
  }
  return h.digest("hex").slice(0, 16);
}

function flattenCanonicalContent(content: readonly ContentPart[]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "toolResult") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
}

function qoderStableRecordId(modelId: string, messages: CanonicalRequest["messages"], maxTokens: number): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(modelId);
  for (const m of messages) {
    h.update("\0");
    h.update(m.role);
    const text = flattenCanonicalContent(m.content);
    if (text) {
      h.update("\0");
      h.update(text);
    }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function qoderRequestedMaxTokens(request: CanonicalRequest, modelConfig: QoderModelConfig): number {
  const configured = typeof modelConfig.max_output_tokens === "number" ? modelConfig.max_output_tokens : 32768;
  const controls = request.generation_controls as Record<string, unknown>;
  const requested =
    typeof controls["max_tokens"] === "number"
      ? (controls["max_tokens"] as number)
      : typeof controls["max_output_tokens"] === "number"
        ? (controls["max_output_tokens"] as number)
        : null;
  return typeof requested === "number" && requested > 0 ? Math.min(requested, configured) : configured;
}

export function buildQoderRequest(
  modelId: string,
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
): Record<string, unknown> {
  const allMessages = request.messages;
  const systemParts: string[] = [];
  if (request.system) {
    for (const p of request.system) if (p.kind === "text") systemParts.push(p.text);
  }
  if (request.instructions) {
    for (const p of request.instructions) if (p.kind === "text") systemParts.push(p.text);
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") {
      const t = flattenCanonicalContent(m.content);
      if (t) systemParts.push(t);
    }
  }
  const systemPrompt = systemParts.join("\n\n").trim();
  const qoderMessages: Array<Record<string, unknown>> = [];
  if (MODERN_PROFILE.mirrorTopLevelSystem && systemPrompt.length > 0) {
    qoderMessages.push({
      role: "system",
      content: systemPrompt,
      contents: [{ type: "text", text: systemPrompt }],
    });
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") continue;
    // Answers may live in a `user` turn (the Messages ledger re-homes them),
    // so the result scan is role-agnostic. Each result becomes its own `tool`
    // turn carrying its `tool_call_id`; any non-result content on the same turn
    // is emitted after, so nothing is duplicated or lost.
    const results = toolResultParts(m);
    if (results.length > 0) {
      for (const block of results) {
        const text = flattenCanonicalContent(
          typeof block.content === "string"
            ? [{ kind: "text", text: block.content }]
            : block.content,
        );
        qoderMessages.push({
          role: "tool",
          content: text,
          contents: [{ type: "text", text }],
          tool_call_id: block.call_id,
        });
      }
      const remaining = m.content.filter((part) => part.kind !== "toolResult");
      if (remaining.length === 0) continue;
      const flat = flattenCanonicalContent(remaining);
      qoderMessages.push({
        role: "user",
        content: flat,
        contents: [{ type: "text", text: flat }],
      });
      continue;
    }
    const flat = flattenCanonicalContent(m.content);
    qoderMessages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: flat,
      contents: [{ type: "text", text: flat }],
    });
  }
  const latestUserMessage = [...qoderMessages].reverse().find((m) => m["role"] === "user");
  const latestUserText = typeof latestUserMessage?.["content"] === "string" ? (latestUserMessage["content"] as string) : "";
  const maxTokens = qoderRequestedMaxTokens(request, modelConfig);
  const reasoning = modelConfig.is_reasoning === true;
  const sessionId = qoderStableHash("qoder-session", auth.userId, modelId);
  const recordId = qoderStableRecordId(modelId, allMessages, maxTokens);
  return {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    ...(MODERN_PROFILE.emptyAliyunUserType ? { aliyun_user_type: "" } : {}),
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: MODERN_PROFILE.mirrorTopLevelSystem ? systemPrompt : "",
    image_urls: null,
    chat_context: {
      chatPrompt: MODERN_PROFILE.mirrorTopLevelSystem ? systemPrompt : "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: modelId, is_reasoning: reasoning }, originalContent: latestUserText },
      features: [],
      text: latestUserText,
    },
    model_config: {
      key: modelId,
      display_name: modelConfig.display_name,
      is_vl: modelConfig.is_vl,
      is_reasoning: modelConfig.is_reasoning,
      max_input_tokens: modelConfig.max_input_tokens,
      max_output_tokens: modelConfig.max_output_tokens ?? 32768,
      source: modelConfig.source ?? "system",
    },
    messages: qoderMessages,
    max_tokens: maxTokens,
  };
}

// Stream transformation — decode SSE, unwrap COSY envelope, map OpenAI chat chunks to CanonicalEvent

function mapQoderFinishReason(raw: unknown): CanonicalStopReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls") return "tool_use";
  if (raw === "content_filter") return "content_filter";
  return undefined;
}

async function* qoderBodyToCanonicalEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  model: string,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  let finishReason: unknown = undefined;
  let rawUsage: Record<string, unknown> | undefined = undefined;
  let hasTerminal = false;

  for await (const sse of decodeSseEvents(body, { signal })) {
    const sseData = sse.data;
    let frames: Array<{ event: string | null; data: string }>;
    try {
      frames = qoderEnvelopeToFrames(sseData);
    } catch (e) {
      throw e;
    }
    for (const frame of frames) {
      const data = frame.data.trim();
      if (!data) continue;
      if (data === "[DONE]") {
        hasTerminal = true;
        continue;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (json["usage"] && typeof json["usage"] === "object") rawUsage = json["usage"] as Record<string, unknown>;
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      for (const choice of choices) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: delta["content"] as string },
            } as CanonicalEvent;
          }
          const reasoningText = readReasoningText(delta);
          if (typeof reasoningText === "string" && reasoningText.length > 0) {
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "reasoning", payload: null, summary: reasoningText },
            } as CanonicalEvent;
          }
          const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const fn = tc["function"] as Record<string, unknown> | undefined;
              yield {
                type: "tool_call_delta",
                sequence_number: seq++,
                call_id: (tc["id"] as string) ?? `call_${String(tc["index"] ?? 0)}`,
                name: fn?.["name"] as string | undefined,
                arguments_delta: (fn?.["arguments"] as string) ?? "",
              } as CanonicalEvent;
            }
          }
        }
        const fr = choice["finish_reason"];
        if (fr !== null && fr !== undefined) finishReason = fr;
        // Some providers send usage in choices[0].usage or top-level
        if (choice["usage"] && typeof choice["usage"] === "object") rawUsage = choice["usage"] as Record<string, unknown>;
      }
      // Some Qoder chunks carry finish_reason at top level
      if (json["finish_reason"] !== undefined) finishReason = json["finish_reason"];
    }
  }
  // If no terminal arrived, synthesize one (prevents truncation error)
  const stopReason = mapQoderFinishReason(finishReason);
  const _providerStop = typeof finishReason === "string" ? finishReason : undefined;
  void hasTerminal;
  yield {
    type: "terminal",
    sequence_number: seq++,
    state: "complete",
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    ...(_providerStop === undefined ? {} : { provider_stop_reason: _providerStop }),
    usage: usageFromProvider(rawUsage),
  } as CanonicalEvent;
}

// Model catalog — maps QODER_MODEL_CONFIGS (provider) to Cartethyia ModelDefinition

export const QODER_MODELS: readonly ModelDefinition[] = Object.entries(QODER_MODEL_CONFIGS).map(([id, cfg]) =>
  defineModel({ id, endpoint: "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1", ctx: cfg.max_input_tokens, out: cfg.max_output_tokens ?? 32768, vision: cfg.is_vl, reasoning: cfg.is_reasoning }),
);

// ProviderAdapter — manual dispatch preserving COSY encryption + envelope logic

interface QoderAdapterOptions {
  readonly fetch?: typeof fetch;
}

class QoderAdapter implements ProviderAdapter {
  readonly provider_id = QODER_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: QoderAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError("capability_unsupported", 400, `qoder supports chat only, got ${candidate.wire_family}`);
    }
    const pat = readCredentialSecret(context.credential, "Qoder PAT is required");

    const modelId = candidate.model_id || request.model;
    const modelConfig = (QODER_MODEL_CONFIGS as Record<string, QoderModelConfig>)[modelId] ?? {
      id: modelId,
      display_name: modelId,
      max_input_tokens: 180_000,
      is_vl: true,
      is_reasoning: false,
    };

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    // Outbound fetch respects SSRF binding when provided
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const fetcher: QoderFetcher = (url, init) =>
      outboundFetch(url, { ...init, signal: lifecycle.signal } as RequestInit) as Promise<Response>;

    try {
      const version = await resolveQoderVersion(outboundFetch, lifecycle.signal);
      const auth = await exchangeQoderPat(pat, lifecycle.signal, fetcher, version);
      const qoderBody = buildQoderRequest(modelId, request, modelConfig, auth);
      const url =
        candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
          ? candidate.endpoint_path
          : MODERN_PROFILE.chatUrl;

      const response = await callQoder(url, qoderBody, modelId, auth, lifecycle.signal, fetcher, version);
      if (!response.ok) throw await mapUpstreamHttpError(response, "qoder");
      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body", {}, "upstream");
      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();
      yield* qoderBodyToCanonicalEvents(response.body as ReadableStream<Uint8Array>, lifecycle.signal, request.model);
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

export function createQoderAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter(options);
}
