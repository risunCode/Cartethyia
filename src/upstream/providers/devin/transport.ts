import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ChatMessageRequestType, GetChatMessageRequestSchema, GetChatMessageResponseSchema } from "./generated/exa/api_server_pb/api_server_pb";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "./generated/exa/auth_pb/auth_pb";
import {
  ChatMessageSource,
  CompletionConfigurationSchema,
  MetadataSchema,
  StopReason,
  type CompletionConfiguration,
  type Metadata,
} from "./generated/exa/codeium_common_pb/codeium_common_pb";
import {
  ChatMessagePromptSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  PromptCacheOptionsSchema,
  type ChatMessagePrompt,
} from "./generated/exa/chat_pb/chat_pb";
import type { OpenAIChatMessage } from "../../../translate/types";
import type { StreamEvent } from "../../bridge";
import { ProviderCallError, extractUpstreamErrorMessage } from "../index";
import { flattenMessageText } from "../../../shared/text-utils";
import { COMPRESSED_FLAG, decompressPayload, parseConnectTrailer, readConnectFrames } from "./connect";

const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];
const DEVIN_BASE_URL = "https://server.codeium.com";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

export interface DevinProfileHeaders extends Record<string, string> {
  "content-type": string;
  "connect-protocol-version": string;
  accept: string;
}

export interface DevinChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface DevinAuthMetadata {
  userJwt: string;
  baseUrl: string;
}

/** Builds the protocol headers used for Devin Connect API calls. */
export function buildConnectHeaders(): DevinProfileHeaders {
  return {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    accept: "application/connect+proto",
  };
}

