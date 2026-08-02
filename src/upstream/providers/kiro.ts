import type { RouteTarget } from "../../routing/types";
import type { StreamEvent } from "../bridge";
import { materializeFromStream, materializedToChatResponse } from "../result";
import { ProviderCallError } from "./errors";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { kiroModelCatalog } from "./kiro-models";

const DEFAULT_PROFILE_ARNS: Record<string, string> = {
  "builder-id": "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
  social: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
};

const ENDPOINTS = [
  "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
  "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
] as const;

function defaultProfileArn(authMethod: string | undefined): string | undefined {
  if (authMethod === "api_key" || authMethod === "external_idp") return undefined;
  if (authMethod === "google" || authMethod === "github" || authMethod === "social") return DEFAULT_PROFILE_ARNS.social;
  return DEFAULT_PROFILE_ARNS["builder-id"];
}

function orderedEndpoints(metadata: Record<string, string>): string[] {
  const region = metadata.region?.trim() || "us-east-1";
  const regionalized = ENDPOINTS.map((url) => region === "us-east-1" ? url : url.replace(/([a-z]+)\\.us-east-1\\.amazonaws\\.com/, `$1.${region}.amazonaws.com`));
  const authMethod = metadata.authMethod;
  if (authMethod !== "idc" && authMethod !== "external_idp" && authMethod !== "api_key") return regionalized;
  const amazon = regionalized.filter((url) => url.includes("amazonaws.com"));
  const gateway = regionalized.filter((url) => !url.includes("amazonaws.com"));
  return [...amazon, ...gateway];
}

type ChatMessage = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown };
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : "").join("");
}
function buildPayload(body: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : [];
  const system = typeof body.system === "string" ? body.system : undefined;
  const normal = messages.filter((message) => message.role !== "system");
  const current = normal.at(-1);
  const history = normal.slice(0, -1).map((message) => ({
    userInputMessage: {
      content: textOf(message.content),
      modelId,
      origin: message.role === "assistant" ? "AI_EDITOR" : "AI_EDITOR",
    },
  }));
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      history,
      currentMessage: {
        userInputMessage: {
          content: textOf(current?.content),
          modelId,
          origin: "AI_EDITOR",
        },
      },
    },
    agentMode: "vibe",
    ...(system ? { systemPrompt: system } : {}),
    inferenceConfig: {
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : 128000,
      temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
      topP: typeof body.top_p === "number" ? body.top_p : 0.9,
    },
  };
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string" && error.trim()) return error.trim().slice(0, 500);
      if (error !== null && typeof error === "object" && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.trim().slice(0, 500);
      }
      if (typeof record.message === "string" && record.message.trim()) return record.message.trim().slice(0, 500);
    }
  } catch {
    // Preserve the status when the provider returns a non-JSON error page.
  }
  return text.trim().slice(0, 500);
}

function readString(value: unknown, key: string): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[key] === "string" ? (value as Record<string, unknown>)[key] as string : undefined;
}

