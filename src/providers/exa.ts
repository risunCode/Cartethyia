import { AbortCoordinator,
ProviderAdapterError,
aggregateCapabilities,
capabilitiesOf,
createModelCatalog,
executeFetch,
lineLimit,
mapSseStream,
modelOf,
readJsonObject,
readUpstreamError,
toProviderCallError, } from "../open-sse/transport/shared";
import { isRecord } from "../application/protocols";
import type { SseEvent, StreamMapper } from "../open-sse/transport/shared";
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
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";

/**
 * Exa AI — Web Search API (https://api.exa.ai)
 * Provides neural/keyword search with content extraction.
 * Not a chat model; exposes search as a tool-callable capability.
 */

const EXA_SURFACES: readonly Surface[] = ["web-search"];
const EXA_BASE_URL = "https://api.exa.ai";

const EXA_MODELS: readonly ProviderModel[] = [
  modelOf("exa-search", "Exa Neural Search", capabilitiesOf({ surfaces: EXA_SURFACES })),
  modelOf("exa-deep-research", "Exa Deep Researcher", capabilitiesOf({ surfaces: EXA_SURFACES })),
];

const EXA_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: EXA_SURFACES });

export interface ExaAdapterConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialKind?: "api_key" | "none";
  readonly models?: readonly ProviderModel[];
}

interface ExaSearchRequest {
  query: string;
  type?: "neural" | "keyword" | "auto" | "fast" | "deep";
  category?: string;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startCrawlDate?: string;
  endCrawlDate?: string;
  contents?: {
    text?: boolean | { maxCharacters?: number; includeHtmlTags?: boolean };
    highlights?: boolean | { numSentences?: number; highlightsPerUrl?: number; query?: string };
    summary?: boolean | { query?: string };
    subpages?: number;
    subpageTarget?: "sources" | "all";
    extras?: { links?: number; imageLinks?: number };
  };
  stream?: boolean;
  outputSchema?: Record<string, unknown>;
  systemPrompt?: string;
  additionalQueries?: string[];
}

interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  id: string;
  image?: string;
  favicon?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
  score?: number;
}


interface ExaStreamChunk {
  type: "result" | "cost" | "done";
  result?: ExaSearchResult;
  costDollars?: { total: number };
  requestId?: string;
}

