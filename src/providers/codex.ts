import { AbortCoordinator } from "../open-sse/transport/abort-coordinator";
import { ProviderAdapterError, readUpstreamError, toProviderCallError } from "../open-sse/transport/errors";
import { capabilitiesOf, createModelCatalog, modelOf } from "../open-sse/transport/catalog";
import { decodeSseEvents, lineLimit, parseSseData } from "../open-sse/transport/sse-decoder";
import { executeFetch } from "../open-sse/transport/fetch";
import { mapSseStream } from "../open-sse/transport/stream-mapper";
import { isRecord } from "../application/protocols";
import { createOpenAIResponsesStreamMapper } from "../open-sse/transport/protocols/openai";
import { buildResponsesPayload } from "../open-sse/translate/request/openai-responses";
import { resolveModelCapabilities } from "../open-sse/translate/capabilities";
import { mapResponsesUsage } from "../open-sse/translate/response/openai";
import { runtimeMemoryLimits } from "../traffic/limits";
import type {
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";

/**
 * OpenAI Codex — the ChatGPT Codex backend
 * (https://chatgpt.com/backend-api/codex/responses) authenticated with an
 * OAuth access token whose JWT payload carries the ChatGPT account identity
 * (`chatgpt-account-id`). Speaks the OpenAI Responses wire format; the Codex
 * backend rejects sampling controls and output-token caps, so those are
 * stripped and the request is forced to stream. The account id is extracted
 * from the access-token JWT so no out-of-band account metadata is required.
 */
const CODEX_SURFACES: readonly Surface[] = ["openai-responses", "images"];
const CODEX_TEXT_SURFACES: readonly Surface[] = ["openai-responses"];
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_VERSION = "0.144.1";
const CODEX_ORIGINATOR = "pi";
const CODEX_AUTH_PATH = "https://api.openai.com/auth";

const CODEX_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5.6-sol", "GPT 5.6 Sol", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.6-terra", "GPT 5.6 Terra", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.6-luna", "GPT 5.6 Luna", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.5", "GPT 5.5", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.4", "GPT 5.4", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.4-mini", "GPT 5.4 Mini", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", capabilitiesOf({ surfaces: CODEX_TEXT_SURFACES, reasoning: true, images: true, search: true })),
  modelOf("gpt-5.5-image", "GPT 5.5 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gpt-5.4-image", "GPT 5.4 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gpt-5.3-image", "GPT 5.3 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
];

const CODEX_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true, search: true });

function base64Decode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

interface CodexCredential {
  readonly accessToken: string;
  readonly accountId?: string;
}

function codexAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64Decode(parts[1] ?? "")) as Record<string, unknown>;
    const auth = payload[CODEX_AUTH_PATH];
    if (isRecord(auth)) {
      const id = nonEmpty(auth.chatgpt_account_id);
      if (id) return id;
    }
    return nonEmpty(payload.chatgpt_account_id) ?? nonEmpty(payload.account_id) ?? null;
  } catch {
    return null;
  }
}

/** Accepts both the durable OAuth bundle and a raw Codex access token. */
function codexCredential(value: string): CodexCredential | null {
  let accessToken = value.trim();
  let accountId: string | undefined;
  if (accessToken.startsWith("{")) {
    try {
      const parsed = JSON.parse(accessToken) as unknown;
      if (isRecord(parsed)) {
        accessToken = nonEmpty(parsed.accessToken) ?? nonEmpty(parsed.access_token) ?? nonEmpty(parsed.access) ?? "";
        accountId = nonEmpty(parsed.providerAccountId) ?? nonEmpty(parsed.accountId) ?? nonEmpty(parsed.account_id) ?? nonEmpty(parsed.chatgpt_account_id);
      }
    } catch {
      return null;
    }
  }
  if (accessToken.length === 0) return null;
  return { accessToken, accountId: accountId ?? codexAccountId(accessToken) ?? undefined };
}

