/**
 * Devin (Codeium Cascade) provider.
 *
 * Talks to the Cascade chat API (`https://server.codeium.com`,
 * Connect+protobuf over HTTP/1.1) using the generated declarations in
 * `src/providers/integrations/devin/generated/` (protobuf declarations;
 * never hand-edit generated files, only this wiring).
 *
 * Do NOT slim the generated folder: api_server.proto imports cortex,
 * codeium_common, trust, etc., and protoc-gen-es emits per-file — dropping a
 * file breaks TS imports in the files we keep (tried, 13 typecheck errors).
 * The 20 committed files are the minimal transitive closure of the chat flow.
 *
 * API-key and OAuth credential support. Both credential kinds carry a Devin
 * session token; OAuth exchanges produce the same token shape as an API key.
 *
 * Bespoke by wire protocol (Phase C5): Connect+protobuf is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ChatMessageRequestType,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
} from "./generated/exa/api_server_pb/api_server_pb";
import {
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
} from "./generated/exa/auth_pb/auth_pb";
import {
  CacheControlType,
  ChatMessagePromptSchema,
  type ChatMessagePrompt,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  PromptCacheOptionsSchema,
} from "./generated/exa/chat_pb/chat_pb";
import {
  ChatMessageSource,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  ExperimentConfigSchema,
  ImageDataSchema,
  MetadataSchema,
  StopReason,
} from "./generated/exa/codeium_common_pb/codeium_common_pb";
import { GatewayError } from "../../../transport/gateway-error";
import { classifyUpstreamError, mapUpstreamHttpError } from "../../../transport/failure-policy";
import { joinTextParts, toolResultParts } from "../../../transport/canonical-model";
import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, ToolDefinition, UsageRecord } from "../../../transport/canonical-model";
import type { ModelDefinition } from "../../model-definition";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../../provider-registry";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  sanitizeUpstreamLabel,
  validateUpstreamBaseUrl,
} from "../../provider-metadata";
import {
  DEVIN_BASE_URL,
  DEVIN_CHAT_PATH,
  DEVIN_PROVIDER_ID,
} from "./devin-catalog";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  consumeConnectFrames,
  frameConnectMessage,
  FrameBuffer,
} from "../connect";

const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt" as const;
const DEVIN_CONFIGS_PATH =
  "/exa.api_server_pb.ApiServerService/GetCliModelConfigs" as const;
const DEVIN_IDE_VERSION = "3.10.35" as const;
const DEVIN_EXTENSION_VERSION = "1.49.2" as const;
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$" as const;
const DEVIN_DEFAULT_STOP_PATTERNS = [
  "<|user|>",
  "<|bot|>",
  "<|context_request|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
] as const;
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
/**
 * Output-token ceiling for the Cascade wire. Discovery clamps a discovered cap
 * to it: publishing a larger number makes admission reserve headroom the
 * upstream rejects.
 */
const DEFAULT_DEVIN_OUTPUT_LIMIT = 64_000;
/** GetUserJwt results are cached per credential hash; upstream JWTs are long-lived. */
const USER_JWT_TTL_MS = 10 * 60 * 1_000;

/**
 * One Devin catalog row projected into a `ModelDefinition`.
 *
 * Capabilities come from the config's own `ModelInfo` when it is present,
 * because that is the upstream's declaration rather than a guess: `supportsImages`
 * on the row says the *client* may attach an image, while
 * `modelInfo.modelFeatures` carries the per-model capability set (thinking,
 * tool calls, parallel calls). Falling back to the row-level flags when
 * `modelInfo` is absent keeps an older upstream response usable.
 */
