import {
  DevinAccountLimitError,
  DevinApiError,
  DevinAuthError,
  DevinQuotaError,
  streamDevin,
  type ChatMessage,
  type ChatTool,
  type DevinModel,
} from "devin-router";
import {
  AbortCoordinator,
  ProviderAdapterError,
  aggregateCapabilities,
  capabilitiesOf,
  createModelCatalog,
  modelOf,
  toProviderCallError,
} from "../open-sse/transport/shared";
import { buildProxyFetcher } from "../traffic";
import type {
  Adapter,
  ContentBlock,
  ProviderCallError,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderUsage,
  RouteTarget,
  StreamEvent,
  Surface,
} from "../application/contracts";
import type { ProxyRequest } from "../application/contracts";

const DEVIN_API_URL = "https://server.codeium.com";

const DEVIN_SURFACES: readonly Surface[] = ["openai-chat"];
const DEVIN_MODEL_ID = "swe-1-6-slow";
const DEVIN_MODEL = modelOf(
  DEVIN_MODEL_ID,
  "SWE-1.6 Slow",
  capabilitiesOf({ surfaces: DEVIN_SURFACES, reasoning: true, toolCalls: true }),
  { context: { inputTokens: 200_000, outputTokens: 64_000 } },
);
const DEVIN_MODELS: readonly ProviderModel[] = [DEVIN_MODEL];
const DEVIN_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: DEVIN_SURFACES, reasoning: true, toolCalls: true });

type DevinStreamState = {
  readonly id: string;
  readonly activeTools: Set<string>;
  usage: ProviderUsage | undefined;
};

export class DevinAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "devin",
    displayName: "Devin",
    protocol: "devin",
    credentialKind: "api_key",
    credentialKinds: ["api_key"],
  };
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;

  constructor() {
    this.models = createModelCatalog(DEVIN_MODELS);
    this.capabilities = aggregateCapabilities(DEVIN_MODELS, DEVIN_FALLBACK_CAPABILITIES);
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    this.assertSurface(surface);
    const model = this.models.get(modelId);
    if (model === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the Devin catalog`, statusCode: 404, routeScope: "provider" });
    }
    return { providerId: this.metadata.id, modelId, upstreamModelId: model.upstreamId ?? model.id, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertInput(input);
    const credential = normalizeCredential(input.credential);
    if (credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "Devin JWT/API key is required.", statusCode: 401, routeScope: "account" });
    }
    if (input.request.images.length > 0) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: "Devin does not support image inputs.", statusCode: 400, routeScope: "provider" });
    }

    const model: DevinModel = {
      id: input.target.upstreamModelId,
      name: DEVIN_MODEL.displayName,
      contextLength: DEVIN_MODEL.context?.inputTokens ?? 200_000,
      maxTokens: input.request.maxOutputTokens ?? DEVIN_MODEL.context?.outputTokens ?? 64_000,
      baseUrl: DEVIN_API_URL,
    };
    const coordinator = new AbortCoordinator(input.signal, {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      totalTimeoutMs: input.request.limits.totalTimeoutMs,
      idleTimeoutMs: input.request.limits.idleTimeoutMs,
    });
    const stream = this.stream(input, model, credential, coordinator);
    if (input.request.stream) return { mode: "stream", events: stream };

    try {
      return await collectNonStream(stream, input.target.modelId);
    } finally {
      coordinator.dispose();
    }
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

  private stream(input: ProviderRequest, model: DevinModel, credential: string, coordinator: AbortCoordinator): AsyncIterable<StreamEvent> {
    const fetchImpl = createDevinFetch(input);
    const messages = toDevinMessages(input.request);
    const tools = toDevinTools(input.request);
    const systemPrompt = input.request.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .map((block) => block.text ?? "")
      .filter((text) => text.length > 0)
      .join("\n\n");
    const state: DevinStreamState = { id: `devin-${crypto.randomUUID()}`, activeTools: new Set(), usage: undefined };
    return this.mapStream(
      streamDevin(model, { messages, systemPrompt }, { messages, tools, maxTokens: model.maxTokens, signal: coordinator.signal, fetch: fetchImpl }, credential),
      state,
      coordinator,
    );
  }

  private async *mapStream(source: AsyncIterable<{ type: string; text?: string; id?: string; name?: string; args?: string; input?: number; output?: number; stopReason?: string; error?: Error }>, state: DevinStreamState, coordinator: AbortCoordinator): AsyncIterable<StreamEvent> {
    let started = false;
    const start = (): StreamEvent => {
      started = true;
      return { type: "message_start", id: state.id };
    };

    try {
      for await (const chunk of source) {
        coordinator.resetIdle();
        if (!started) yield start();
        if (chunk.type === "text" && chunk.text) yield { type: "text_delta", text: chunk.text };
        else if (chunk.type === "thinking" && chunk.text) yield { type: "thinking_delta", text: chunk.text };
        else if (chunk.type === "tool_call" && chunk.id && chunk.name) {
          if (!state.activeTools.has(chunk.id)) {
            state.activeTools.add(chunk.id);
            yield { type: "tool_call_start", callId: chunk.id, name: chunk.name };
          }
          if (chunk.args) yield { type: "tool_call_delta", callId: chunk.id, delta: chunk.args };
        } else if (chunk.type === "usage" && typeof chunk.input === "number" && typeof chunk.output === "number") {
          state.usage = { inputTokens: chunk.input, outputTokens: chunk.output, totalTokens: chunk.input + chunk.output, cacheReadTokens: null, cacheWriteTokens: null, source: "provider" };
          yield { type: "usage", usage: state.usage };
        } else if (chunk.type === "error") {
          throw chunk.error ?? new Error("Devin returned an unknown stream error");
        } else if (chunk.type === "done") {
          const reason = chunk.stopReason === "length" ? "length" : state.activeTools.size > 0 ? "tool_call" : "completed";
          for (const callId of state.activeTools) yield { type: "tool_call_end", callId };
          state.activeTools.clear();
          yield { type: "message_stop", reason };
          return;
        }
      }
      for (const callId of state.activeTools) yield { type: "tool_call_end", callId };
      yield { type: "message_stop", reason: "completed" };
    } catch (error) {
      throw mapDevinError(error);
    } finally {
      coordinator.dispose();
    }
  }

  private assertSurface(surface: Surface): void {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Devin does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
  }

  private assertInput(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Devin cannot serve provider "${input.target.providerId}"`, statusCode: 400, routeScope: null });
    }
    this.assertSurface(input.target.surface);
    if (!input.request.stream && input.request.responseFormat !== "text") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: "Devin only supports text responses.", statusCode: 400, routeScope: "provider" });
    }
  }
}

function normalizeCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("bearer")) return trimmed.slice(6).trim();
  return trimmed;
}

function toDevinMessages(request: ProxyRequest): ChatMessage[] {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
      const toolBlocks = message.role === "assistant"
        ? message.content.filter((block): block is ContentBlock & { readonly toolName: string } => block.type === "tool_use" && typeof block.toolName === "string" && block.toolName.length > 0)
        : [];
      const toolCalls = toolBlocks.map((block) => ({ id: block.toolCallId ?? crypto.randomUUID(), type: "function" as const, function: { name: block.toolName, arguments: block.toolArguments ?? "{}" } }));
      const role = message.role === "system" ? "developer" : message.role;
      return {
        role,
        content: [message.reasoningContent, text].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n"),
        ...(role === "tool" ? { toolCallId: message.content.find((block) => block.type === "tool_result")?.toolCallId, isError: message.content.some((block) => block.toolResultIsError === true) } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    });
}

function toDevinTools(request: ProxyRequest): ChatTool[] {
  return request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.inputSchema } }));
}

function createDevinFetch(input: ProviderRequest) {
  const transport = input.network.url === null ? fetch : buildProxyFetcher({ url: input.network.url, isRelay: input.network.isRelay });
  const wrapped = async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    if (init?.body !== undefined) input.capture?.request("[devin protobuf request]");
    const response = await transport(url, init ?? {});
    return input.capture?.observeResponse(response) ?? response;
  };
  return Object.assign(wrapped, { preconnect: fetch.preconnect.bind(fetch) });
}

async function collectNonStream(events: AsyncIterable<StreamEvent>, model: string): Promise<Extract<ProviderOutput, { mode: "non_stream" }>> {
  let id = `devin-${crypto.randomUUID()}`;
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: ProviderUsage | undefined;
  const tools = new Map<string, { name: string; arguments: string }>();
  for await (const event of events) {
    if (event.type === "message_start") id = event.id;
    else if (event.type === "text_delta") content += event.text;
    else if (event.type === "thinking_delta") reasoning += event.text;
    else if (event.type === "tool_call_start") tools.set(event.callId, { name: event.name, arguments: "" });
    else if (event.type === "tool_call_delta") {
      const call = tools.get(event.callId);
      if (call) call.arguments += event.delta;
    } else if (event.type === "usage") usage = event.usage;
    else if (event.type === "message_stop") finishReason = event.reason === "length" ? "length" : event.reason === "tool_call" ? "tool_calls" : "stop";
  }
  const message: Record<string, unknown> = { role: "assistant", content: content.length > 0 ? content : null };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (tools.size > 0) message.tool_calls = [...tools.entries()].map(([callId, call]) => ({ id: callId, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } }));
  return {
    mode: "non_stream",
    body: {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: usage.totalTokens ?? 0 } } : {}),
    },
    ...(usage ? { usage } : {}),
  };
}

function mapDevinError(error: unknown): Error {
  if (error instanceof ProviderAdapterError || error instanceof TypeError) return error;
  if (error instanceof DevinAuthError) return new ProviderAdapterError({ kind: "authentication_failed", message: error.message, statusCode: error.statusCode, routeScope: "account" });
  if (error instanceof DevinQuotaError) return new ProviderAdapterError({ kind: "quota_exceeded", message: error.message, statusCode: error.statusCode, retryable: true, routeScope: "account" });
  if (error instanceof DevinAccountLimitError) return new ProviderAdapterError({ kind: "provider_rate_limited", message: error.message, statusCode: error.statusCode, retryable: true, routeScope: "account" });
  if (error instanceof DevinApiError) return new ProviderAdapterError({ kind: error.statusCode >= 500 ? "provider_unavailable" : "provider_protocol_error", message: error.message, statusCode: error.statusCode, retryable: error.statusCode >= 500, routeScope: "provider" });
  return error instanceof Error ? new ProviderAdapterError({ kind: "provider_protocol_error", message: error.message, routeScope: "provider" }) : new ProviderAdapterError({ kind: "provider_protocol_error", message: "Unknown Devin provider error", routeScope: "provider" });
}
