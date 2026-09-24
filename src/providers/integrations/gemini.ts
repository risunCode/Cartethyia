// Factory-blocked (Phase C4): Gemini native generateContent RPC envelope
// (per-model `:generateContent`/`:streamGenerateContent` paths, `contents`/
// `candidates` shapes, `x-goog-api-key`) — non-OpenAI wire; stays bespoke.
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { normalizeUsage } from "../usage";
import { readCredentialSecret, type ProviderDispatchTarget, type ModelDefinition, type ProviderAdapter, type ProviderDispatchContext } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { isRecord } from "../../protocol/primitives";
import { providerBaseUrl } from "../provider-metadata";
import { createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import { geminiModelUrl, buildGeminiPayload } from "../../protocol/request/gemini";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  responseParts,
  mapGeminiUsage,
  toCanonicalStopReason,
} from "../../protocol/response/gemini";

// Gemini provider constants.

export const GEMINI_BASE_URL = providerBaseUrl("gemini");
export const GEMINI_PROVIDER_ID = "gemini" as const;



import { defineModel } from "../model-definition";

export const GEMINI_MODELS: readonly ModelDefinition[] = [
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
].map((id) =>
  defineModel({ id, endpoint: "/v1beta/models", ctx: 1_000_000, out: 32768, vision: true, reasoning: true }),
);

import type { DiscoveryInput } from "../discovery/discovery-types";


// SSE mapper
// (removed: dead pre-refactor `geminiSseToCanonical` helper — live dispatch
// parses SSE chunks directly below)

// Dispatch — manual, preserves x-goog-api-key header & v1beta baseUrl

export interface GeminiAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class GeminiAdapter implements ProviderAdapter {
  readonly provider_id = GEMINI_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GeminiAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat" && candidate.wire_family !== "responses" && candidate.wire_family !== "messages") {
      throw new GatewayError("capability_unsupported", 400, `gemini supports chat/responses/messages, got ${candidate.wire_family}`);
    }
    const apiKey = readCredentialSecret(context.credential, "Gemini API key is required");

    const model = candidate.model_id || request.model;
    const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = geminiModelUrl(this.baseUrl, model, action);

    const payload = buildGeminiPayload(request);
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, "gemini");

      // Headers arrived: the pre-stream deadline has served its purpose.
      // From here the gateway stall/first-chunk watchdog (propagated via
      // context.abort_signal) governs the body. Keeping this timer armed
      // would kill healthy long streams at the stale pre-stream deadline.
      lifecycle.release();

      if (!request.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const { candidate: cand, parts } = geminiCandidate(json);
        const output = responseParts(parts);
        let seq = 1;
        yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
        if (output.thought) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: output.thought } } as CanonicalEvent;
        }
        if (output.text) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
        }
        for (const call of output.calls) {
          yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, name: call.name, arguments_delta: JSON.stringify(call.args) } as CanonicalEvent;
        }
        const usageRec = normalizeUsage(mapGeminiUsage(json) as Record<string, unknown>);
        const reason = toCanonicalStopReason(cand, output.calls.length);
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          stop_reason: reason,
          provider_stop_reason: typeof cand["finishReason"] === "string" ? (cand["finishReason"] as string) : undefined,
          usage: usageRec,
        } as CanonicalEvent;
        return;
      }

      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Gemini returned empty stream", {}, "upstream");
      let seq = 1;
      yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
      const state = { started: true, stopped: false, activeCalls: new Set<string>() };
      let rawUsage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      let outputCalls = 0;
      for await (const sse of decodeSseEvents(response.body as ReadableStream<Uint8Array>, { signal: lifecycle.signal })) {
        const data = sse.data.trim();
        if (!data || data === "[DONE]") continue;
        const parsed = decodeGeminiStreamEvent(data, "Gemini stream error");
        if (parsed === undefined) continue;
        const { candidate: cand, parts } = geminiCandidate(parsed);
        const output = responseParts(parts);
        if (output.thought) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "reasoning", payload: null, summary: output.thought } } as CanonicalEvent;
        }
        if (output.text) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
        }
        for (const call of output.calls) {
          if (!state.activeCalls.has(call.id)) {
            state.activeCalls.add(call.id);
            yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, name: call.name, arguments_delta: "" } as CanonicalEvent;
          }
          const argsText = JSON.stringify(call.args);
          if (argsText !== "{}") {
            yield { type: "tool_call_delta", sequence_number: seq++, call_id: call.id, arguments_delta: argsText } as CanonicalEvent;
          }
          outputCalls++;
        }
        if (isRecord(parsed["usageMetadata"])) rawUsage = parsed["usageMetadata"] as Record<string, unknown>;
        if (typeof cand["finishReason"] === "string") {
          finishReason = cand["finishReason"] as string;
          state.stopped = true;
        }
      }
      const stopMap: Record<string, CanonicalStopReason> = { MAX_TOKENS: "length", STOP: "stop", SAFETY: "content_filter" };
      const stopReason: CanonicalStopReason = finishReason ? (stopMap[finishReason] ?? (outputCalls > 0 ? "tool_use" : "stop")) : outputCalls > 0 ? "tool_use" : "stop";
      // No finishReason means the stream ended without a terminal chunk:
      // truncated, never complete.
      const truncated = finishReason === undefined;
      // Prefer usageMetadata if present, else empty
      const usageRec = normalizeUsage(((rawUsage ? mapGeminiUsage({ usageMetadata: rawUsage }) : {}) as Record<string, unknown>));
      if (context.abort_signal.aborted || truncated) {
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: truncated ? "failed" : "aborted",
          stop_reason: stopReason,
          ...(finishReason ? { provider_stop_reason: finishReason } : {}),
          usage: usageRec,
        } as CanonicalEvent;
      } else {
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          stop_reason: stopReason,
          ...(finishReason ? { provider_stop_reason: finishReason } : {}),
          usage: usageRec,
        } as CanonicalEvent;
      }
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

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): ProviderAdapter {
  return new GeminiAdapter(options);
}

export async function discoverGeminiModels(input: DiscoveryInput): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl("gemini"),
    headers: { "x-goog-api-key": input.credential },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