function devinModelFromConfig(config: {
  readonly label: string;
  readonly modelUid: string;
  readonly modelOrAlias?: {
    readonly choice:
      | { readonly case: "modelUid"; readonly value: string }
      | { readonly case: "alias"; readonly value: { readonly value?: string } }
      | { readonly case: string; readonly value?: unknown }
      | { readonly case: undefined; readonly value?: undefined };
  };
  readonly maxTokens: number;
  readonly supportsImages: boolean;
  readonly disabled: boolean;
  readonly modelInfo?: {
    readonly maxTokens?: number;
    readonly maxOutputTokens?: number;
    readonly modelFeatures?: {
      readonly supportsImages?: boolean;
      readonly supportsThinking?: boolean;
      readonly supportsToolCalls?: boolean;
      readonly supportsParallelToolCalls?: boolean;
    };
  };
}): ModelDefinition | null {
  if (config.disabled) return null;
  const rawUid = sanitizeUpstreamLabel(config.modelUid) ?? "";
  const choice = config.modelOrAlias?.choice;
  const aliasUid =
    choice?.case === "modelUid"
      ? (sanitizeUpstreamLabel(choice.value) ?? "")
      : choice?.case === "alias"
        ? (sanitizeUpstreamLabel((choice.value as { value?: unknown }).value) ?? "")
        : "";
  const id = sanitizeUpstreamLabel(rawUid || aliasUid || config.label);
  if (!id) return null;

  // `ModelInfo` separates the two token ceilings; the row's own `maxTokens` is
  // the context window. Publishing the window as the output cap reserved the
  // whole context as output headroom, and the upstream rejected the request.
  const info = config.modelInfo;
  const contextLimit =
    boundedUpstreamNumber(info?.maxTokens, { min: 1, max: 100_000_000 }) ??
    boundedUpstreamNumber(config.maxTokens, { min: 1, max: 100_000_000 }) ??
    null;
  const declaredOutput =
    boundedUpstreamNumber(info?.maxOutputTokens, { min: 1, max: 100_000_000 }) ??
    boundedUpstreamNumber(config.maxTokens, { min: 1, max: 100_000_000 });
  // An output cap above the context window is unsatisfiable, and a cap above
  // the wire's own ceiling is rejected outright.
  const outputLimit =
    declaredOutput === undefined
      ? null
      : Math.min(declaredOutput, contextLimit ?? DEFAULT_DEVIN_OUTPUT_LIMIT, DEFAULT_DEVIN_OUTPUT_LIMIT);

  const features = info?.modelFeatures;
  const supportsImages = features?.supportsImages ?? config.supportsImages;
  return {
    modelId: id,
    // Served by the bespoke adapter's own RPC, so the endpoint is its path.
    wireFamily: "chat",
    endpointPath: DEVIN_CHAT_PATH,
    contextLimit,
    outputLimit,
    // A bespoke wire gets `image`/`document`/`audio` only from this row (see
    // `buildCapabilityProfile`), so writing the modality here is what keeps a
    // caller's image from being degraded to text before dispatch.
    modalities: {
      input: ["text", ...(supportsImages ? ["image"] : [])],
      output: ["text"],
    },
    reasoning: features?.supportsThinking ?? false,
    toolCall: features?.supportsToolCalls ?? true,
    cost: modelsDevCatalog.costFor(DEVIN_PROVIDER_ID, id),
  };
}

/**
 * Live per-account model discovery. Returns null on any failure so callers
 * fall back to the static catalog; never throws for discovery problems.
 */
