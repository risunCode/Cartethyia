import { AbortCoordinator, ProviderAdapterError, capabilitiesOf, executeFetch, isRecord, messageText, readUpstreamError, toProviderCallError } from "./shared";
import { kiroModelCatalog, kiroModels } from "./kiro-models";
import { parseKiroCredential } from "../auth/oauth/kiro";
import type {
  ContextStats,
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  ProviderUsage,
  RouteTarget,
  StreamEvent,
  TokenCountInput,
} from "../domain/contracts";
import type { NormalizedMessage } from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";

/**
 * Kiro AI adapter — https://kiro.dev/generateAssistantResponse.
 *
 * Kiro speaks the AWS CodeWhisperer Streaming event-stream protocol: the
 * request is an OpenAI-chat-ish `conversationState` payload, the response is
 * a binary-framed event stream (`assistantResponseEvent` deltas,
 * `reasoningContentEvent` thoughts, `codeEvent` text, `messageStopEvent`
 * terminal, metering usage), and authentication is an OAuth bearer token
 * (builder-id / IDC / external IdPs). Multiple regional endpoints are tried
 * in order; gateway and Amazon endpoints are ordered differently for
 * API-key / IDC / external-idp auth methods, mirroring the legacy adapter.
 */

const KIRO_SURFACES: readonly ProviderSurface[] = ["openai-chat"];

const DEFAULT_PROFILE_ARNS: Record<string, string> = {
  "builder-id": "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
  social: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};

const ENDPOINTS = [
  "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
] as const;

const KIRO_MAX_TOKENS_FALLBACK = 128_000;
const KIRO_THINKING_BUDGET = 16_000;

/** Maximum bytes accumulated in the event-stream decode buffer before the
 * stream is rejected as malformed. Matches `MAX_JSON_BODY_BYTES` — a
 * well-behaved CodeWhisperer stream never buffers a full MiB of pending
 * frames, so exceeding this cap means the upstream is malicious or buggy. */
const KIRO_MAX_BUFFER_BYTES = 1_048_576;

const KIRO_FALLBACK_CAPABILITIES: ProviderCapabilities = capabilitiesOf({ surfaces: KIRO_SURFACES, reasoning: true, images: true });

function resolveKiroModel(modelId: string): { readonly upstreamModel: string; readonly thinkingVariant: boolean } {
  let upstreamModel = modelId;
  let thinkingVariant = false;
  // Catalog aliases are synthetic; Kiro receives the base model id and the
  // thinking alias is expressed through the system prompt trigger.
  if (upstreamModel.endsWith("-agentic")) upstreamModel = upstreamModel.slice(0, -"-agentic".length);
  if (upstreamModel.endsWith("-thinking")) {
    upstreamModel = upstreamModel.slice(0, -"-thinking".length);
    thinkingVariant = true;
  }
  return { upstreamModel, thinkingVariant };
}

