import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Adapter, ProviderCallError, ProviderMeta, ProviderOutput, ProviderRequest, ProviderUsage, RouteTarget, StreamEvent, Surface } from "../application/contracts";
import { ProviderAdapterError, toProviderCallError } from "../open-sse/transport/errors";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog } from "../open-sse/transport/catalog";
import type { ProviderCatalogAdapter } from "../open-sse/transport/contracts";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  ExecClientMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./cursor/proto-gen/agent_pb";
import { connectCursorProxy } from "./cursor/socket";

const CURSOR_BASE_URL = "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_PATH = "/agent.v1.AgentService/Run";
const CURSOR_SURFACES = ["openai-chat", "openai-responses"] as const;
const CURSOR_MODELS = [
  ["default", "Auto", false],
  ["claude-4.5-opus-high", "Claude 4.5 Opus", true],
  ["claude-4.5-sonnet", "Claude 4.5 Sonnet", true],
  ["claude-4.6-opus-high", "Claude 4.6 Opus", true],
  ["claude-4.6-sonnet-medium", "Claude 4.6 Sonnet", true],
  ["composer-1", "Composer 1", false],
  ["composer-1.5", "Composer 1.5", false],
  ["composer-2.5", "Composer 2.5", false],
  ["composer-2.5-fast", "Composer 2.5 Fast", false],
] as const;

type QueueItem = StreamEvent | { type: "error"; error: unknown } | { type: "end" };

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined as never, done: true });
  }
  async next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.closed) return { value: undefined as never, done: true };
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

function modelOf(id: string, displayName: string, reasoning: boolean) {
  return { id, displayName, capabilities: capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning, toolCalls: false, images: false }) };
}

