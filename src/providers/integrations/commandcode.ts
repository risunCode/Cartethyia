// Factory-blocked (Phase C4): proprietary `{threadId, config, params}`
// envelope with NDJSON stream transform — non-OpenAI wire; stays bespoke.
import { GatewayError } from "../../transport/gateway-error";
import { canContainToolResult, joinTextParts, toolCallParts, toolResultParts } from "../../transport/canonical-model";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../transport/canonical-model";
import { normalizeUsage } from "../usage";
import { readCredentialSecret, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";
import {
  getCommandCodeVersion,
  resolveCommandCodeVersion,
} from "../operations/client-versions";
export const COMMANDCODE_MODELS: readonly ModelDefinition[] = [
  "moonshotai/Kimi-K2.6",
  "qwen/qwen3.5-plus",
  "minimax/minimax-m2.7-highspeed",
  "z-ai/glm-5.1",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast",
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Max",
  "xiaomi/mimo-v2.5-pro",
  "poolside/laguna-s-2.1-free",
  "nvidia/nemotron-3-ultra-550b-a55b",
].map((id) =>
  defineModel({ id, providerId: "commandcode", endpoint: "/alpha/generate", vision: true, reasoning: true }),
);


// CommandCode provider constants.

export const COMMANDCODE_BASE_URL = providerBaseUrl("commandcode");
export const COMMANDCODE_PROVIDER_ID = "commandcode" as const;
const COMMANDCODE_DEFAULT_MAX_TOKENS = 4096;

export function convertMessages(messages: CanonicalRequest["messages"]): { messages: Array<Record<string, unknown>>; system?: string } {
  const out: Array<Record<string, unknown>> = [];
  let system: string | undefined;
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = joinTextParts(message.content);
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }
    // Answers live in `tool` turns or in `user` turns (the Messages ledger
    // re-homes them). Checking only `role: "tool"` dropped every result from a
    // Messages-origin history, leaving the assistant's `tool_calls` unanswered.
    if (canContainToolResult(message)) {
      for (const block of toolResultParts(message)) {
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        out.push({ role: "tool", tool_call_id: block.call_id, content });
      }
      // Any non-result content on the same turn still follows as a user turn;
      // a turn that was nothing but results must not emit an empty one.
      const remaining = message.content.filter((part) => part.kind !== "toolResult");
      const remainingText = joinTextParts(remaining);
      if (message.role === "tool") continue;
      if (remainingText.length > 0) out.push({ role: "user", content: remainingText });
      continue;
    }
    if (message.role === "assistant") {
      const text = joinTextParts(message.content);
      const toolCalls = toolCallParts(message).map((b) => ({ id: b.call_id, type: "function" as const, function: { name: b.name, arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments) } }));
      const msg: Record<string, unknown> = { role: "assistant" };
      msg["content"] = text.length > 0 ? text : toolCalls.length > 0 ? null : "";
      if (toolCalls.length > 0) msg["tool_calls"] = toolCalls;
      out.push(msg);
      continue;
    }
    out.push({ role: "user", content: joinTextParts(message.content) });
  }
  if (system === undefined) return { messages: out };
  return { messages: out, system };
}