function buildThinkingSystemPrefix(): string {
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${KIRO_THINKING_BUDGET}</max_thinking_length>`;
}

function defaultProfileArn(authMethod: string | undefined): string | undefined {
  if (authMethod === "api_key" || authMethod === "external_idp") return undefined;
  if (authMethod === "google" || authMethod === "github" || authMethod === "social") return DEFAULT_PROFILE_ARNS.social;
  return DEFAULT_PROFILE_ARNS["builder-id"];
}

function orderedEndpoints(region: string, authMethod: string | undefined): string[] {
  const normalized = region.trim() || "us-east-1";
  const regionalized = ENDPOINTS.map((url) =>
    normalized === "us-east-1" ? url : url.replace(/([a-z]+)\.us-east-1\.amazonaws\.com/, `$1.${normalized}.amazonaws.com`),
  );
  // IDC / external-IdP / API-key auth prefers the Amazon-hosted endpoints
  // over the kiro.dev gateway (legacy ordering).
  if (authMethod !== "idc" && authMethod !== "external_idp" && authMethod !== "api_key") return regionalized;
  const amazon = regionalized.filter((url) => url.includes("amazonaws.com"));
  const gateway = regionalized.filter((url) => !url.includes("amazonaws.com"));
  return [...amazon, ...gateway];
}

/** Builds the CodeWhisperer `conversationState` payload from a normalized request. */
export function buildKiroPayload(request: NormalizedProviderRequest, modelId: string): Record<string, unknown> {
  const { upstreamModel, thinkingVariant } = resolveKiroModel(modelId);
  const systemParts: string[] = [];
  if (request.reasoning === "enabled" || (request.reasoning === "default" && thinkingVariant)) {
    systemParts.push(buildThinkingSystemPrefix());
  }
  const normal: NormalizedMessage[] = [];
  for (const message of request.messages) {
    const text = messageText(message);
    if (message.role === "system" || message.role === "developer") {
      if (text.trim().length > 0) systemParts.push(text);
      continue;
    }
    normal.push(message);
  }
  const current = normal.at(-1);
  const history = normal.slice(0, -1).map((message) => ({
    userInputMessage: { content: messageText(message), modelId: upstreamModel, origin: "AI_EDITOR" },
  }));
  const currentMessage = current !== undefined ? { userInputMessage: { content: messageText(current), modelId: upstreamModel, origin: "AI_EDITOR" } } : { userInputMessage: { content: "", modelId: upstreamModel, origin: "AI_EDITOR" } };
  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      history,
      currentMessage,
    },
    agentMode: "vibe",
    inferenceConfig: {
      maxTokens: request.maxOutputTokens ?? KIRO_MAX_TOKENS_FALLBACK,
      temperature: 0.7,
      topP: 0.9,
    },
  };
  if (systemParts.length > 0) payload.systemPrompt = systemParts.join("\n");
  return payload;
}

function kiroHeaders(accessToken: string, authMethod: string | undefined): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/vnd.amazon.eventstream",
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "user-agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
    "x-amz-user-agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    ...(authMethod === "api_key" ? { tokentype: "API_KEY" } : {}),
    ...(authMethod === "external_idp" ? { TokenType: "EXTERNAL_IDP" } : {}),
  };
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function eventContent(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => eventContent(item, depth + 1)).filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["content", "text", "outputText", "completion", "delta", "message", "response", "assistantResponse"] as const) {
    const text = eventContent(value[key], depth + 1);
    if (text !== undefined) return text;
  }
  return undefined;
}

function usageNumber(record: Record<string, unknown>, camel: string, snake: string): number | null {
  const value = record[camel] ?? record[snake];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapKiroUsage(value: unknown): ProviderUsage | null {
  if (!isRecord(value)) return null;
  const metrics = isRecord(value.metricsEvent) ? value.metricsEvent : value;
  const inputTokens = usageNumber(metrics, "inputTokens", "input_tokens");
  const outputTokens = usageNumber(metrics, "outputTokens", "output_tokens");
  const reasoningTokens = usageNumber(metrics, "reasoningTokens", "reasoning_tokens");
  const cacheReadTokens = usageNumber(metrics, "cacheReadInputTokens", "cache_read_input_tokens");
  const cacheWriteTokens = usageNumber(metrics, "cacheCreationInputTokens", "cache_creation_input_tokens");
  if (inputTokens === null && outputTokens === null && reasoningTokens === null && cacheReadTokens === null && cacheWriteTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheReadTokens,
    cacheWriteTokens,
    source: "provider",
  };
}

/**
 * Decodes the CodeWhisperer binary event-stream into application
 * StreamEvents. Deltas map to thinking/text deltas, metering events map to a
 * provider usage event, and a terminal `message_stop` is always emitted (from
 * `messageStopEvent` or synthesized at EOF). The coordinator's lifetime is
 * owned by this generator and disposed on exit.
 */
export async function* decodeKiroStream(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let terminalEmitted = false;
  try {
    while (!terminalEmitted) {
      if (coordinator.signal.aborted) {
        throw new ProviderAdapterError({ kind: "client_aborted", message: "Kiro stream aborted", routeScope: null });
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      const next = new Uint8Array(buffer.length + chunk.value.length);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
      if (buffer.length > KIRO_MAX_BUFFER_BYTES) {
        throw new ProviderAdapterError({ kind: "stream_truncated", message: "Kiro event-stream buffer exceeded the 1 MiB cap", retryable: false, routeScope: "provider" });
      }
      while (buffer.length >= 16) {
        const total = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        const headersLength = new DataView(buffer.buffer, buffer.byteOffset + 4, 4).getUint32(0);
        if (total < 16 || total > buffer.length) break;
        const payloadStart = 12 + headersLength;
        const payloadEnd = total - 4;
        if (payloadStart > payloadEnd) {
          buffer = buffer.slice(total);
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(buffer.slice(payloadStart, payloadEnd)));
        } catch {
          buffer = buffer.slice(total);
          continue;
        }
        buffer = buffer.slice(total);
        if (!isRecord(payload)) continue;
        const kind = Object.keys(payload)[0] ?? "";
        const value = payload[kind ?? ""];
        const content = eventContent(value);
        const reasoning = readString(value, "reasoningContent") ?? readString(value, "text");
        if ((kind === "assistantResponseEvent" || kind === "codeEvent" || kind === "content") && content) yield { type: "text_delta", text: content };
        else if (kind === "reasoningContentEvent" && reasoning) yield { type: "thinking_delta", text: reasoning };
        else if (kind === "messageStopEvent" || kind === "stopReason") {
          yield { type: "message_stop", reason: kind === "stopReason" && value === "MAX_TOKENS" ? "length" : "completed" };
          terminalEmitted = true;
          break;
        } else if (kind === "contextUsageEvent" || kind === "meteringEvent" || kind === "metricsEvent") {
          const usage = mapKiroUsage(value);
          if (usage !== null) yield { type: "usage", usage };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
    coordinator.dispose();
  }
  if (!terminalEmitted) yield { type: "message_stop", reason: "completed" };
}

/** Materializes a Kiro event stream into an OpenAI Chat Completions body for non-stream callers. */
export async function materializeKiroEvents(events: AsyncIterable<StreamEvent>, model: string): Promise<Record<string, unknown>> {
  let content = "";
  let reasoning = "";
  let usage: ProviderUsage | null = null;
  let finishReason: "length" | "stop" = "stop";
  for await (const event of events) {
    if (event.type === "thinking_delta") reasoning += event.text;
    else if (event.type === "text_delta") content += event.text;
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop" && event.reason === "length") finishReason = "length";
  }
  const message: Record<string, unknown> = { role: "assistant", content: content.length > 0 ? content : null };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  return {
    id: `chatcmpl-kiro-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage !== null
      ? { usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } }
      : {}),
  };
}