function describeCursor(): ProviderCatalogAdapter {
  const models = CURSOR_MODELS.map(([id, name, reasoning]) => modelOf(id, name, reasoning));
  const fallback = capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true, toolCalls: false, images: false });
  const metadata: ProviderMeta = {
    id: "cursor",
    displayName: "Cursor",
    protocol: "openai",
    credentialKind: "oauth",
    credentialKinds: ["oauth", "api_key", "manual"],
    credentialUrl: "https://www.cursor.com/settings",
  };
  return {
    metadata,
    capabilities: aggregateCapabilities(models, fallback),
    models: createModelCatalog(models),
    resolveTarget(modelId: string, surface: Surface): RouteTarget {
      if (!CURSOR_SURFACES.includes(surface as (typeof CURSOR_SURFACES)[number])) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Cursor does not support surface "${surface}"`, statusCode: 400, routeScope: null });
      const model = models.find(entry => entry.id === modelId) ?? models.find(entry => entry.id === "default");
      return { providerId: "cursor", modelId: model?.id ?? modelId, upstreamModelId: model?.id ?? modelId, surface };
    },
  };
}

function textFromMessage(message: ProviderRequest["request"]["messages"][number]): string {
  return message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

function frame(data: Uint8Array, flags = 0): Buffer {
  const result = Buffer.allocUnsafe(data.length + 5);
  result[0] = flags;
  result.writeUInt32BE(data.length, 1);
  result.set(data, 5);
  return result;
}

function requestBytes(input: ProviderRequest): Uint8Array {
  const messages = input.request.messages;
  const lastUser = [...messages].reverse().find(message => message.role === "user");
  const history = messages.filter(message => message !== lastUser && message.role !== "system" && message.role !== "developer").map(message => `${message.role}: ${textFromMessage(message)}`).join("\n\n");
  const system = messages.filter(message => message.role === "system" || message.role === "developer").map(textFromMessage).filter(Boolean).join("\n\n");
  const prompt = [history ? `Conversation history:\n${history}` : "", lastUser ? textFromMessage(lastUser) : ""].filter(Boolean).join("\n\n");
  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, {
        userMessage: create(UserMessageSchema, { text: prompt, messageId: crypto.randomUUID() }),
        sendToInteractionListener: true,
      }),
    },
  });
  const run = create(AgentRunRequestSchema, {
    conversationState: create(ConversationStateStructureSchema, {}),
    action,
    modelDetails: create(ModelDetailsSchema, { modelId: input.target.upstreamModelId, displayModelId: input.target.upstreamModelId, displayName: input.target.modelId }),
    requestedModel: create(RequestedModelSchema, { modelId: input.target.upstreamModelId, maxMode: false }),
    conversationId: crypto.randomUUID(),
    ...(system ? { customSystemPrompt: system } : {}),
  });
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "runRequest", value: run } }));
}

function usage(outputTokens: number): ProviderUsage {
  return { inputTokens: null, outputTokens, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" };
}

function connectClient(baseUrl: string, proxyUrl: string | null, signal: AbortSignal): Promise<http2.ClientHttp2Session> {
  if (!proxyUrl) return Promise.resolve(http2.connect(baseUrl));
  return connectCursorProxy(proxyUrl, baseUrl, signal).then(socket => http2.connect(baseUrl, { createConnection: () => socket }));
}

async function* cursorEvents(input: ProviderRequest, baseUrl: string): AsyncGenerator<StreamEvent> {
  const queue = new AsyncQueue<QueueItem>();
  const client = await connectClient(baseUrl, input.network.url, input.signal);
  const request = client.request({
    ":method": "POST",
    ":path": CURSOR_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${input.credential}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID(),
  });
  let pending = Buffer.alloc(0);
  const id = crypto.randomUUID();
  let outputTokens = 0;
  let turnEnded = false;
  queue.push({ type: "message_start", id });
  const finish = (error?: unknown) => { if (error) queue.push({ type: "error", error }); queue.push({ type: "end" }); queue.close(); client.close(); };
  request.on("data", (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < length + 5) break;
      const flags = pending[0] ?? 0;
      const payload = pending.subarray(5, length + 5);
      pending = pending.subarray(length + 5);
      if ((flags & 1) !== 0) continue;
      try {
        const server = fromBinary(AgentServerMessageSchema, payload);
        if (server.message.case === "execServerMessage") {
          const execMessage = create(ExecClientMessageSchema, { id: server.message.value.id, execId: server.message.value.execId });
          const clientMessage = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execMessage } });
          request.write(frame(toBinary(AgentClientMessageSchema, clientMessage)));
          continue;
        }
        if (server.message.case !== "interactionUpdate") continue;
        const update = server.message.value.message;
        if (update.case === "textDelta") queue.push({ type: "text_delta", text: update.value.text });
        else if (update.case === "thinkingDelta") queue.push({ type: "thinking_delta", text: update.value.text });
        else if (update.case === "tokenDelta") outputTokens += update.value.tokens;
        else if (update.case === "turnEnded") turnEnded = true;
      } catch (error) {
        finish(error);
      }
    }
  });
  request.once("response", headers => {
    const status = Number(headers[":status"] ?? 0);
    if (status < 200 || status >= 300) finish(new ProviderAdapterError({ kind: status === 401 ? "authentication_failed" : "provider_unavailable", message: `Cursor returned HTTP ${status}`, statusCode: status, retryable: status >= 500, routeScope: status === 401 ? "account" : "provider" }));
  });
  request.once("error", finish);
  request.once("end", () => { queue.push({ type: "usage", usage: usage(outputTokens) }); if (turnEnded) queue.push({ type: "message_stop", reason: "completed" }); finish(); });
  input.signal.addEventListener("abort", () => request.close(), { once: true });
  request.end(frame(requestBytes(input)));
  for (;;) {
    const item = await queue.next();
    if (item.done) break;
    if (item.value.type === "error") throw item.value.error;
    if (item.value.type === "end") break;
    yield item.value;
  }
}

export function createCursorAdapter(): Adapter {
  const catalog = describeCursor();
  return {
    ...catalog,
    async call(input): Promise<ProviderOutput> {
      if (!input.credential) throw new ProviderAdapterError({ kind: "authentication_failed", message: "Cursor access token is required", statusCode: 401, routeScope: "account" });
      if (input.request.tools.length > 0) throw new ProviderAdapterError({ kind: "capability_unsupported", message: "Cursor adapter does not expose upstream tool execution through Cartethyia", statusCode: 400, routeScope: null });
      if (!catalog.capabilities.surfaces.includes(input.target.surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Cursor does not support surface "${input.target.surface}"`, statusCode: 400, routeScope: null });
      const events = cursorEvents(input, CURSOR_BASE_URL);
      if (input.request.stream) return { mode: "stream", events };
      let text = "";
      let finalUsage: ProviderUsage | undefined;
      for await (const event of events) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "usage") finalUsage = event.usage;
      }
      return { mode: "non_stream", body: { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: input.target.modelId, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], ...(finalUsage ? { usage: finalUsage } : {}) }, ...(finalUsage ? { usage: finalUsage } : {}) };
    },
    mapError(error: unknown): ProviderCallError { return toProviderCallError(error); },
  };
}
