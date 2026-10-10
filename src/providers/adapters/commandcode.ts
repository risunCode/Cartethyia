// Factory-blocked (Phase C4): proprietary `{threadId, config, params}`
// envelope with NDJSON stream transform — non-OpenAI wire; stays bespoke.
import { GatewayError } from "../../protocol/gateway-error";
import { canContainToolResult, joinTextParts, toolCallParts, toolResultParts } from "../../protocol/canonical-model";
import {
  classifyUpstreamError,
  extractUpstreamMessage,
  mapUpstreamHttpError,
  upstreamErrorIdentifier,
} from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason, ContentPart } from "../../protocol/canonical-model";
import { isRecord, readNumber, readString, resolveImageSource, splitDataUrl } from "../../protocol/codecs";
import { usageFromProvider } from "../usage";
import { readCredentialSecret, type ProviderDispatchTarget, type ProviderAdapter, type ProviderDispatchContext } from "../contracts";
import { providerBaseUrl } from "../metadata";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../model-definition";
import {
  getCommandCodeVersion,
} from "../operations/client-versions";
import { MimoThinkSplitter } from "../integrations/xiaomi-mimo/think-stream";
export const COMMANDCODE_MODELS: readonly ModelDefinition[] = [
  // Synced from https://commandcode.ai/models — deepseek keep only v4.1 flash/pro
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.6-pro",
  "xiaomi/mimo-v2.6-pro-ultraspeed",
  "xiaomi/mimo-v2.6-flash",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-fast",
  "deepseek/deepseek-v4-pro",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K3",
  "zai-org/GLM-5",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.3-Flash",
  "MiniMaxAI/MiniMax-M2.5",
  "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.7-Max",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.8-Flash",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-Max-0902",
  "Qwen/Qwen3.8-Omni-Flash",
  "Qwen/Qwen3.8-27B",
  "stepfun/Step-3.5-Flash",
  "stepfun/Step-3.7-Flash",
  "stepfun/Step-5-Preview",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "poolside/laguna-s-2.1-free",
].map((id) =>
  defineModel({ id, providerId: "commandcode", endpoint: "/alpha/generate", vision: true, reasoning: true }),
);


// CommandCode provider constants.

export const COMMANDCODE_BASE_URL = providerBaseUrl("commandcode");
export const COMMANDCODE_PROVIDER_ID = "commandcode" as const;
const COMMANDCODE_DEFAULT_MAX_TOKENS = 4096;

/**
 * The `/alpha/generate` wire, as the CLI client sends it:
 *  - `params.system` is a top-level string; system turns never enter `messages`
 *  - every `content` is an array of blocks, never a string
 *  - an assistant tool call is `{type:"tool-call", toolCallId, toolName, input}`
 *    and is preceded by a reasoning block, which the upstream requires
 *  - a tool result is its own `role:"tool"` turn, not text glued into the user turn
 *  - an image is `{type:"image", image, mimeType}`
 */
