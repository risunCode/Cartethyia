/**
 * Cursor Agent provider.
 *
 * Talks to the official Cursor AgentService (Connect+protobuf over HTTP/2,
 * `POST /agent.v1.AgentService/Run`) using the generated declarations in
 * `src/providers/integrations/cursor/generated/agent_pb.ts`. OAuth is required; API keys are
 * rejected, and tool calls are not advertised by this adapter.
 *
 * Bespoke by wire protocol (Phase C5): Connect+protobuf is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import * as http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { SelectedImage } from "./generated/agent_pb";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ExecClientMessageSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  RequestedModelSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SelectedImage_DimensionSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./generated/agent_pb";
import { GatewayError } from "../../../transport/gateway-error";
import { joinTextParts } from "../../../transport/canonical-model";
import type { CanonicalEvent, CanonicalMessage, CanonicalRequest } from "../../../transport/canonical-model";
import type {
  ProviderDispatchTarget,
  ModelDefinition,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../../provider-registry";
import {
  CONNECT_COMPRESSED_FLAG,
  CONNECT_END_STREAM_FLAG,
  consumeConnectFrames,
  frameConnectMessage,
  FrameBuffer,
} from "../connect";
import { boundedUpstreamArray, sanitizeUpstreamLabel } from "../../provider-metadata";
import { parseCursorCredential } from "./cursor-oauth";
import {
  CURSOR_BASE_URL,
  CURSOR_MODELS,
  CURSOR_PROVIDER_ID,
  CURSOR_RUN_PATH,
} from "./catalog";

export { CURSOR_BASE_URL, CURSOR_MODELS, CURSOR_PROVIDER_ID, CURSOR_RUN_PATH } from "./catalog";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b" as const;
export const CURSOR_MODEL_CLIENT_VERSION = "cli-2026.02.13-41ac335" as const;
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels" as const;
const CURSOR_CONNECT_TIMEOUT_MS = 10_000;
const CURSOR_HEARTBEAT_MS = 5_000;
const CURSOR_PROBE_IDLE_MS = 750;
const CURSOR_MODELS_TIMEOUT_MS = 5_000;

interface CursorDiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly images: boolean;
}

function cursorModelFromDetails(
  details: {
    readonly modelId: string;
    readonly displayName: string;
    readonly displayNameShort: string;
    readonly aliases: readonly string[];
    readonly thinkingDetails?: unknown;
  },
  references: ReadonlyMap<string, ModelDefinition>,
): CursorDiscoveredModel | null {
  const id = sanitizeUpstreamLabel(details.modelId);
  if (!id) return null;
  const reference = references.get(id);
  const displayName =
    sanitizeUpstreamLabel(details.displayName) ??
    sanitizeUpstreamLabel(details.displayNameShort) ??
    details.aliases
      .map((alias) => sanitizeUpstreamLabel(alias))
      .find((value) => value !== undefined) ??
    id;
  const reasoning =
    details.thinkingDetails !== undefined || reference?.reasoning === true;
  return { id, displayName, reasoning, images: /claude|gemini|gpt-|codex/i.test(id) };
}

/** Strips one Connect envelope when present; otherwise returns the raw payload. */
export function parseCursorModelsPayload(payload: Uint8Array): Uint8Array {
  if (payload.length < 5) return payload;
  if ((payload[0] ?? 0) > 0x03) return payload;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset] ?? 0;
    const length = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    ).getUint32(1, false);
    const end = offset + 5 + length;
    if (end > payload.length) return payload;
    const encoded = payload.subarray(offset + 5, end);
    if ((flags & 0x02) === 0) {
      return (flags & 0x01) !== 0 ? gunzipSync(encoded) : encoded;
    }
    offset = end;
  }
  return payload;
}