async function* decodeKiroStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let finished = false;
  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const next = new Uint8Array(buffer.length + chunk.value.length);
    next.set(buffer); next.set(chunk.value, buffer.length); buffer = next;
    while (buffer.length >= 16) {
      const total = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
      const headersLength = new DataView(buffer.buffer, buffer.byteOffset + 4, 4).getUint32(0);
      if (total < 16 || total > buffer.length) break;
      const payloadStart = 12 + headersLength;
      const payloadEnd = total - 4;
      if (payloadStart > payloadEnd) { buffer = buffer.slice(total); continue; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(buffer.slice(payloadStart, payloadEnd))); } catch { buffer = buffer.slice(total); continue; }
      buffer = buffer.slice(total);
      if (!payload || typeof payload !== "object") continue;
      const event = payload as Record<string, unknown>;
      const kind = Object.keys(event)[0];
      const value = event[kind ?? ""];
      const content = readString(value, "content");
      const reasoning = readString(value, "reasoningContent") ?? readString(value, "text");
      if (kind === "assistantResponseEvent" && content) yield { type: "text_delta", text: content };
      else if (kind === "reasoningContentEvent" && reasoning) yield { type: "thinking_delta", text: reasoning };
      else if (kind === "codeEvent" && content) yield { type: "text_delta", text: content };
      else if (kind === "messageStopEvent") { yield { type: "finish", stopReason: "end_turn" }; finished = true; break; }
      else if (kind === "contextUsageEvent" || kind === "meteringEvent" || kind === "metricsEvent") {
        const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const metrics = raw.metricsEvent && typeof raw.metricsEvent === "object" && !Array.isArray(raw.metricsEvent) ? raw.metricsEvent as Record<string, unknown> : raw;
        const input = Number(metrics.inputTokens ?? metrics.input_tokens ?? 0) || 0;
        const output = Number(metrics.outputTokens ?? metrics.output_tokens ?? 0) || 0;
        const reasoningTokens = Number(metrics.reasoningTokens ?? metrics.reasoning_tokens ?? 0) || 0;
        const cacheReadTokens = Number(metrics.cacheReadInputTokens ?? metrics.cache_read_input_tokens ?? 0) || 0;
        const cacheWriteTokens = Number(metrics.cacheCreationInputTokens ?? metrics.cache_creation_input_tokens ?? 0) || 0;
        if (input || output || reasoningTokens || cacheReadTokens || cacheWriteTokens) yield { type: "usage", inputTokens: input, outputTokens: output, reasoningTokens, cacheReadTokens, cacheWriteTokens };
      }
    }
  }
  if (!finished) yield { type: "finish", stopReason: "end_turn" };
}

class KiroProvider implements Provider {
  readonly id = "kiro" as const;
  readonly display = {
    name: "Kiro AI",
    icon: "kiro",
    authKind: "oauth" as const,
    authHint: "Connect AWS Builder ID or IAM Identity Center with Kiro OAuth, or import an existing Kiro token.",
    credentialUrl: "https://kiro.dev",
  };
  readonly models = kiroModelCatalog;
  resolveTarget(modelId: string): RouteTarget { return { provider: "kiro", modelId, surface: "openai-chat", credential: "oauth", weight: 1 }; }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Kiro supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "Kiro requires an OAuth access token.");
    const body = request.body;
    const metadata = credential.providerMetadata ?? {};
    const payload = buildPayload(body, target.modelId);
    const profileArn = metadata.profileArn ?? defaultProfileArn(metadata.authMethod);
    if (profileArn) (payload as Record<string, unknown>).profileArn = profileArn;
    const fetcher = proxy ? buildProxyFetcher(proxy) : fetch;
    let response: Response | undefined;
    let lastError: unknown;
    for (const url of orderedEndpoints(metadata)) {
      try {
        response = await fetcher(url, { method: "POST", signal, headers: {
            authorization: `Bearer ${credential.value}`,
            "content-type": "application/json",
            accept: "application/vnd.amazon.eventstream",
            "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
            "user-agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
            "x-amz-user-agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
            "amz-sdk-request": "attempt=1; max=3",
            "amz-sdk-invocation-id": crypto.randomUUID(),
            ...(metadata.authMethod === "api_key" ? { tokentype: "API_KEY" } : {}),
            ...(metadata.authMethod === "external_idp" ? { TokenType: "EXTERNAL_IDP" } : {}),
          }, body: JSON.stringify(payload) });
        if (response.ok) break;
        const detail = await responseErrorMessage(response);
        const kind = response.status === 401 || response.status === 403 ? "authentication" : "unavailable";
        lastError = new ProviderCallError(response.status, kind, detail ? `Kiro upstream returned ${response.status}: ${detail}` : `Kiro upstream returned ${response.status}.`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (error) { lastError = error; }
    }
    if (!response?.ok) throw lastError instanceof ProviderCallError ? lastError : new ProviderCallError(502, "unavailable", "Kiro upstream request failed.");
    if (!response.body) throw new ProviderCallError(502, "unavailable", "Kiro returned an empty response.");
    const events = decodeKiroStream(response.body);
    if (body.stream === true) return { type: "stream", events };
    const materialized = await materializeFromStream(events);
    return { type: "json", body: materializedToChatResponse(materialized, target.modelId) as unknown as Record<string, unknown> };
  }
}

export const kiroProvider = new KiroProvider();
export { decodeKiroStream, buildPayload };