async function readCodexNonStream(response: Response, coordinator: AbortCoordinator, request: ProviderRequest["request"]): Promise<ProviderOutput> {
  if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex returned an empty stream body", routeScope: "provider" });
  let completed: Record<string, unknown> | null = null;
  let text = "";
  let reasoning = "";
  const calls = new Map<string, { name: string; arguments: string }>();
  for await (const sse of decodeSseEvents({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs })) {
    if (sse.data === "[DONE]") continue;
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) continue;
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") text += parsed.delta;
    if ((parsed.type === "response.reasoning_text.delta" || parsed.type === "response.reasoning_summary_text.delta") && typeof parsed.delta === "string") reasoning += parsed.delta;
    if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item?.type === "function_call") {
        const callId = nonEmpty(item.call_id) ?? nonEmpty(item.id);
        if (callId !== undefined) calls.set(callId, { name: nonEmpty(item.name) ?? "", arguments: typeof item.arguments === "string" ? item.arguments : calls.get(callId)?.arguments ?? "" });
      }
    }
    if (parsed.type === "response.function_call_arguments.delta" && typeof parsed.delta === "string") {
      const callId = nonEmpty(parsed.item_id) ?? nonEmpty(parsed.call_id);
      if (callId !== undefined) {
        const previous = calls.get(callId) ?? { name: "", arguments: "" };
        calls.set(callId, { ...previous, arguments: previous.arguments + parsed.delta });
      }
    }
    if ((parsed.type === "response.completed" || parsed.type === "response.done") && isRecord(parsed.response)) completed = parsed.response;
  }
  if (completed === null) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex stream ended without a completed response", routeScope: "provider" });
  const existingOutput = Array.isArray(completed.output) ? completed.output.filter(isRecord) : [];
  const additions: Record<string, unknown>[] = [];
  const hasReasoning = existingOutput.some((item) => item.type === "reasoning");
  const hasText = existingOutput.some((item) => {
    if (item.type !== "message" || !Array.isArray(item.content)) return false;
    return item.content.some((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0);
  });
  if (reasoning.length > 0 && !hasReasoning) additions.push({ type: "reasoning", id: `${String(completed.id ?? "resp")}-reasoning`, summary: [{ type: "summary_text", text: reasoning }] });
  if (text.length > 0 && !hasText) additions.push({ type: "message", id: `${String(completed.id ?? "resp")}-message`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const [callId, call] of calls) {
    if (!existingOutput.some((item) => item.type === "function_call" && item.call_id === callId)) {
      additions.push({ type: "function_call", id: callId, call_id: callId, name: call.name, arguments: call.arguments, status: "completed" });
    }
  }
  const body: Record<string, unknown> = additions.length > 0 ? { ...completed, output: [...existingOutput, ...additions] } : { ...completed };
  if (text.length > 0 && (typeof body.output_text !== "string" || body.output_text.length === 0)) body.output_text = text;
  const usageRecord = isRecord(body.usage) ? body.usage : null;
  return { mode: "non_stream", body, usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined };
}

const CODEX_IMAGE_MODEL_SUFFIX = "-image";
const CODEX_IMAGE_VERSION = "0.136.0";
const CODEX_IMAGE_ORIGINATOR = "codex_cli_rs";

function codexImageModelId(modelId: string): string {
  return modelId.endsWith(CODEX_IMAGE_MODEL_SUFFIX)
    ? modelId.slice(0, -CODEX_IMAGE_MODEL_SUFFIX.length)
    : modelId;
}

/** Builds the Codex image-generation Responses payload expected by ChatGPT accounts. */
export function buildCodexImagePayload(request: ProviderRequest["request"], modelId: string): Record<string, unknown> {
  const payload = buildResponsesPayload(request, { includeContextManagement: false, upstreamModel: codexImageModelId(modelId) });
  payload.model = codexImageModelId(modelId);
  payload.instructions = "";
  payload.tools = [{ type: "image_generation", output_format: "png" }];
  payload.tool_choice = "auto";
  payload.parallel_tool_calls = false;
  payload.prompt_cache_key = crypto.randomUUID();
  payload.stream = true;
  payload.store = false;
  payload.reasoning = null;
  return payload;
}

async function readCodexImageStream(response: Response, coordinator: AbortCoordinator, request: ProviderRequest["request"]): Promise<ProviderOutput> {
  if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex returned an empty image stream body", routeScope: "provider" });
  let imageB64: string | null = null;
  let revisedPrompt: string | undefined;
  for await (const sse of decodeSseEvents({ body: response.body, coordinator, maxLineBytes: Math.max(lineLimit(request.limits), runtimeMemoryLimits.streamEventBytes), maxEventBytes: runtimeMemoryLimits.streamEventBytes, idleTimeoutMs: request.limits.idleTimeoutMs })) {
    if (sse.data === "[DONE]") continue;
    const parsed = parseSseData(sse.data);
    if (!isRecord(parsed)) continue;
    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item?.type === "image_generation_call" && typeof item.result === "string") {
      imageB64 = item.result;
      if (typeof item.revised_prompt === "string") revisedPrompt = item.revised_prompt;
    }
    const completed = isRecord(parsed.response) ? parsed.response : null;
    if (completed !== null && Array.isArray(completed.output)) {
      for (const outputItem of completed.output) {
        if (!isRecord(outputItem) || outputItem.type !== "image_generation_call" || typeof outputItem.result !== "string") continue;
        imageB64 = outputItem.result;
        if (typeof outputItem.revised_prompt === "string") revisedPrompt = outputItem.revised_prompt;
      }
    }
  }
  if (imageB64 === null) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex did not return an image. A ChatGPT Plus or Pro account may be required.", retryable: false, routeScope: "provider" });
  const entry: Record<string, unknown> = { b64_json: imageB64 };
  if (revisedPrompt !== undefined) entry.revised_prompt = revisedPrompt;
  return { mode: "non_stream", body: { created: Math.floor(Date.now() / 1000), data: [entry] } };
}