async function fetchCursorModelsPayload(
  token: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const request = create(GetUsableModelsRequestSchema, { customModelIds: [] });
  const body = toBinary(GetUsableModelsRequestSchema, request);
  return new Promise((resolve) => {
    const client = http2.connect(CURSOR_BASE_URL);
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(null);
    }, CURSOR_MODELS_TIMEOUT_MS);
    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve(value);
    };
    client.once("error", () => finish(null));
    const requestStream = client.request({
      ":method": "POST",
      ":path": CURSOR_MODELS_PATH,
      "content-type": "application/proto",
      te: "trailers",
      authorization: `Bearer ${token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_MODEL_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
    });
    requestStream.once("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      if (status < 200 || status >= 300) finish(null);
    });
    requestStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    requestStream.once("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
    requestStream.once("error", () => finish(null));
    const abort = (): void => {
      requestStream.close();
      finish(null);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    requestStream.end(Buffer.from(body));
  });
}

/**
 * Live per-account model discovery. Returns null on any failure so callers
 * fall back to the static catalog; never throws for discovery problems.
 */
export async function fetchCursorModels(
  credential: string,
  signal?: AbortSignal,
): Promise<readonly CursorDiscoveredModel[] | null> {
  if (!credential) return null;
  try {
    const payload = await fetchCursorModelsPayload(credential, signal);
    if (!payload) return null;
    const decoded = parseCursorModelsPayload(payload);
    const response = fromBinary(GetUsableModelsResponseSchema, decoded);
    const references = new Map(CURSOR_MODELS.map((model) => [model.modelId, model]));
    const discovered = boundedUpstreamArray(response.models) ?? [];
    const models = discovered.flatMap((details) => {
      const model = cursorModelFromDetails(
        {
          modelId: details.modelId,
          displayName: details.displayName,
          displayNameShort: details.displayNameShort,
          aliases: [...details.aliases],
          thinkingDetails: details.thinkingDetails,
        },
        references,
      );
      return model === null ? [] : [model];
    });
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

// Request framing

function selectedImagesFromMessage(message: CanonicalMessage): SelectedImage[] {
  return message.content
    .filter((part) => part.kind === "image")
    .map((part) => parseCursorImage((part as { payload: unknown }).payload))
    .filter((img): img is SelectedImage => img !== undefined);
}

function parseCursorImage(payload: unknown): SelectedImage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const raw =
    typeof p["data"] === "string"
      ? (p["data"] as string)
      : typeof p["base64_data"] === "string"
        ? (p["base64_data"] as string)
        : typeof p["base64Data"] === "string"
          ? (p["base64Data"] as string)
          : undefined;
  if (!raw) return undefined;
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  const data = match?.[2] ?? raw;
  const mimeType = match?.[1] ?? (typeof p["mime_type"] === "string" ? p["mime_type"] : typeof p["mimeType"] === "string" ? p["mimeType"] : "image/png");
  const dimension =
    typeof p["width"] === "number" && typeof p["height"] === "number"
      ? create(SelectedImage_DimensionSchema, { width: p["width"], height: p["height"] })
      : undefined;
  return create(SelectedImageSchema, {
    uuid: randomUUID(),
    path: "",
    mimeType,
    dataOrBlobId: { case: "data", value: Buffer.from(data, "base64") },
    ...(dimension ? { dimension } : {}),
  });
}

export function buildCursorHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

/** Builds the `AgentClientMessage` Run request bytes for one turn. */
export function buildCursorRunRequest(
  messages: readonly CanonicalMessage[],
  modelId: string,
): Uint8Array {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const history = messages
    .filter(
      (message) =>
        message !== lastUser && message.role !== "system" && message.role !== "developer",
    )
    .map((message) => `${message.role}: ${joinTextParts(message.content)}`)
    .join("\n\n");
  const prompt = [
    history ? `Conversation history:\n${history}` : "",
    lastUser ? joinTextParts(lastUser.content) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [],
    turns: [],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });
  const userMessage = create(UserMessageSchema, {
    text: prompt || "hello",
    messageId: randomUUID(),
    mode: 0,
    selectedContext: lastUser?.role === "user" ? create(SelectedContextSchema, {
      selectedImages: selectedImagesFromMessage(lastUser),
      extraContext: [],
      extraContextEntries: [],
      files: [],
      codeSelections: [],
      terminals: [],
      terminalSelections: [],
      folders: [],
      externalLinks: [],
      gitPrDiffSelections: [],
      selectedPullRequests: [],
      selectedSubagents: [],
      cursorRules: [],
      cursorCommands: [],
      documentations: [],
      uiElements: [],
      consoleLogs: [],
      gitCommits: [],
      pastChats: [],
    }) : undefined,
  });
  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, {
        userMessage,
        sendToInteractionListener: true,
      }),
    },
  });
  const run = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId,
      displayModelId: modelId,
      displayName: modelId,
      displayNameShort: modelId,
      aliases: [],
    }),
    requestedModel: create(RequestedModelSchema, {
      modelId,
      maxMode: false,
      parameters: [],
    }),
    conversationId: randomUUID(),
  });
  return toBinary(
    AgentClientMessageSchema,
    create(AgentClientMessageSchema, {
      message: { case: "runRequest", value: run },
    }),
  );
}

function requestContextFrame(server: { readonly id: number; readonly execId: string }): Buffer {
  const requestContext = create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools: [],
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [],
    fileContents: {},
    customSubagents: [],
  });
  const requestContextResult = create(RequestContextResultSchema, {
    result: {
      case: "success",
      value: create(RequestContextSuccessSchema, { requestContext }),
    },
  });
  const exec = create(ExecClientMessageSchema, {
    id: server.id,
    execId: server.execId,
    message: { case: "requestContextResult", value: requestContextResult },
  });
  const message = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: exec },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, message));
}

interface CursorResponseState {
  hasText: boolean;
  turnEnded: boolean;
}

function consumeCursorFrames(
  buffer: Buffer,
  state: CursorResponseState,
  onContextRequest: (server: { readonly id: number; readonly execId: string }) => void,
  onInteraction: (caseName: string) => void,
  onTextDelta: (delta: string) => void,
): Buffer {
  const { frames, rest } = consumeConnectFrames(buffer);
  for (const frame of frames) {
    const payload =
      (frame.flags & CONNECT_COMPRESSED_FLAG) !== 0
        ? gunzipSync(frame.payload)
        : frame.payload;
    if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
      const trailer = JSON.parse(payload.toString("utf8")) as {
        error?: { code?: string; message?: string };
      };
      if (trailer.error) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          `Cursor error ${trailer.error.code ?? "unknown"}: ${trailer.error.message ?? "request failed"}`,
          { providerId: CURSOR_PROVIDER_ID },
          "upstream",
        );
      }
      continue;
    }
    const message = fromBinary(AgentServerMessageSchema, payload);
    if (message.message.case === "interactionUpdate") {
      const interaction = message.message.value;
      onInteraction(interaction.message.case ?? "unknown");
      if (interaction.message.case === "textDelta") onTextDelta(interaction.message.value.text);
      if (interaction.message.case === "turnEnded") state.turnEnded = true;
      continue;
    }
    if (message.message.case === "execServerMessage") {
      const exec = message.message.value;
      if (exec.message.case !== "requestContextArgs") {
        throw new GatewayError(
          "platform_unavailable",
          502,
          `Cursor requested unsupported exec operation "${exec.message.case}"`,
          { providerId: CURSOR_PROVIDER_ID },
          "upstream",
        );
      }
      onContextRequest(exec);
    }
  }
  return rest;
}

// Adapter

interface CursorAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class CursorAdapter implements ProviderAdapter {
  readonly provider_id = CURSOR_PROVIDER_ID;
  readonly #baseUrl: string;

  constructor(options: CursorAdapterOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? CURSOR_BASE_URL).replace(/\/+$/, "");
    void options.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (context.credential.credential_kind !== "oauth") {
      throw new GatewayError(
        "invalid_request",
        400,
        "Cursor adapter requires an OAuth credential",
        { providerId: CURSOR_PROVIDER_ID },
      );
    }
    if (!context.credential.secret || context.credential.secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "Missing Cursor access token", {
        providerId: CURSOR_PROVIDER_ID,
      });
    }
    if (request.tools && request.tools.length > 0) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "Cursor adapter does not support tool calls yet",
        { providerId: CURSOR_PROVIDER_ID },
      );
    }
    const secret = new TextDecoder().decode(context.credential.secret);
    const accessToken = parseCursorCredential(secret).accessToken || secret.trim();
    if (!accessToken) {
      throw new GatewayError("authentication_failed", 401, "Empty Cursor access token", {
        providerId: CURSOR_PROVIDER_ID,
      });
    }

    const modelId = candidate.model_id || request.model;
    const isProbe = request.messages.some((message) =>
      message.content.some(
        (part) =>
          part.kind === "text" &&
          part.text.includes("Be honest about your identity"),
      ),
    );
    const client = await new Promise<http2.ClientHttp2Session>((resolve, reject) => {
      let settled = false;
      const session = http2.connect(this.#baseUrl);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          session.close();
        } catch {
          // Best-effort session close on connect timeout.
        }
        reject(
          new GatewayError("transport_unavailable", 502, "Cursor connect timeout", {
            providerId: CURSOR_PROVIDER_ID,
          }),
        );
      }, CURSOR_CONNECT_TIMEOUT_MS);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          session.close();
        } catch {
          // Best-effort session close on abort.
        }
        reject(
          new GatewayError("transport_unavailable", 502, "Cursor request aborted", {
            providerId: CURSOR_PROVIDER_ID,
          }),
        );
      };
      session.once("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        context.abort_signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      session.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        context.abort_signal.removeEventListener("abort", onAbort);
        resolve(session);
      });
      if (context.abort_signal.aborted) onAbort();
      else context.abort_signal.addEventListener("abort", onAbort, { once: true });
    });

    const stream = client.request({
      ":method": "POST",
      ":path": CURSOR_RUN_PATH,
      ...buildCursorHeaders(accessToken),
    });
    const payload = buildCursorRunRequest(request.messages, modelId);
    stream.write(frameConnectMessage(payload));
    const state: CursorResponseState = { hasText: false, turnEnded: false };
    const pending = new FrameBuffer();
    let probeIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let probeIdleCompleted = false;
    const armProbeIdleCompletion = (): void => {
      if (!isProbe || !state.hasText || state.turnEnded) return;
      clearTimeout(probeIdleTimer);
      probeIdleTimer = setTimeout(() => {
        if (!state.turnEnded && state.hasText) {
          probeIdleCompleted = true;
          stream.close();
        }
      }, CURSOR_PROBE_IDLE_MS);
    };
    const abortRequest = (): void => {
      stream.close();
      client.close();
    };
    if (context.abort_signal.aborted) abortRequest();
    else context.abort_signal.addEventListener("abort", abortRequest, { once: true });
    const heartbeat = setInterval(() => {
      if (!stream.closed && !stream.destroyed) {
        const heartbeatMessage = create(AgentClientMessageSchema, {
          message: { case: "clientHeartbeat", value: {} },
        });
        stream.write(
          frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeatMessage)),
        );
      }
    }, CURSOR_HEARTBEAT_MS);

    let sequence = 0;
    yield { type: "response_start", sequence_number: sequence++, model: request.model };
    try {
      for await (const chunk of stream) {
        const deltas: string[] = [];
        pending.append(chunk as Buffer);
        const buffered = pending.view();
        const rest = consumeCursorFrames(
          buffered,
          state,
          (server) => {
            stream.write(requestContextFrame(server));
          },
          (caseName) => {
            if (caseName === "textDelta") armProbeIdleCompletion();
          },
          (deltaText) => {
            state.hasText = true;
            deltas.push(deltaText);
          },
        );
        pending.consume(buffered.length - rest.length);
        for (const deltaText of deltas) {
          yield {
            type: "content_delta",
            sequence_number: sequence++,
            content: { kind: "text", text: deltaText },
          };
        }
      }
      if (!state.turnEnded) {
        // Distinguish client cancellation from an upstream stream drop:
        // both surface as an early exit, but only the latter should
        // penalize account health / metrics.
        if (context.abort_signal.aborted) {
          throw new GatewayError(
            "transport_closed",
            499,
            "request was cancelled",
            { providerId: CURSOR_PROVIDER_ID },
          );
        }
        throw new GatewayError(
          "transport_unavailable",
          502,
          "Cursor response ended before turn completion",
          { providerId: CURSOR_PROVIDER_ID },
          "upstream",
        );
      }
    } catch (error) {
      if (!probeIdleCompleted) throw error;
    } finally {
      clearInterval(heartbeat);
      if (probeIdleTimer !== undefined) clearTimeout(probeIdleTimer);
      context.abort_signal.removeEventListener("abort", abortRequest);
      client.close();
    }
    yield {
      type: "terminal",
      sequence_number: sequence++,
      state: "complete",
      stop_reason: "stop",
    };
  }
}

export function createCursorAdapter(options: CursorAdapterOptions = {}): ProviderAdapter {
  return new CursorAdapter(options);
}

export const cursorAdapter: ProviderAdapter = createCursorAdapter();