export class ExaAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;

  constructor(config: ExaAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? EXA_BASE_URL).replace(/\/+$/, "");
    const models = config.models ?? EXA_MODELS;
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, EXA_FALLBACK_CAPABILITIES);
    const hasEnvironmentCredential = (Bun.env.EXA_API_KEY?.trim().length ?? 0) > 0;
    this.metadata = {
      id: config.id ?? "exa",
      displayName: config.displayName ?? "Exa AI",
      protocol: "exa",
      credentialKind: config.credentialKind ?? (hasEnvironmentCredential ? "none" : "api_key"),
    };
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({
        kind: "model_not_found",
        message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`,
        statusCode: 404,
        routeScope: "provider",
      });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!this.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    const credential = input.credential.trim() || Bun.env.EXA_API_KEY?.trim() || "";
    if (credential.length === 0) {
      throw new ProviderAdapterError({
        kind: "authentication_failed",
        message: "Exa API key is required. Add an Exa account or set EXA_API_KEY.",
        statusCode: 401,
        routeScope: "account",
      });
    }
    const { request, signal, network } = input;
    const helperRequest = isClaudeWebSearchRequest(request);
    const stream = request.stream && !helperRequest;
    const messages = request.messages;
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const rawQuery = lastUserMessage ? lastUserMessage.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : "";
    const helperQuery = /^Perform a web search for the query:\s*(.+)$/is.exec(rawQuery.trim())?.[1];
    const query = (helperQuery ?? rawQuery).trim();

    if (!query) {
      throw new ProviderAdapterError({
        kind: "invalid_request",
        message: "Search query is required.",
        statusCode: 400,
        routeScope: null,
      });
    }

    const searchRequest: ExaSearchRequest = {
      query,
      type: "auto",
      numResults: 10,
      contents: {
        text: { maxCharacters: 3000 },
        highlights: true,
        summary: { query: "Main points" },
      },
      stream,
    };


    // Check for tool calls that might specify search parameters
    for (const tool of request.tools) {
      if (tool.name === "web_search" || tool.name === "exa_search") {
        const schema = tool.inputSchema as Record<string, unknown>;
        if (schema.type === "object" && isRecord(schema.properties)) {
          const props = schema.properties;
          const typeProp = props.type;
          if (isRecord(typeProp) && Array.isArray(typeProp.enum) && typeProp.enum.length > 0) {
            searchRequest.type = typeProp.enum[0] as ExaSearchRequest["type"];
          }
          const numResultsProp = props.numResults;
          if (isRecord(numResultsProp) && typeof numResultsProp.default === "number" && Number.isFinite(numResultsProp.default)) {
            searchRequest.numResults = Math.max(1, Math.floor(numResultsProp.default));
          }
        }
      }
    }

    const coordinator = new AbortCoordinator(signal, {
      connectTimeoutMs: request.limits.connectTimeoutMs,
      totalTimeoutMs: request.limits.totalTimeoutMs,
    });

    let streamHandedOff = false;
    try {
      const response = await executeFetch(
        `${this.baseUrl}/search`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: request.stream ? "text/event-stream" : "application/json",
            "x-api-key": credential,
          },
          body: JSON.stringify(searchRequest),
        },
        coordinator,
        network,
        input.capture,
      );

      if (!response.ok) throw await readUpstreamError(response);

      if (!stream) {
        const body = await readJsonObject(response, coordinator);
        return { mode: "non_stream", body: this.formatSearchResponse(body, query) };
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("application/json")) {
        const body = this.formatSearchResponse(await readJsonObject(response, coordinator), query);
        return { mode: "stream", events: streamJsonSearchResponse(body) };
      }
      if (response.body === null) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Exa returned an empty stream body", routeScope: "provider" });
      }

      streamHandedOff = true;
      const events = mapSseStream(
        { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
        createExaMapper(),
      );
      return { mode: "stream", events };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  private formatSearchResponse(body: Record<string, unknown>, query: string): Record<string, unknown> {
    const results = isRecord(body) && Array.isArray(body.results)
      ? body.results.filter(isExaSearchResult)
      : [];
    const content = results.map((r) => {
      const parts = [`[${r.title}](${r.url})`];
      if (r.publishedDate) parts.push(`Published: ${r.publishedDate}`);
      if (r.author) parts.push(`Author: ${r.author}`);
      if (r.summary) parts.push(`Summary: ${r.summary}`);
      if (r.highlights?.length) parts.push(`Highlights: ${r.highlights.join("; ")}`);
      if (r.text) parts.push(`Content: ${r.text.slice(0, 1000)}`);
      return parts.join("\n");
    }).join("\n\n---\n\n") || "No results found.";

    return {
      id: `exa-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "exa-search",
      search_query: query,
      search_results: results,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

}
function isClaudeWebSearchRequest(request: ProviderRequest["request"]): boolean {
  if (request.sourceSurface !== "anthropic-messages" || !request.tools.some((tool) => tool.name === "web_search")) return false;
  const systemText = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content)
    .map((block) => block.text ?? "")
    .join("\n");
  const userText = [...request.messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content
    .map((block) => block.text ?? "")
    .join("\n")
    .trim() ?? "";
  return systemText.includes("assistant for performing a web search tool use")
    && /^Perform a web search for the query:\s*\S/i.test(userText);
}

function isExaSearchResult(value: unknown): value is ExaSearchResult {
  return isRecord(value) && typeof value.title === "string" && typeof value.url === "string" && typeof value.id === "string";
}

function isExaStreamChunk(value: unknown): value is ExaStreamChunk {
  return isRecord(value) && (value.type === "result" || value.type === "cost" || value.type === "done");
}

async function* streamJsonSearchResponse(body: Record<string, unknown>): AsyncIterable<StreamEvent> {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice !== null && isRecord(choice.message) ? choice.message : null;
  const text = message !== null && typeof message.content === "string" ? message.content : "No results found.";
  yield { type: "message_start", id: typeof body.id === "string" ? body.id : `exa-${crypto.randomUUID()}` };
  yield { type: "text_delta", text };
  yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, source: "unknown" } };
  yield { type: "message_stop", reason: "completed" };
}

function createExaMapper(): StreamMapper {
  let started = false;
  let usageEmitted = false;
  return (sse: SseEvent): StreamEvent | readonly StreamEvent[] | null => {
    if (sse.data === "[DONE]") {
      return [{ type: "message_stop", reason: "completed" }];
    }
    try {
      const parsed = JSON.parse(sse.data);
      if (!isExaStreamChunk(parsed)) return null;
      if (parsed.type === "result" && isExaSearchResult(parsed.result)) {
        const result = parsed.result;
        const text = `[${result.title}](${result.url})\n${result.summary ?? ""}\n${result.highlights?.join("\n") ?? ""}`;
        if (!started) {
          started = true;
          return [
            { type: "message_start", id: `exa-${crypto.randomUUID()}` },
            { type: "text_delta", text },
          ];
        }
        return { type: "text_delta", text: "\n\n---\n\n" + text };
      }
      // Exa is a search API — it reports dollar cost, not token usage. Emit a
      // zero-token usage event so the stream carries a usage terminal and the
      // caller records the request, matching the non-stream path's usage.
      if (parsed.type === "cost" && !usageEmitted) {
        usageEmitted = true;
        return { type: "usage", usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "unknown" } };
      }
      if (parsed.type === "done") {
        return [{ type: "message_stop", reason: "completed" }];
      }
      return null;
    } catch {
      return null;
    }
  };
}

export const exaModelCatalog = EXA_MODELS;