/** Normalizes either accepted Devin credential form into the upstream session token format. */
export function normalizeDevinSessionToken(apiKey: string): string {
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/** Exchanges a Devin session token for the user JWT required by the chat API. */
export async function fetchDevinAuthMetadata(
  sessionToken: string,
  signal?: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<DevinAuthMetadata> {
  const apiKey = normalizeDevinSessionToken(sessionToken);
  const request = create(GetUserJwtRequestSchema, {
    metadata: create(MetadataSchema, {
      apiKey,
      ideName: "windsurf",
      ideVersion: DEVIN_IDE_VERSION,
      extensionName: "windsurf",
      extensionVersion: DEVIN_EXTENSION_VERSION,
      locale: "en",
    }),
  });

  const res = await fetcher(`${DEVIN_BASE_URL}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
    body: toBinary(GetUserJwtRequestSchema, request),
    signal,
  });

  const payload = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    // Connect-RPC returns a JSON error body on failure even though the
    // success path is protobuf, so the raw bytes already read above decode
    // as text just fine here.
    const upstreamMessage = extractUpstreamErrorMessage(new TextDecoder().decode(payload));
    throw new ProviderCallError(
      res.status >= 400 && res.status < 500 ? 401 : 502,
      res.status >= 400 && res.status < 500 ? "authentication" : "unavailable",
      upstreamMessage ?? "Devin authentication request failed."
    );
  }

  let response: { userJwt: string; customApiServerUrl: string };
  try {
    response = fromBinary(GetUserJwtResponseSchema, payload);
  } catch {
    try {
      response = fromBinary(GetUserJwtResponseSchema, Bun.gunzipSync(payload));
    } catch {
      throw new ProviderCallError(502, "malformed_response", "Devin auth response could not be decoded.");
    }
  }

  if (!response.userJwt) {
    throw new ProviderCallError(401, "authentication", "Devin auth response did not contain a user JWT.");
  }

  return {
    userJwt: response.userJwt,
    baseUrl: resolveDevinBaseUrl(response.customApiServerUrl),
  };
}

/** Builds a Connect-encoded Devin chat request from an OpenAI Chat-shaped body. */
export function buildDevinChatRequest(
  sessionToken: string,
  userJwt: string,
  modelId: string,
  body: Record<string, unknown>,
  baseUrl = DEVIN_BASE_URL
): DevinChatRequest {
  const apiKey = normalizeDevinSessionToken(sessionToken);
  const cascadeId = crypto.randomUUID();
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAIChatMessage[]) : [];
  const request = create(GetChatMessageRequestSchema, {
    metadata: buildMetadata(apiKey, userJwt),
    prompt: "",
    chatMessagePrompts: buildChatMessagePrompts(messages, cascadeId),
    chatModelUid: modelId,
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: 0,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: 1 }),
    disableParallelToolCalls: true,
    cascadeId,
    executionId: crypto.randomUUID(),
    configuration: buildCompletionConfiguration(body),
    tools: buildTools(body).map((tool) => create(ChatToolDefinitionSchema, tool)),
  });

  const payload = toBinary(GetChatMessageRequestSchema, request);
  const compressedPayload = gzipSync(payload);
  const framedBody = new Uint8Array(5 + compressedPayload.length);
  framedBody[0] = COMPRESSED_FLAG;
  new DataView(framedBody.buffer, framedBody.byteOffset, framedBody.byteLength).setUint32(1, compressedPayload.length);
  framedBody.set(compressedPayload, 5);

  return {
    url: `${baseUrl}${DEVIN_CHAT_PATH}`,
    headers: {
      ...buildConnectHeaders(),
      "connect-content-encoding": "gzip",
      "connect-accept-encoding": "gzip",
      "accept-encoding": "identity",
      "user-agent": "connect-go/1.18.1 (go1.26.3)",
    },
    body: framedBody,
  };
}

/** Accepts only HTTPS Codeium-hosted custom endpoints returned by Devin authentication. */
function resolveDevinBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEVIN_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || (url.hostname !== "server.codeium.com" && !url.hostname.endsWith(".codeium.com"))) {
      throw new Error("unsafe endpoint");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ProviderCallError(502, "malformed_response", "Devin authentication returned an invalid API endpoint.");
  }
}

/** Decodes the framed Devin Connect response into canonical proxy stream events. */
export async function* decodeDevinChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const toolsById = new Map<string, { name: string; arguments: string }>();
  let finishReason: ReturnType<typeof mapStopReason> = "end_turn";
  let usageEvent: StreamEvent | undefined;

  for await (const frame of readConnectFrames(body)) {
    if (frame.isEndStream) {
      const trailerPayload = (frame.flags & COMPRESSED_FLAG) !== 0 ? decompressPayload(frame.payload) : frame.payload;
      const trailer = parseConnectTrailer(new TextDecoder().decode(trailerPayload));
      if (trailer?.error) {
        const code = trailer.error.code ? ` ${trailer.error.code}` : "";
        throw new ProviderCallError(502, "malformed_response", `Devin stream error${code}: ${trailer.error.message}`);
      }
      continue;
    }

    const payload = (frame.flags & COMPRESSED_FLAG) !== 0 ? decompressPayload(frame.payload) : frame.payload;
    let response: ReturnType<typeof fromBinary<typeof GetChatMessageResponseSchema>>;
    try {
      response = fromBinary(GetChatMessageResponseSchema, payload);
    } catch {
      throw new ProviderCallError(502, "malformed_response", "Devin chat response could not be decoded.");
    }

    if (response.deltaText) yield { type: "text_delta", text: response.deltaText };
    if (response.deltaThinking) yield { type: "thinking_delta", text: response.deltaThinking };

    for (const toolCall of response.deltaToolCalls) {
      const existing = toolsById.get(toolCall.id);
      if (!existing) {
        toolsById.set(toolCall.id, { name: toolCall.name, arguments: toolCall.argumentsJson });
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        continue;
      }

      const delta = toolCall.argumentsJson.slice(existing.arguments.length);
      if (delta) {
        existing.arguments = toolCall.argumentsJson;
        yield { type: "tool_call_args_delta", id: toolCall.id, argumentsDelta: delta };
      }
    }

    if (response.stopReason !== StopReason.UNSPECIFIED) finishReason = mapStopReason(response.stopReason);
    if (response.usage) {
      usageEvent = {
        type: "usage",
        inputTokens: Number(response.usage.inputTokens),
        outputTokens: Number(response.usage.outputTokens),
        reasoningTokens: 0,
        cacheReadTokens: Number(response.usage.cacheReadTokens),
        cacheWriteTokens: Number(response.usage.cacheWriteTokens),
      };
    }
  }

  yield { type: "finish", stopReason: finishReason };
  if (usageEvent) yield usageEvent;
}

function buildMetadata(apiKey: string, userJwt: string): Metadata {
  return create(MetadataSchema, {
    apiKey,
    userJwt,
    ideName: "windsurf",
    ideVersion: DEVIN_IDE_VERSION,
    extensionName: "windsurf",
    extensionVersion: DEVIN_EXTENSION_VERSION,
    locale: "en",
  });
}


function buildChatMessagePrompts(messages: OpenAIChatMessage[], cascadeId: string): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, message] of messages.entries()) {
    if (!message) continue;

    if (message.role === "user" || message.role === "system") {
      prompts.push(create(ChatMessagePromptSchema, {
        messageId: deterministicUuid(`${cascadeId}\0${index}\0${message.role}`),
        source: ChatMessageSource.USER,
        prompt: flattenMessageText(message.content),
      }));
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls: Array<{ id: string; name: string; argumentsJson: string }> = [];
      if (Array.isArray((message as { tool_calls?: unknown }).tool_calls)) {
        for (const toolCall of (message as { tool_calls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }).tool_calls) {
          if (!toolCall) continue;
          toolCalls.push({
            id: toolCall.id ?? "",
            name: toolCall.function?.name ?? "",
            argumentsJson: toolCall.function?.arguments ?? "",
          });
        }
      }
      prompts.push(create(ChatMessagePromptSchema, {
        messageId: `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
        source: ChatMessageSource.SYSTEM,
        prompt: flattenMessageText(message.content),
        toolCalls,
      }));
      continue;
    }

    if (message.role === "tool") {
      prompts.push(create(ChatMessagePromptSchema, {
        messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${message.tool_call_id ?? ""}`),
        source: ChatMessageSource.TOOL,
        toolCallId: message.tool_call_id ?? "",
        prompt: flattenMessageText(message.content),
      }));
    }
  }
  return prompts;
}

function deterministicUuid(seed: string): string {
  const data = new TextEncoder().encode(seed);
  let hash = 0;
  for (const byte of data) hash = (hash * 31 + byte) & 0xffffffff;
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex.slice(0, 8)}-0000-0000-0000-000000000000`;
}

function buildCompletionConfiguration(body: Record<string, unknown>): CompletionConfiguration {
  const maxTokens = typeof body.max_tokens === "number"
    ? body.max_tokens
    : typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : DEFAULT_MAX_TOKENS;
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.4;
  const topP = typeof body.top_p === "number" ? body.top_p : 1;

  return create(CompletionConfigurationSchema, {
    numCompletions: 1n,
    maxTokens: BigInt(maxTokens),
    maxNewlines: 200n,
    temperature,
    firstTemperature: temperature,
    topK: 50n,
    topP,
    stopPatterns: DEFAULT_STOP_PATTERNS,
    fimEotProbThreshold: 1,
  });
}

function buildTools(body: Record<string, unknown>): Array<{ name: string; description?: string; jsonSchemaString: string }> {
  if (!Array.isArray(body.tools)) return [];
  const tools: Array<{ name: string; description?: string; jsonSchemaString: string }> = [];
  for (const candidate of body.tools) {
    if (!candidate || typeof candidate !== "object") continue;
    const tool = candidate as { type?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
    if (tool.type === "function" && tool.function) {
      tools.push({
        name: tool.function.name ?? "",
        description: tool.function.description,
        jsonSchemaString: JSON.stringify(tool.function.parameters ?? {}),
      });
    }
  }
  return tools;
}

function mapStopReason(reason: StopReason): "end_turn" | "max_tokens" | "tool_use" | "refusal" {
  return reason === StopReason.MAX_TOKENS ? "max_tokens" : "end_turn";
}
