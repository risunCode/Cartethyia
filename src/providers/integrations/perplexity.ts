import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import { normalizeUsage } from "../usage";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { createUpstreamDeadlineLifecycle } from "../operations/upstream-deadline";
import { normalizeBearerToken } from "../../protocol/primitives";

export const PERPLEXITY_BASE_URL = providerBaseUrl("perplexity");
export const PERPLEXITY_PROVIDER_ID = "perplexity" as const;
export const PERPLEXITY_SEARCH_ENDPOINT = `${PERPLEXITY_BASE_URL}/search`;



import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const PERPLEXITY_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "perplexity-search",
    wireFamily: "chat",
    endpoint: "/search",
    ctx: null,
    out: null,
    toolCall: false,
    webSearch: true,
  }),
  defineModel({
    id: "perplexity-deep-research",
    wireFamily: "chat",
    endpoint: "/search",
    ctx: null,
    out: null,
    reasoning: true,
    toolCall: false,
    webSearch: true,
  }),
];


function extractSearchQuery(request: CanonicalRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const msg = request.messages[i];
    if (msg?.role === "user") {
      const text = msg.content
        .filter((p) => p.kind === "text")
        .map((p) => (p as { kind: "text"; text: string }).text)
        .join("\n")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

function tokenFromContext(context: ProviderDispatchContext): string {
  const secret = context.credential.secret;
  if (!secret || secret.length === 0) return "";
  const raw = new TextDecoder().decode(secret).trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = parsed["accessToken"] ?? parsed["api_key"] ?? parsed["apiKey"];
      if (typeof v === "string" && v.length > 0) return v.trim();
    } catch {
      // fall through
    }
  }
  return normalizeBearerToken(raw);
}


export function createPerplexityAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return {
    provider_id: PERPLEXITY_PROVIDER_ID,
    async *dispatch(
      request: CanonicalRequest,
      _candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      void _candidate;
      const query = extractSearchQuery(request);
      if (!query) {
        throw new GatewayError("invalid_request", 400, "Search query is required.");
      }
      const token = tokenFromContext(context);
      if (!token) {
        throw new GatewayError("authentication_failed", 401, "Missing Perplexity API key");
      }

      const fetchFn = (context.outbound_fetch as unknown as typeof fetch | undefined) ?? fetchImpl ?? globalThis.fetch;

      const lifecycle = createUpstreamDeadlineLifecycle(context);

      let response: Response;
      try {
        response = await fetchFn(PERPLEXITY_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query, num_results: 10 }),
          signal: lifecycle.signal,
        });
      } catch (error: unknown) {
        if (lifecycle.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new GatewayError("transport_closed", 499, "request was cancelled");
        }
        throw error;
      } finally {
        lifecycle.release();
      }

      if (!response.ok) throw await mapUpstreamHttpError(response, "perplexity");

      // Malformed or empty JSON response body safely defaults to empty object.
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const rawResults = json["results"];
      const results = Array.isArray(rawResults) ? (rawResults as Array<Record<string, unknown>>) : [];
      const answer = typeof json["answer"] === "string" ? (json["answer"] as string) : undefined;
      const contentFallback = typeof json["content"] === "string" ? (json["content"] as string) : undefined;

      const rendered =
        results.length > 0
          ? results
              .map((item) => {
                const title = String(item["title"] ?? "Result");
                const url = String(item["url"] ?? "");
                const snippet = String(item["snippet"] ?? item["summary"] ?? "");
                return `[${title}](${url})\n${snippet}`;
              })
              .join("\n\n---\n\n")
          : (answer ?? contentFallback ?? "No results found.");

      const rawUsage = (json["usage"] as Record<string, unknown> | undefined) ?? {};
      const usage = normalizeUsage(rawUsage);
      const eventId = `perplexity-${crypto.randomUUID()}`;

      yield { type: "response_start", sequence_number: 1, event_id: eventId, model: request.model } as CanonicalEvent;
      yield {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "text", text: rendered },
      } as CanonicalEvent;
      yield {
        type: "terminal",
        sequence_number: 3,
        state: "complete",
        stop_reason: "stop",
        provider_stop_reason: "stop",
        usage,
      } as CanonicalEvent;
    },
  };
}
