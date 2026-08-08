import { AbortCoordinator, ProviderAdapterError, capabilitiesOf, createModelCatalog, executeFetch, modelOf, readJsonObject, readUpstreamError, toProviderCallError } from "../open-sse/transport/shared";
import { isRecord, messageText } from "../application/protocols";
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
  StreamEvent,
  StopReason,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";
import type { NormalizedMessage } from "../application/contracts";

/**
 * Command Code — https://api.commandcode.ai/alpha/generate — an NDJSON
 * streaming gateway authenticated with a bearer API key (user_…). Speaks an
 * Anthropic-shaped tool-calling protocol over a Vercel AI SDK NDJSON stream;
 * the adapter translates the normalized request into Command Code's envelope
 * and decodes the NDJSON delta/finish events into canonical stream events.
 */

const COMMANDCODE_SURFACES: readonly Surface[] = ["openai-chat"];
const COMMANDCODE_URL = "https://api.commandcode.ai/alpha/generate";
const COMMANDCODE_VERSION = "1.4.4";
const DEFAULT_MAX_TOKENS = 4096;

const COMMANDCODE_MODELS: readonly ProviderModel[] = [
  modelOf("moonshotai/Kimi-K2.6", "Kimi K2.6", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("qwen/qwen3.5-plus", "Qwen 3.5 Plus", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("minimax/minimax-m2.7-highspeed", "MiniMax M2.7", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("z-ai/glm-5.1", "GLM 5.1", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("moonshotai/Kimi-K3", "Kimi K3", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("zai-org/GLM-5.2", "GLM 5.2", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("zai-org/GLM-5.2-Fast", "GLM 5.2 Fast", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("MiniMaxAI/MiniMax-M3", "MiniMax M3", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("xiaomi/mimo-v2.5-pro", "Xiaomi MiMo v2.5 Pro", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
  modelOf("poolside/laguna-s-2.1-free", "Poolside Laguna S 2.1 Free", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true })),
  modelOf("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true })),
];

const COMMANDCODE_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: COMMANDCODE_SURFACES, reasoning: true, images: true });


function convertMessages(messages: readonly NormalizedMessage[]): { messages: Array<{ role: "user" | "assistant" | "tool"; content: Array<Record<string, unknown>> }>; system?: string } {
  const out: Array<{ role: "user" | "assistant" | "tool"; content: Array<Record<string, unknown>> }> = [];
  let system: string | undefined;
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = messageText(message);
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }
    const role: "user" | "assistant" | "tool" = message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user";
    out.push({ role, content: [{ type: "text", text: messageText(message) }] });
  }
  return { messages: out, system };
}

function buildCommandCodeRequest(modelId: string, request: { messages: readonly NormalizedMessage[]; tools: readonly { readonly name: string; readonly description: string | null; readonly inputSchema: Record<string, unknown> }[]; maxOutputTokens: number | null }, threadId: string): Record<string, unknown> {
  const { messages, system } = convertMessages(request.messages);
  const params: Record<string, unknown> = { model: modelId, messages, stream: true, max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS, temperature: 0.3 };
  if (system) params.system = system;
  if (request.tools.length > 0) params.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? undefined, input_schema: tool.inputSchema }));
  return { threadId, memory: "", config: { workingDir: "", date: new Date().toISOString().slice(0, 10), environment: "", structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] }, params };
}