function toolResultValue(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function imageBlock(payload: unknown): Record<string, unknown> | undefined {
  const source = resolveImageSource(payload);
  if (source?.url === undefined) return undefined;
  const inline = splitDataUrl(source.url);
  return { type: "image", image: source.url, ...(inline ? { mimeType: inline.mediaType } : {}) };
}

function contentBlocks(parts: readonly ContentPart[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.kind === "image") {
      const block = imageBlock(part.payload);
      if (block) blocks.push(block);
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function parsedInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function convertMessages(messages: CanonicalRequest["messages"]): {
  messages: Array<Record<string, unknown>>;
  system?: string;
} {
  const out: Array<Record<string, unknown>> = [];
  const systemTexts: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = joinTextParts(message.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    // Answers live in `tool` turns or in `user` turns (the Messages ledger
    // re-homes them). Each result is its own `role:"tool"` turn: flattening
    // them into the user turn as prose left the tool call unanswered.
    if (canContainToolResult(message) && toolResultParts(message).length > 0) {
      for (const result of toolResultParts(message)) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: result.call_id,
              toolName: "",
              output: { type: "text", value: toolResultValue(result.content) },
            },
          ],
        });
      }
      const remainder = contentBlocks(message.content.filter((part) => part.kind !== "toolResult"));
      if (remainder.some((block) => block["text"] !== "")) out.push({ role: "user", content: remainder });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const calls = toolCallParts(message);
      const reasoning = message.content
        .filter((part) => part.kind === "reasoning")
        .map((part) => part.summary ?? "")
        .filter((text) => text.length > 0)
        .join("");
      if (reasoning.length > 0 || calls.length > 0) {
        blocks.push({ type: "reasoning", text: reasoning.length > 0 ? reasoning : " " });
      }
      const text = joinTextParts(message.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      for (const call of calls) {
        blocks.push({
          type: "tool-call",
          toolCallId: call.call_id,
          toolName: call.name,
          input: parsedInput(call.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    out.push({ role: "user", content: contentBlocks(message.content) });
  }
  const system = systemTexts.join("\n\n");
  return system.length > 0 ? { messages: out, system } : { messages: out };
}

export function buildRequest(
  modelId: string,
  request: { messages: CanonicalRequest["messages"]; tools: { readonly name: string; readonly description: string | undefined; readonly jsonSchema: unknown }[]; maxOutputTokens: number | null; temperature: number | null; topP: number | null; reasoningEffort: string | null },
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
    temperature: request.temperature ?? 0.3,
  };
  if (request.topP !== null) params["top_p"] = request.topP;
  if (request.reasoningEffort !== null && request.reasoningEffort !== "none") {
    params["reasoning_effort"] = request.reasoningEffort;
  }
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
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "x-command-code-version": getCommandCodeVersion(),
    "x-cli-environment": "cli",
    "x-session-id": sessionId,
  };
}


type StreamState = { toolIndexById: Map<string, number>; nextToolIndex: number; finishReason: string | undefined; usage: Record<string, unknown> | undefined; think: MimoThinkSplitter };

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
  const type = readString(event, "type");
  if (!type) return [];
  if (type === "reasoning-delta") {
    const text = readString(event, "text") || readString(event, "delta");
    return text ? [{ type: "content_delta", sequence_number: seqBase, content: { kind: "reasoning", payload: null, summary: text } } as CanonicalEvent] : [];
  }
  if (type === "text-delta") {
    const text = readString(event, "text") || readString(event, "delta");
    if (!text) return [];
    const split = state.think.push(text);
    const events: CanonicalEvent[] = [];
    if (split.reasoning) events.push({ type: "content_delta", sequence_number: seqBase, content: { kind: "reasoning", payload: null, summary: split.reasoning } } as CanonicalEvent);
    if (split.text) events.push({ type: "content_delta", sequence_number: seqBase, content: { kind: "text", text: split.text } } as CanonicalEvent);
    return events;
  }
  if (type === "tool-input-start") {
    const id = readString(event, "id") || readString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: readString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent];
  }
  if (type === "tool-input-delta") {
    const id = readString(event, "id") || readString(event, "toolCallId");
    const delta = readString(event, "delta") || readString(event, "inputTextDelta");
    if (!id || !delta || !state.toolIndexById.has(id)) return [];
    return [{ type: "tool_call_delta", sequence_number: seqBase, call_id: id, arguments_delta: delta } as CanonicalEvent];
  }
  if (type === "tool-call") {
    const id = readString(event, "toolCallId");
    if (!id || state.toolIndexById.has(id)) return [];
    state.toolIndexById.set(id, state.nextToolIndex++);
    const input = typeof event["input"] === "string" ? (event["input"] as string) : JSON.stringify(event["input"] ?? {});
    return [
      { type: "tool_call_delta", sequence_number: seqBase, call_id: id, name: readString(event, "toolName") ?? "", arguments_delta: "" } as CanonicalEvent,
      { type: "tool_call_delta", sequence_number: seqBase + 1, call_id: id, arguments_delta: input } as CanonicalEvent,
    ];
  }
  if (type === "finish-step") {
    const reason = readString(event, "finishReason");
    if (reason) state.finishReason = reason;
    if (typeof event["usage"] === "object" && event["usage"] !== null && !Array.isArray(event["usage"])) state.usage = event["usage"] as Record<string, unknown>;
    return [];
  }
  if (type === "finish") {
    const reason = state.finishReason ?? readString(event, "finishReason") ?? "stop";
    const canonicalReason = ccMapFinishReason(reason);
    const events: CanonicalEvent[] = [
      { type: "terminal", sequence_number: seqBase, state: "complete", stop_reason: canonicalReason, provider_stop_reason: reason } as CanonicalEvent,
    ];
    if (state.usage) {
      const prompt = readNumber(state.usage, "promptTokens") ?? readNumber(state.usage, "inputTokens") ?? 0;
      const completion = readNumber(state.usage, "completionTokens") ?? readNumber(state.usage, "outputTokens") ?? 0;
      const total = readNumber(state.usage, "totalTokens") ?? prompt + completion;
      const cached = readNumber(state.usage, "cachedTokens") ?? readNumber(state.usage, "cacheReadTokens") ?? 0;
      const usageRecord = usageFromProvider({
        input_tokens: prompt,
        output_tokens: completion,
        total_tokens: total,
        cached_tokens: cached,
        cache_creation_input_tokens: readNumber(state.usage, "cacheWriteTokens") ?? undefined,
      } as unknown as Record<string, unknown>);
      // Append usage to terminal
      (events[0] as unknown as Record<string, unknown>)["usage"] = usageRecord;
    }
    return events;
  }
  if (type === "error") {
    const raw = event["error"] ?? event["message"] ?? event;
    const errorObject = isRecord(raw) ? raw : event;
    const identifier = upstreamErrorIdentifier(raw) ?? upstreamErrorIdentifier(event);
    const providerStatus = [
      errorObject["status"],
      errorObject["statusCode"],
      errorObject["code"],
      event["status"],
      event["statusCode"],
      event["code"],
    ].find(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 400 &&
        value < 600,
    );
    const classification = classifyUpstreamError(providerStatus, identifier);
    const message =
      extractUpstreamMessage(raw) ||
      extractUpstreamMessage(event) ||
      "Command Code stream error";
    throw new GatewayError(
      classification.code,
      classification.status,
      message.slice(0, 500),
      {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(identifier ? { providerCode: identifier } : {}),
        ...(classification.credentialEvidence ? { credentialEvidence: true } : {}),
        ...(classification.rateLimitScope
          ? { rateLimitScope: classification.rateLimitScope }
          : {}),
      },
      classification.origin,
    );
  }
  return [];
}