export function buildRequest(
  modelId: string,
  request: { messages: CanonicalRequest["messages"]; tools: { readonly name: string; readonly description: string | undefined; readonly jsonSchema: unknown }[]; maxOutputTokens: number | null },
  threadId: string,
  systemExtra?: string,
): Record<string, unknown> {
  const { messages, system: systemFromMessages } = convertMessages(request.messages);
  const systemCombined = systemExtra ? (systemFromMessages ? `${systemExtra}\n${systemFromMessages}` : systemExtra) : systemFromMessages;
  const params: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    max_tokens: request.maxOutputTokens ?? COMMANDCODE_DEFAULT_MAX_TOKENS,
    temperature: 0.3,
  };
  if (systemCombined) params["system"] = systemCombined;
  if (request.tools.length > 0) {
    params["tools"] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? undefined,
      input_schema: tool.jsonSchema,
    }));
  }
  return {
    threadId,
    memory: "",
    config: {
      workingDir: "",
      date: new Date().toISOString().slice(0, 10),
      environment: "",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

export async function headers(sessionId: string, token: string): Promise<Record<string, string>> {
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveCommandCodeVersion();
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "x-command-code-version": getCommandCodeVersion(),
    "x-cli-environment": "cli",
    "x-session-id": sessionId,
  };
}


type StreamState = { toolIndexById: Map<string, number>; nextToolIndex: number; finishReason: string | undefined; usage: Record<string, unknown> | undefined };

function ccEventString(event: Record<string, unknown>, key: string): string | undefined {
  const v = event[key];
  return typeof v === "string" ? v : undefined;
}
function ccEventNumber(record: Record<string, unknown>, key: string): number | undefined {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function ccMapFinishReason(reason: string): CanonicalStopReason {
  return reason === "length" ? "length" : reason === "tool_calls" ? "tool_use" : reason === "content_filter" ? "content_filter" : "stop";
}

export function transformLine(line: string, state: StreamState, seqBase: number): CanonicalEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = ccEventString(event, "type");
  if (!type) return [];
  if (type === "text-delta" || type === "reasoning-delta") {
    const text = ccEventString(event, "text") || ccEventString(event, "delta");
    return text ? [{ type: "content_delta", sequence_number: seqBase, content: { kind: "text", text } } as CanonicalEvent] : [];
  }
  if (type === "tool-input-start") {
    const id = ccEventString(event, "id") || ccEventString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: ccEventString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent];
  }
  if (type === "tool-input-delta") {
    const id = ccEventString(event, "id") || ccEventString(event, "toolCallId");
    const delta = ccEventString(event, "delta") || ccEventString(event, "inputTextDelta");
    if (!id || !delta || !state.toolIndexById.has(id)) return [];
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, arguments_delta: delta } as CanonicalEvent];
  }
  if (type === "tool-call") {
    const id = ccEventString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    const input = typeof event["input"] === "string" ? (event["input"] as string) : JSON.stringify(event["input"] ?? {});
    return [
      { type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: ccEventString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent,
      { type: "tool_call_delta", sequence_number: seqBase + 1, call_id: id, arguments_delta: input } as CanonicalEvent,
    ];
  }
  if (type === "finish-step") {
    const reason = ccEventString(event, "finishReason");
    if (reason) state.finishReason = reason;
    if (typeof event["usage"] === "object" && event["usage"] !== null && !Array.isArray(event["usage"])) state.usage = event["usage"] as Record<string, unknown>;
    return [];
  }
  if (type === "finish") {
    const reason = state.finishReason ?? ccEventString(event, "finishReason") ?? "stop";
    const canonicalReason = ccMapFinishReason(reason);
    const events: CanonicalEvent[] = [
      { type: "terminal", sequence_number: seqBase, state: "complete", stop_reason: canonicalReason, provider_stop_reason: reason } as CanonicalEvent,
    ];
    if (state.usage) {
      const prompt = ccEventNumber(state.usage, "promptTokens") ?? ccEventNumber(state.usage, "inputTokens") ?? 0;
      const completion = ccEventNumber(state.usage, "completionTokens") ?? ccEventNumber(state.usage, "outputTokens") ?? 0;
      const total = ccEventNumber(state.usage, "totalTokens") ?? prompt + completion;
      const cached = ccEventNumber(state.usage, "cachedTokens") ?? ccEventNumber(state.usage, "cacheReadTokens") ?? 0;
      const usageRecord = normalizeUsage({
        input_tokens: prompt,
        output_tokens: completion,
        total_tokens: total,
        cached_tokens: cached,
        cache_creation_input_tokens: ccEventNumber(state.usage, "cacheWriteTokens") ?? undefined,
      } as unknown as Record<string, unknown>);
      // Append usage to terminal
      (events[0] as unknown as Record<string, unknown>)["usage"] = usageRecord;
    }
    return events;
  }
  if (type === "error") {
    const raw = (event["error"] ?? event["message"] ?? event) as unknown;
    const rawMessage = typeof raw === "string" ? raw : JSON.stringify(raw);
    throw new GatewayError("platform_unavailable", 502, rawMessage.slice(0, 500), {}, "upstream");
  }
  return [];
}