function commandCodeHeaders(sessionId: string, token: string): Record<string, string> {
  return { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}`, "x-command-code-version": COMMANDCODE_VERSION, "x-cli-environment": "cli", "x-session-id": sessionId };
}

interface DecoderState { toolIndexById: Map<string, number>; nextToolIndex: number; finishReason: string | undefined; usage: Record<string, unknown> | undefined; }
function eventString(event: Record<string, unknown>, key: string): string | undefined { const value = event[key]; return typeof value === "string" ? value : undefined; }
function eventNumber(record: Record<string, unknown>, key: string): number | undefined { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function mapFinishReason(reason: string): StopReason { return reason === "length" ? "length" : reason === "tool_calls" ? "tool_call" : reason === "content_filter" ? "content_filter" : "completed"; }

function decodeCommandCodeLine(line: string, state: DecoderState): StreamEvent[] {
  let event: Record<string, unknown>;
  try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
  const type = eventString(event, "type");
  if (!type) return [];
  if (type === "text-delta" || type === "reasoning-delta") { const text = eventString(event, "text") || eventString(event, "delta"); return text ? [{ type: "text_delta", text }] : []; }
  if (type === "tool-input-start") { const id = eventString(event, "id") || eventString(event, "toolCallId"); if (!id || state.toolIndexById.has(id)) return []; state.toolIndexById.set(id, state.nextToolIndex++); return [{ type: "tool_call_start", callId: id, name: eventString(event, "toolName") ?? "" }]; }
  if (type === "tool-input-delta") { const id = eventString(event, "id") || eventString(event, "toolCallId"); const delta = eventString(event, "delta") || eventString(event, "inputTextDelta"); if (!id || !delta || !state.toolIndexById.has(id)) return []; return [{ type: "tool_call_delta", callId: id, delta }]; }
  if (type === "tool-call") { const id = eventString(event, "toolCallId"); if (!id || state.toolIndexById.has(id)) return []; state.toolIndexById.set(id, state.nextToolIndex++); const input = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {}); return [{ type: "tool_call_start", callId: id, name: eventString(event, "toolName") ?? "" }, { type: "tool_call_delta", callId: id, delta: input }]; }
  if (type === "finish-step") { const reason = eventString(event, "finishReason"); if (reason) state.finishReason = reason; if (isRecord(event.usage)) state.usage = event.usage; return []; }
  if (type === "finish") { const events: StreamEvent[] = [{ type: "message_stop", reason: mapFinishReason(state.finishReason ?? eventString(event, "finishReason") ?? "stop") }]; if (state.usage) { events.push({ type: "usage", usage: { inputTokens: eventNumber(state.usage, "promptTokens") ?? eventNumber(state.usage, "inputTokens") ?? null, outputTokens: eventNumber(state.usage, "completionTokens") ?? eventNumber(state.usage, "outputTokens") ?? null, totalTokens: null, cacheReadTokens: eventNumber(state.usage, "cacheReadTokens") ?? null, cacheWriteTokens: eventNumber(state.usage, "cacheWriteTokens") ?? null, source: "provider" } }); } return events; }
  if (type === "error") { const value = event.error ?? event.message ?? "unknown"; throw new ProviderAdapterError({ kind: "provider_protocol_error", message: `Command Code stream error: ${typeof value === "string" ? value : JSON.stringify(value)}`, routeScope: "provider" }); }
  return [];
}

async function* decodeCommandCodeNdjson(body: ReadableStream<Uint8Array>, coordinator: AbortCoordinator): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: DecoderState = { toolIndexById: new Map(), nextToolIndex: 0, finishReason: undefined, usage: undefined };
  let buffer = "";
  try {
    while (true) {
      if (coordinator.signal.aborted) throw new ProviderAdapterError({ kind: "client_aborted", message: "Command Code stream aborted", routeScope: null });
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) for (const event of decodeCommandCodeLine(line, state)) yield event; newline = buffer.indexOf("\n"); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) for (const event of decodeCommandCodeLine(buffer.trim(), state)) yield event;
    yield { type: "message_stop", reason: mapFinishReason(state.finishReason ?? "stop") };
  } finally { reader.releaseLock?.(); }
}

/** Command Code is a bearer-authenticated NDJSON streaming gateway. */
export class CommandCodeAdapter implements Adapter {
  readonly metadata: ProviderMeta = { id: "commandcode", displayName: "Command Code", protocol: "anthropic", credentialKind: "api_key" };
  readonly models: ProviderModelCatalog = createModelCatalog(COMMANDCODE_MODELS);
  readonly capabilities: ProviderCaps = { ...COMMANDCODE_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-chat") throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    if (input.credential.length === 0) throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Command Code bearer API key is required.", statusCode: 401, routeScope: "account" });
    const { request, signal, network } = input;
    const sessionId = crypto.randomUUID();
    const payload = buildCommandCodeRequest(input.target.modelId, request, sessionId);
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(COMMANDCODE_URL, { method: "POST", headers: commandCodeHeaders(sessionId, input.credential), body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) { const body = await readJsonObject(response, coordinator); return { mode: "non_stream", body }; }
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Command Code returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: decodeCommandCodeNdjson(response.body, coordinator) };
    } finally { if (!streamHandedOff) coordinator.dispose(); }
  }

  mapError(error: unknown): ProviderCallError { return toProviderCallError(error); }
}