/** NDJSON transform — beta-style simple loop + signal-aware read for abort/timeout propagation. */
export async function* transformNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = { toolIndexById: new Map(), nextToolIndex: 0, finishReason: undefined, usage: undefined, think: new MimoThinkSplitter() };
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
    const rest = state.think.flush();
    if (rest.reasoning) yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: rest.reasoning } } as CanonicalEvent;
    if (rest.text) yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: rest.text } } as CanonicalEvent;
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

    const controls = request.generation_controls as Record<string, unknown>;
    const maxOutputTokens =
      typeof controls["max_tokens"] === "number"
        ? controls["max_tokens"]
        : typeof controls["max_output_tokens"] === "number"
          ? controls["max_output_tokens"]
          : null;
    const temperature = typeof controls["temperature"] === "number" ? controls["temperature"] : null;
    const topP = typeof controls["top_p"] === "number" ? controls["top_p"] : null;
    const reasoningEffort = request.reasoning?.effort ?? null;

    const sessionId = crypto.randomUUID();

    const upstreamModelId = candidate.model_id || request.model;
    const payload = buildRequest(
      upstreamModelId,
      { messages: request.messages, tools, maxOutputTokens, temperature, topP, reasoningEffort },
      sessionId,
      systemExtra,
    );

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
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createCommandCodeAdapter(options: CommandCodeAdapterOptions = {}): ProviderAdapter {
  return new CommandCodeAdapter(options);
}