/** NDJSON transform — beta-style simple loop + signal-aware read for abort/timeout propagation. */
export async function* transformNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = { toolIndexById: new Map(), nextToolIndex: 0, finishReason: undefined, usage: undefined };
  let buffer = "";
  let hasTerminal = false;
  let seq = 1;
  // initial response_start
  yield { type: "response_start", sequence_number: seq++, model: "commandcode" } as CanonicalEvent;

  const readWithAbort = (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (signal.aborted) throw new GatewayError("transport_closed", 499, "Command Code stream aborted");
    const { promise, resolve, reject } = Promise.withResolvers<{ done: boolean; value?: Uint8Array }>() as unknown as { promise: Promise<{ done: boolean; value?: Uint8Array }>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
    const onAbort = (): void => {
      if (signal.aborted) reject(new GatewayError("transport_closed", 499, "Command Code stream aborted"));
      else reject(new GatewayError("platform_unavailable", 502, "Command Code stream error", {}, "upstream"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    return promise;
  };

  try {
    while (true) {
      const { done, value } = await readWithAbort();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          let evs: CanonicalEvent[] = [];
          try {
            evs = transformLine(line, state, seq);
          } catch (e) {
            throw e;
          }
          for (const ev of evs) {
            // Strictly increasing per line, in emission order: the Responses
            // surface throws on any non-monotonic sequence mid-stream, after
            // partial bytes are already flushed. No special-casing for
            // dual-event lines — order is order.
            (ev as unknown as Record<string, unknown>)["sequence_number"] = seq++;
            if (ev.type === "terminal") hasTerminal = true;
            yield ev;
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      for (const ev of transformLine(tail, state, seq)) {
        if (ev.type === "terminal") hasTerminal = true;
        (ev as unknown as Record<string, unknown>)["sequence_number"] = seq++;
        yield ev;
      }
    }
    if (!hasTerminal) {
      // NDJSON ended with no terminal envelope: truncated, never complete.
      yield { type: "terminal", sequence_number: seq++, state: "failed", stop_reason: ccMapFinishReason(state.finishReason ?? "stop"), provider_stop_reason: state.finishReason ?? "stop" } as CanonicalEvent;
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Best-effort reader unlock during stream cleanup.
    }
    void reader.cancel().catch(() => {});
  }
}

// CommandCode model catalog.



// ProviderAdapter — manual NDJSON dispatch, NOT a factory wrapper

interface CommandCodeAdapterOptions {
  readonly fetch?: typeof fetch;
}

class CommandCodeAdapter implements ProviderAdapter {
  readonly provider_id = COMMANDCODE_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: CommandCodeAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError("capability_unsupported", 400, `commandcode supports chat only, got ${candidate.wire_family}`);
    }
    const token = readCredentialSecret(context.credential, "Command Code bearer token is required");

    // Tools: only function tools
    const tools = (request.tools ?? []).map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
    // Extract system from request.system + instructions for buildRequest extra handling
    const systemExtraParts: string[] = [];
    if (request.system) for (const p of request.system) if (p.kind === "text") systemExtraParts.push(p.text);
    if (request.instructions) for (const p of request.instructions) if (p.kind === "text") systemExtraParts.push(p.text);
    const systemExtra = systemExtraParts.join("\n") || undefined;

    const maxOutputTokens =
      typeof (request.generation_controls as Record<string, unknown>)["max_tokens"] === "number"
        ? ((request.generation_controls as Record<string, unknown>)["max_tokens"] as number)
        : typeof (request.generation_controls as Record<string, unknown>)["max_output_tokens"] === "number"
          ? ((request.generation_controls as Record<string, unknown>)["max_output_tokens"] as number)
          : null;

    const sessionId = crypto.randomUUID();


const upstreamModelId = candidate.model_id || request.model;
    const payload = buildRequest(upstreamModelId, { messages: request.messages, tools, maxOutputTokens }, sessionId, systemExtra);

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const url =
      candidate.endpoint_path && candidate.endpoint_path.startsWith("http") ? candidate.endpoint_path : COMMANDCODE_BASE_URL;

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers: await headers(sessionId, token),
        body: JSON.stringify(payload),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, "commandcode");
      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Command Code returned empty body", {}, "upstream");

      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();

      // For both stream and non-stream, the upstream always streams NDJSON (beta behavior).
      // We yield NDJSON-decoded canonical events; the caller handles non-stream buffering via terminal.
      if (!request.stream) {
        for await (const ev of transformNdjson(response.body as ReadableStream<Uint8Array>, lifecycle.signal)) {
          yield ev;
        }
        return;
      }

      yield* transformNdjson(response.body as ReadableStream<Uint8Array>, lifecycle.signal);
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

export function createCommandCodeAdapter(options: CommandCodeAdapterOptions = {}): ProviderAdapter {
  return new CommandCodeAdapter(options);
}