export async function fetchDevinModels(
  credential: string,
  fetchFn: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<readonly ModelDefinition[] | null> {
  const apiKey = normalizeDevinSessionToken(credential.trim());
  if (!apiKey) return null;
  try {
    const metadata = create(MetadataSchema, {
      ideName: "WINDSURF",
      ideVersion: "1.0.0",
      extensionVersion: "1.0.0",
      apiKey,
    });
    const request = create(GetCliModelConfigsRequestSchema, { metadata });
    const response = await fetchFn(`${DEVIN_BASE_URL}${DEVIN_CONFIGS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "connect-protocol-version": "1",
        "content-type": "application/proto",
        accept: "application/proto",
      },
      body: toBinary(GetCliModelConfigsRequestSchema, request),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    let payload = new Uint8Array(await response.arrayBuffer());
    if (payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
      try {
        payload = gunzipSync(Buffer.from(payload));
      } catch {
        // Non-gzip or corrupt frame payload falls back to raw payload.
      }
    }
    if (payload.length >= 5 && (payload[0] ?? 0) <= 0x03) {
      const length = new DataView(payload.buffer, payload.byteOffset + 1, 4).getUint32(0, false);
      if (5 + length <= payload.length) {
        const flags = payload[0] ?? 0;
        let encoded = payload.subarray(5, 5 + length);
        if ((flags & 0x01) !== 0) {
          try {
            encoded = gunzipSync(Buffer.from(encoded));
          } catch {
            // Non-gzip compressed frame safely falls back to uncompressed frame bytes.
          }
        }
        if ((flags & 0x02) === 0) payload = encoded;
      }
    }
    const decoded = fromBinary(GetCliModelConfigsResponseSchema, payload);
    const configs = boundedUpstreamArray(decoded.clientModelConfigs) ?? [];
    const models = configs.flatMap((config) => {
      const model = devinModelFromConfig({
        label: config.label,
        modelUid: config.modelUid,
        ...(config.modelOrAlias === undefined
          ? {}
          : { modelOrAlias: { choice: config.modelOrAlias.choice } }),
        maxTokens: Number(config.maxTokens ?? 0),
        supportsImages: Boolean(config.supportsImages),
        disabled: Boolean(config.disabled),
        // Typed as `ModelInfo | undefined` by the generator; read only the
        // capability fields the projection above needs.
        ...(config.modelInfo === undefined
          ? {}
          : {
              modelInfo: {
                ...(config.modelInfo.maxTokens === undefined
                  ? {}
                  : { maxTokens: Number(config.modelInfo.maxTokens) }),
                ...(config.modelInfo.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: Number(config.modelInfo.maxOutputTokens) }),
                ...(config.modelInfo.modelFeatures === undefined
                  ? {}
                  : {
                      modelFeatures: {
                        supportsImages: Boolean(config.modelInfo.modelFeatures.supportsImages),
                        supportsThinking: Boolean(config.modelInfo.modelFeatures.supportsThinking),
                        supportsToolCalls: Boolean(config.modelInfo.modelFeatures.supportsToolCalls),
                        supportsParallelToolCalls: Boolean(
                          config.modelInfo.modelFeatures.supportsParallelToolCalls,
                        ),
                      },
                    }),
              },
            }),
      });
      return model ? [model] : [];
    });
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

// Token handling (+ short-TTL userJwt cache)

/** Normalizes the stored credential to the upstream session-token form. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
    ? apiKey
    : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

interface CachedUserJwt {
  readonly userJwt: string;
  readonly baseUrl: string;
  readonly expiresAt: number;
}

const userJwtCache = new Map<string, CachedUserJwt>();
const USER_JWT_CACHE_MAX = 1024;
function boundUserJwtCache(): void {
  while (userJwtCache.size > USER_JWT_CACHE_MAX) {
    const oldest = userJwtCache.keys().next().value;
    if (oldest === undefined) break;
    userJwtCache.delete(oldest);
  }
}

function cacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Test hook: forgets cached GetUserJwt results. */
export function _resetDevinAuthCache(): void {
  userJwtCache.clear();
}

async function fetchUserJwt(
  apiKey: string,
  baseUrl: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl: string }> {
  const key = cacheKey(apiKey);
  const cached = userJwtCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { userJwt: cached.userJwt, baseUrl: cached.baseUrl };
  }
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
  const response = await fetchFn(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(GetUserJwtRequestSchema, request),
    ...(signal === undefined ? {} : { signal }),
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const text = new TextDecoder().decode(payload).slice(0, 500);
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(
        "authentication_failed",
        response.status,
        `Devin auth error ${response.status}: ${text}`,
        { providerId: DEVIN_PROVIDER_ID },
        "upstream",
      );
    }
    throw new GatewayError(
      "platform_unavailable",
      response.status,
      `Devin auth error ${response.status}: ${text}`,
      { providerId: DEVIN_PROVIDER_ID },
      "upstream",
    );
  }
  let decoded: { userJwt: string; customApiServerUrl: string };
  try {
    decoded = fromBinary(GetUserJwtResponseSchema, payload);
  } catch {
    decoded = fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
  }
  if (!decoded.userJwt) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Devin auth error: GetUserJwt returned an empty user JWT",
      { providerId: DEVIN_PROVIDER_ID },
      "upstream",
    );
  }
  const resolvedBase = validateUpstreamBaseUrl(decoded.customApiServerUrl) ?? baseUrl;
  userJwtCache.set(key, {
    userJwt: decoded.userJwt,
    baseUrl: resolvedBase,
    expiresAt: Date.now() + USER_JWT_TTL_MS,
  });
  boundUserJwtCache();
  return { userJwt: decoded.userJwt, baseUrl: resolvedBase };
}

// Request building

function buildToolDefinitions(tools: readonly ToolDefinition[]) {
  return tools
    .filter((tool) => tool.name.trim().length > 0)
    .map((tool) =>
      create(ChatToolDefinitionSchema, {
        name: tool.name,
        description: tool.description ?? "",
        // The canonical contract stores the schema in jsonSchema. Reading
        // input_schema here silently replaced every tool schema with `{}`;
        // Devin then emitted `{}` for printf and the Model Lab could not
        // execute the call because its required `text` argument was absent.
        jsonSchemaString: JSON.stringify(tool.jsonSchema),
        strict: tool.strict ?? false,
        isCustomTool: true,
      }),
    );
}

function parseDevinImage(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const source = p["source"];
  if (source && typeof source === "object" && typeof (source as Record<string, unknown>)["data"] === "string") {
    const s = source as Record<string, unknown>;
    const mimeType = typeof s["media_type"] === "string" ? s["media_type"] : "image/png";
    return create(ImageDataSchema, { base64Data: s["data"] as string, mimeType, caption: "" });
  }
  const rawBase64 = p["base64_data"] ?? p["base64Data"];
  if (typeof rawBase64 === "string") {
    const mime = typeof p["mime_type"] === "string" ? p["mime_type"] : typeof p["mimeType"] === "string" ? p["mimeType"] : "image/png";
    return create(ImageDataSchema, {
      base64Data: rawBase64,
      mimeType: mime,
      caption: typeof p["caption"] === "string" ? (p["caption"] as string) : "",
    });
  }
  const rawUrl = typeof p["url"] === "string"
    ? p["url"]
    : typeof (p["image_url"] as Record<string, unknown> | undefined)?.["url"] === "string"
      ? (p["image_url"] as Record<string, unknown>)["url"]
      : typeof p["image_url"] === "string"
        ? p["image_url"]
        : undefined;
  if (typeof rawUrl === "string") {
    const match = rawUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match && match[1] && match[2]) {
      return create(ImageDataSchema, { base64Data: match[2], mimeType: match[1], caption: "" });
    }
  }
  return undefined;
}

function imagesOf(message: CanonicalMessage) {
  return message.content
    .filter((part) => part.kind === "image")
    .map((part) => (part.kind === "image" ? parseDevinImage(part.payload) : undefined))
    .filter((img): img is NonNullable<typeof img> => img !== undefined);
}

function buildChatMessagePrompts(
  messages: readonly CanonicalMessage[],
  cascadeId: string,
  toolCallIndex: Map<string, { name: string; args: string }>,
) {
  void cascadeId;
  const prompts: ChatMessagePrompt[] = [];
  for (const message of messages) {
    // Answers live in `tool` turns or in `user` turns (the Messages ledger
    // re-homes them), so results are extracted before the role branches: a
    // `user` turn carrying a result must emit a TOOL prompt, not a USER one,
    // and its remaining text (if any) still follows as USER.
    const results = toolResultParts(message);
    if (results.length > 0) {
      for (const result of results) {
        const text =
          typeof result.content === "string"
            ? result.content
            : result.content
                .filter((part) => part.kind === "text")
                .map((part) => (part.kind === "text" ? part.text : ""))
                .join("\n");
        prompts.push(
          create(ChatMessagePromptSchema, {
            messageId: randomUUID(),
            source: ChatMessageSource.TOOL,
            prompt: text,
            toolCallId:
              [...toolCallIndex.keys()].find((id) => id === result.call_id) ??
              result.call_id,
            toolResultIsError: Boolean(result.is_error),
            images: [],
          }),
        );
      }
      if (message.role === "tool") continue;
    }
    if (message.role === "user" || message.role === "developer") {
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: randomUUID(),
          source: ChatMessageSource.USER,
          prompt: joinTextParts(message.content),
          images: imagesOf(message),
        }),
      );
    } else if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((part) => part.kind === "toolCall")
        .map((part) =>
          part.kind === "toolCall"
            ? {
                id: part.call_id,
                name: part.name,
                argumentsJson:
                  typeof part.arguments === "string"
                    ? part.arguments
                    : JSON.stringify(part.arguments ?? {}),
              }
            : undefined,
        )
        .filter((call): call is { id: string; name: string; argumentsJson: string } =>
          Boolean(call),
        );
      for (const call of toolCalls) {
        toolCallIndex.set(call.id, { name: call.name, args: call.argumentsJson });
      }
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: randomUUID(),
          source: ChatMessageSource.SYSTEM,
          prompt: joinTextParts(message.content),
          toolCalls: toolCalls.map((call) =>
            // ChatToolCall shape is completed at stream time; history carries id/name/args.
            ({
              id: call.id,
              name: call.name,
              argumentsJson: call.argumentsJson,
              isCustomToolCall: true,
            }),
          ),
        }),
      );
    }
  }
  return prompts;
}

interface DevinChatRequestOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly conversationId?: string;
  readonly webSearch?: boolean;
}

/** Builds the `GetChatMessageRequest` proto bytes for one Cascade turn. */
export function buildDevinChatRequest(
  modelId: string,
  messages: readonly CanonicalMessage[],
  systemPrompt: string,
  tools: readonly ToolDefinition[],
  options: DevinChatRequestOptions,
  apiKey: string,
  userJwt: string,
): Uint8Array {
  const cascadeId = options.conversationId ?? randomUUID();
  const stopPatterns =
    options.stopSequences && options.stopSequences.length > 0
      ? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
      : [...DEVIN_DEFAULT_STOP_PATTERNS];
  const toolCallIndex = new Map<string, { name: string; args: string }>();
  const hasWebSearch =
    Boolean(options.webSearch) ||
    tools.some((t) => t.tool_type === "web_search" || t.name === "web_search");
  const functionTools = tools.filter(
    (t) => t.tool_type !== "web_search" && t.name !== "web_search",
  );
  const request = create(GetChatMessageRequestSchema, {
    metadata: create(MetadataSchema, {
      apiKey,
      userJwt,
      ideName: "windsurf",
      ideVersion: DEVIN_IDE_VERSION,
      extensionName: "windsurf",
      extensionVersion: DEVIN_EXTENSION_VERSION,
      locale: "en",
    }),
    prompt: systemPrompt,
    chatMessagePrompts: buildChatMessagePrompts(messages, cascadeId, toolCallIndex),
    chatModelUid: modelId,
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, {
      choice: { case: "optionName", value: "auto" },
    }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, {
      type: CacheControlType.EPHEMERAL,
    }),
    disableParallelToolCalls: true,
    cascadeId,
    executionId: randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options.maxTokens ?? 64_000),
      maxNewlines: 200n,
      temperature: options.temperature ?? 0.4,
      firstTemperature: options.temperature ?? 0.4,
      topK: 50n,
      topP: 1,
      stopPatterns,
      fimEotProbThreshold: 1,
    }),
    experimentConfig: create(ExperimentConfigSchema, {
      forceEnableExperimentStrings: hasWebSearch ? ["CASCADE_WEB_SEARCH_ENABLED"] : [],
    }),
    tools: buildToolDefinitions(functionTools),
  });
  return toBinary(GetChatMessageRequestSchema, request);
}

// Streaming

function readTrailerError(text: string): { code: string; message: string } | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  if (!code && !message) return null;
  return { code, message };
}

function throwTrailerError(code: string, message: string, status: number): never {
  const classification = classifyUpstreamError(status, code || undefined);
  const formatted = `Devin stream error${code ? ` ${code}` : ""}: ${message}`;
  throw new GatewayError(
    classification.code,
    classification.status,
    formatted,
    {
      providerId: DEVIN_PROVIDER_ID,
      providerStatus: status,
      ...(code ? { providerCode: code } : {}),
      ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
      ...(classification.rateLimitScope
        ? { rateLimitScope: classification.rateLimitScope }
        : {}),
    },
    classification.origin,
  );
}

// Adapter

interface DevinAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

/** Builds the canonical usage record from Devin's protobuf usage counters. */
function devinUsage(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
): UsageRecord {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cacheRead > 0 ? cacheRead : "unavailable",
    cache_write_tokens: cacheWrite > 0 ? cacheWrite : "unavailable",
    uncached_input_tokens:
      cacheRead > 0 ? Math.max(0, inputTokens - cacheRead) : "unavailable",
    output_tokens: outputTokens,
    reasoning_tokens: "unavailable",
    // Unpriced until the dispatch call site reprices against the routed model.
    estimated_cost: null,
    total_tokens: inputTokens + outputTokens,
  };
}

class DevinAdapter implements ProviderAdapter {
  readonly provider_id = DEVIN_PROVIDER_ID;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: DevinAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? DEVIN_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (
      context.credential.credential_kind !== "oauth" &&
      context.credential.credential_kind !== "api_key"
    ) {
      throw new GatewayError(
        "invalid_request",
        400,
        "Devin requires an API key or OAuth credential",
        { providerId: DEVIN_PROVIDER_ID },
      );
    }
    if (!context.credential.secret || context.credential.secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "Missing Devin credential", {
        providerId: DEVIN_PROVIDER_ID,
      });
    }
    const nonSupported = (request.tools ?? []).filter(
      (tool) =>
        tool.tool_type !== undefined &&
        tool.tool_type !== "function" &&
        tool.tool_type !== "web_search",
    );
    if (nonSupported.length > 0) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "Devin supports function and web_search tools only",
        { providerId: DEVIN_PROVIDER_ID },
      );
    }

    const apiKey = normalizeDevinSessionToken(
      new TextDecoder().decode(context.credential.secret).trim(),
    );
    if (!apiKey) {
      throw new GatewayError("authentication_failed", 401, "Empty Devin credential", {
        providerId: DEVIN_PROVIDER_ID,
      });
    }
    const fetchFn =
      (context.outbound_fetch as unknown as typeof fetch | undefined) ?? this.#fetch;
    const { userJwt, baseUrl } = await fetchUserJwt(
      apiKey,
      this.#baseUrl,
      fetchFn,
      context.abort_signal,
    );

    const controls = request.generation_controls;
    const systemPrompt = [...(request.system ?? []), ...(request.instructions ?? [])]
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join("\n");
    const modelId = candidate.model_id || request.model;
    const requestBytes = buildDevinChatRequest(
      modelId,
      request.messages,
      systemPrompt,
      request.tools ?? [],
      {
        maxTokens: controls.max_output_tokens ?? controls.max_tokens ?? 64_000,
        ...(controls.temperature === undefined ? {} : { temperature: controls.temperature }),
        ...(controls.stop === undefined
          ? {}
          : { stopSequences: typeof controls.stop === "string" ? [controls.stop] : [...controls.stop] }),
        ...(request.conversation?.conversation_id === undefined
          ? {}
          : { conversationId: request.conversation.conversation_id }),
        ...(Boolean(request.provider_options?.["web_search"]) ? {} : {}),
      },
      apiKey,
      userJwt,
    );
    const frame = frameConnectMessage(gzipSync(requestBytes), CONNECT_COMPRESSED_FLAG);

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${DEVIN_CHAT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "connect-content-encoding": "gzip",
          "accept-encoding": "identity",
          "user-agent": "connect-go/1.18.1 (go1.26.3)",
          "connect-accept-encoding": "gzip",
        },
        body: frame,
        signal: context.abort_signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayError("transport_closed", 499, "request was cancelled", {
          providerId: DEVIN_PROVIDER_ID,
        });
      }
      throw new GatewayError(
        "transport_unavailable",
        502,
        `Devin transport failed: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: DEVIN_PROVIDER_ID },
        "network",
      );
    }
    if (!response.ok) throw await mapUpstreamHttpError(response, DEVIN_PROVIDER_ID);
    if (!response.body) {
      throw new GatewayError("platform_unavailable", 502, "Devin API error: empty body", {
        providerId: DEVIN_PROVIDER_ID,
      }, "upstream");
    }

    let sequence = 0;
    let latestStop: "stop" | "length" | "tool_use" = "stop";
    let activeToolCallId: string | undefined;
    yield { type: "response_start", sequence_number: sequence++, model: request.model };
    const reader = response.body.getReader();
    const pending = new FrameBuffer();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (;;) {
      const { done, value } = await reader.read();
      const rawValue: unknown = value;
      let chunk: Uint8Array | undefined;
      if (ArrayBuffer.isView(rawValue)) {
        chunk = new Uint8Array(
          rawValue.buffer as ArrayBuffer,
          rawValue.byteOffset,
          rawValue.byteLength,
        );
      } else if (
        rawValue instanceof ArrayBuffer ||
        Object.prototype.toString.call(rawValue) === "[object ArrayBuffer]"
      ) {
        chunk = new Uint8Array(rawValue as ArrayBuffer);
      }
      if (chunk && chunk.byteLength > 0) pending.append(chunk);
      const buffered = pending.view();
      const { frames, rest } = consumeConnectFrames(buffered, {
        maxPayloadBytes: MAX_CONNECT_FRAME_PAYLOAD,
        oversizeError: (length) =>
          new GatewayError(
            "platform_unavailable",
            502,
            `Devin Connect frame length ${length} exceeds cap`,
            { providerId: DEVIN_PROVIDER_ID },
            "upstream",
          ),
      });
      pending.consume(buffered.length - rest.length);
      for (const frame of frames) {
        const payload = frame.payload;
        if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
          const trailerBytes =
            (frame.flags & CONNECT_COMPRESSED_FLAG) !== 0 ? gunzipSync(payload) : payload;
          const trailerError = readTrailerError(trailerBytes.toString("utf8").trim());
          if (trailerError) throwTrailerError(trailerError.code, trailerError.message, 500);
          continue;
        }
        const raw =
          (frame.flags & CONNECT_COMPRESSED_FLAG) !== 0 ? gunzipSync(payload) : payload;
        const message = fromBinary(GetChatMessageResponseSchema, raw);
        if (message.deltaThinking) {
          yield {
            type: "content_delta",
            sequence_number: sequence++,
            content: { kind: "reasoning", payload: null, summary: message.deltaThinking },
          };
        }
        if (message.deltaText) {
          yield {
            type: "content_delta",
            sequence_number: sequence++,
            content: { kind: "text", text: message.deltaText },
          };
        }
        for (const toolCall of message.deltaToolCalls ?? []) {
          const name = toolCall.name.trim();
          const callId = toolCall.id.trim() || activeToolCallId;
          if (!callId) {
            // A nameless frame without an established call cannot be routed
            // safely. Devin may send one before the call-start frame; ignore
            // it and wait for the frame that carries the function identity.
            continue;
          }
          if (name) {
            activeToolCallId = callId;
            latestStop = "tool_use";
          }
          yield {
            type: "tool_call_delta",
            sequence_number: sequence++,
            call_id: callId,
            ...(name ? { name } : {}),
            ...(toolCall.argumentsJson ? { arguments_delta: toolCall.argumentsJson } : {}),
          };
        }
        if (message.stopReason !== StopReason.UNSPECIFIED) {
          const stopReason = message.stopReason === StopReason.MAX_TOKENS ? "length" : "stop";
          if (latestStop !== "tool_use" || stopReason === "length") latestStop = stopReason;
        }
        if (message.usage) {
          inputTokens = Number(message.usage.inputTokens ?? 0);
          outputTokens = Number(message.usage.outputTokens ?? 0);
          cacheReadTokens = Number(message.usage.cacheReadTokens ?? 0n);
          cacheWriteTokens = Number(message.usage.cacheWriteTokens ?? 0n);
          yield {
            type: "usage",
            sequence_number: sequence++,
            usage: devinUsage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
          };
        }
      }
      if (done) break;
    }
    yield {
      type: "terminal",
      sequence_number: sequence++,
      state: "complete",
      stop_reason: latestStop,
      usage: devinUsage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
    };
  }
}

export function createDevinAdapter(options: DevinAdapterOptions = {}): ProviderAdapter {
  return new DevinAdapter(options);
}

export const devinAdapter: ProviderAdapter = createDevinAdapter();
