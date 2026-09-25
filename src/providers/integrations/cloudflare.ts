// Factory-blocked (Phase C4): composite JSON credential (`{apiKey, accountId}`)
// with per-request `accountId` URL interpolation — the factory's static
// base_url + header-only auth cannot express it; stays bespoke.
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { usageFromProvider } from "../usage";
import { joinUrl, normalizeBearerToken } from "../../protocol/primitives";
import { postUpstreamJson } from "../../protocol/transport/openai";
import { canonicalToChatPayload } from "../../protocol/request/chat";
import { mapChatStopReason } from "../../protocol/response/chat";
import type { ProviderDispatchTarget, ModelDefinition, ProviderAdapter, ProviderDispatchContext } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../provider-metadata";
import type { DiscoveryInput } from "../discovery/discovery-types";

export const CLOUDFLARE_PROVIDER_ID = "cloudflare" as const;
export const CLOUDFLARE_BASE_URL = providerBaseUrl("cloudflare");


interface CloudflareCredential {
  readonly apiKey: string;
  readonly accountId: string;
}

export function parseCredential(value: string): CloudflareCredential {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid credential");
    const record = parsed as Record<string, unknown>;
    if (typeof record["apiKey"] !== "string" || (record["apiKey"] as string).trim().length === 0) throw new Error("missing apiKey");
    if (typeof record["accountId"] !== "string" || !/^[a-f0-9]{32}$/i.test((record["accountId"] as string).trim())) throw new Error("invalid accountId");
    return { apiKey: normalizeBearerToken(record["apiKey"] as string), accountId: (record["accountId"] as string).trim() };
  } catch {
    throw new GatewayError("authentication_failed", 401, "Cloudflare requires JSON credential with apiKey and accountId");
  }
}

// ProviderAdapter — preserves accountId-dependent baseUrl custom logic

interface CloudflareAdapterOptions {
  readonly fetch?: typeof fetch;
}

class CloudflareAdapter implements ProviderAdapter {
  readonly provider_id = CLOUDFLARE_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: CloudflareAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError("capability_unsupported", 400, `cloudflare supports chat only, got ${candidate.wire_family}`);
    }
    const raw = context.credential.secret ? new TextDecoder().decode(context.credential.secret) : "";
    const credential = parseCredential(raw.trim());
    const baseUrl = joinUrl(CLOUDFLARE_BASE_URL, `${credential.accountId}/ai/v1`);
    const endpointPath = candidate.endpoint_path && candidate.endpoint_path.length > 0 ? candidate.endpoint_path : "/v1/chat/completions";
    const fetchUrl = joinUrl(baseUrl, endpointPath);

    const payload = canonicalToChatPayload(request);
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${credential.apiKey}`,
    };

    const { res: response, signal, release } = await postUpstreamJson(fetchUrl, headers, payload, context, outboundFetch);
    try {
      if (!response.ok) throw await mapUpstreamHttpError(response, "cloudflare");

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") || request.stream) {
        if (!response.body) throw new GatewayError("platform_unavailable", 502, "Cloudflare returned empty stream", {}, "upstream");
        let seq = 1;
        yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
        let finishReason: unknown = undefined;
        let rawUsage: Record<string, unknown> | undefined = undefined;
        for await (const sse of decodeSseEvents(response.body as ReadableStream<Uint8Array>, { signal })) {
          const data = sse.data.trim();
          if (!data || data === "[DONE]") continue;
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(data) as Record<string, unknown>;
          } catch {
            throw new GatewayError("platform_unavailable", 502, "Malformed Cloudflare SSE event", {}, "upstream");
          }
          rawUsage = (json["usage"] as Record<string, unknown>) ?? rawUsage;
          const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
          for (const choice of choices) {
            const delta = choice["delta"] as Record<string, unknown> | undefined;
            if (typeof delta?.["content"] === "string") {
              yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: delta["content"] as string } } as CanonicalEvent;
            }
            const calls = delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
            if (calls) {
              for (const call of calls) {
                const fn = call["function"] as Record<string, unknown> | undefined;
                yield {
                  type: "tool_call_delta",
                  sequence_number: seq++,
                  call_id: (call["id"] as string) ?? "call",
                  name: fn?.["name"] as string | undefined,
                  arguments_delta: (fn?.["arguments"] as string) ?? "",
                } as CanonicalEvent;
              }
            }
            finishReason = choice["finish_reason"] ?? finishReason;
          }
        }
        const chatStop = mapChatStopReason(finishReason);
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          ...(chatStop === undefined ? {} : { stop_reason: chatStop }),
          ...(typeof finishReason === "string" ? { provider_stop_reason: finishReason as string } : {}),
          usage: usageFromProvider(rawUsage),
        } as CanonicalEvent;
        return;
      }

      const json = (await response.json()) as Record<string, unknown>;
      const id = (json["id"] as string) ?? "resp_cf";
      const model = (json["model"] as string) ?? request.model;
      let seq = 1;
      yield { type: "response_start", sequence_number: seq++, event_id: id, model } as CanonicalEvent;
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.["message"] as Record<string, unknown> | undefined;
      if (message) {
        const content = message["content"] as string | null;
        if (content) yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: content } } as CanonicalEvent;
        const toolCalls = message["tool_calls"] as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const fn = tc["function"] as Record<string, unknown> | undefined;
            yield { type: "tool_call_delta", sequence_number: seq++, call_id: tc["id"] as string, name: fn?.["name"] as string, arguments_delta: fn?.["arguments"] as string } as CanonicalEvent;
          }
        }
      }
      const rawUsage = json["usage"] as Record<string, unknown> | undefined;
      const providerStop = first?.["finish_reason"];
      yield {
        type: "terminal",
        sequence_number: seq++,
        state: "complete",
        ...(mapChatStopReason(providerStop) === undefined ? {} : { stop_reason: mapChatStopReason(providerStop) }),
        ...(typeof providerStop === "string" ? { provider_stop_reason: providerStop } : {}),
        usage: usageFromProvider(rawUsage),
      } as CanonicalEvent;
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      if ((err as Error).name === "AbortError") throw new GatewayError("transport_closed", 499, "request was cancelled");
      throw err;
    } finally {
      release();
    }
  }
}

export function createCloudflareAdapter(options: CloudflareAdapterOptions = {}): ProviderAdapter {
  return new CloudflareAdapter(options);
}

export async function discoverCloudflareModels(input: DiscoveryInput): Promise<readonly ModelDefinition[] | null> {
  let accountId: string | null = null;
  let apiKey: string | null = null;
  try {
    const parsed: unknown = JSON.parse(input.credential);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec["accountId"] === "string" && (rec["accountId"] as string).trim().length > 0) {
        accountId = (rec["accountId"] as string).trim();
      }
      if (typeof rec["apiKey"] === "string" && (rec["apiKey"] as string).trim().length > 0) {
        apiKey = (rec["apiKey"] as string).trim();
      }
    }
  } catch {
    return null;
  }
  if (!accountId || !apiKey) return null;
  return fetchOpenAICompatibleModels({
    baseUrl: `${providerBaseUrl("cloudflare")}/${accountId}/ai/v1`,
    headers: { authorization: `Bearer ${apiKey}` },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