async function callCodexImageWire(input: ProviderRequest, url: string, headers: Record<string, string>): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
  try {
    const response = await executeFetch(url, { method: "POST", headers: { ...headers, accept: "text/event-stream, application/json" }, body: JSON.stringify(buildCodexImagePayload(request, input.target.upstreamModelId)) }, coordinator, network, input.capture);
    if (!response.ok) throw await readUpstreamError(response);
    return await readCodexImageStream(response, coordinator, request);
  } finally {
    coordinator.dispose();
  }
}


/** Codex is the OAuth-gated ChatGPT Codex Responses transport. */
export class CodexAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "codex",
    displayName: "Codex ChatGPT",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(CODEX_MODELS);
  readonly capabilities: ProviderCaps = { ...CODEX_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-responses" && input.target.surface !== "images") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support the OpenAI Responses surface`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Codex OAuth access token is required.", statusCode: 401, routeScope: "account" });
    }
    const credential = codexCredential(input.credential);
    const accountId = credential?.accountId ?? null;
    if (credential === null || accountId === null) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "Codex OAuth credential is missing its ChatGPT account identity.", statusCode: 401, routeScope: "account" });
    }
    if (input.target.surface === "images") {
      return callCodexImageWire(input, `${CODEX_BASE_URL}/codex/responses`, {
        "content-type": "application/json",
        authorization: `Bearer ${credential.accessToken}`,
        "chatgpt-account-id": accountId,
        "openai-beta": "responses=experimental",
        originator: CODEX_IMAGE_ORIGINATOR,
        version: CODEX_IMAGE_VERSION,
        "user-agent": `codex_cli_rs/${CODEX_IMAGE_VERSION}`,
        session_id: crypto.randomUUID(),
        "x-client-request-id": crypto.randomUUID(),
      });
    }
    const { request, signal, network } = input;
    // Codex rejects sampling controls and output-token caps with 400; the
    // native client lets the Codex backend choose these values.
    const capabilities = resolveModelCapabilities(this.capabilities, this.models.get(input.target.modelId), input.target.surface);
    const payload = buildResponsesPayload(request, { includeContextManagement: false, upstreamModel: input.target.upstreamModelId, explicitCache: capabilities.cache.breakpoints, capabilities });
    delete payload.temperature;
    delete payload.top_p;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    payload.store = false;
    payload.stream = true;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": accountId,
      "openai-beta": "responses=experimental",
      originator: CODEX_ORIGINATOR,
      version: CODEX_VERSION,
      "user-agent": `codex-cli/${CODEX_VERSION}`,
    };
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, firstByteTimeoutMs: request.limits.firstByteTimeoutMs, idleTimeoutMs: request.limits.idleTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${CODEX_BASE_URL}/codex/responses`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) return await readCodexNonStream(response, coordinator, request);
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream(
        { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
        createOpenAIResponsesStreamMapper(),
      ) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