/** Kiro AI — OAuth-authenticated CodeWhisperer event-stream gateway. */
export class KiroAdapter implements ProviderAdapter {
  readonly metadata: ProviderMetadata = { id: "kiro", displayName: "Kiro AI", protocol: "openai", credentialKind: "oauth" };
  readonly models: ProviderModelCatalog = kiroModels;
  readonly capabilities: ProviderCapabilities = { ...KIRO_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    if (!KIRO_SURFACES.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    return { providerId: this.metadata.id, modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    }
    const bundle = parseKiroCredential(input.credential);
    const accessToken = bundle?.accessToken ?? (input.credential.length > 0 ? input.credential : "");
    if (accessToken.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "Kiro requires an OAuth access token.", statusCode: 401, routeScope: "account" });
    }
    const { request, signal, network } = input;
    const payload = buildKiroPayload(request, input.target.modelId);
    const profileArn = bundle?.profileArn ?? defaultProfileArn(bundle?.authMethod);
    if (profileArn) payload.profileArn = profileArn;
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      let response: Response | undefined;
      let lastError: unknown;
      for (const url of orderedEndpoints(bundle?.region ?? "", bundle?.authMethod)) {
        try {
          response = await executeFetch(url, { method: "POST", headers: kiroHeaders(accessToken, bundle?.authMethod), body: JSON.stringify(payload) }, coordinator, network);
          if (response.ok) break;
          try {
            await readUpstreamError(response);
          } catch (error) {
            lastError = error;
            const status = error instanceof ProviderAdapterError ? error.statusCode : null;
            // Non-retryable client errors are not retried on the next endpoint.
            if (status !== null && status >= 400 && status < 500 && status !== 429) break;
          }
        } catch (error) {
          lastError = error;
          if (coordinator.signal.aborted) throw error;
        }
      }
      if (response === undefined || !response.ok) {
        throw lastError instanceof ProviderAdapterError
          ? lastError
          : new ProviderAdapterError({ kind: "provider_unavailable", message: "Kiro upstream request failed.", statusCode: 502, retryable: true, routeScope: "provider" });
      }
      if (response.body === null) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Kiro returned an empty response.", routeScope: "provider" });
      }
      const events = decodeKiroStream(response.body, coordinator);
      if (request.stream) {
        streamHandedOff = true;
        return { mode: "stream", events };
      }
      streamHandedOff = true;
      return { mode: "non_stream", body: await materializeKiroEvents(events, input.target.modelId) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

/** Catalog export in the shared convention (an array of models). */
export const kiroCatalog = kiroModelCatalog;