/**
 * The routed web-search fallback bridge.
 *
 * A chat client (Claude Code, Codex CLI, …) declares a hosted `web_search`
 * tool and expects the upstream to execute it. When the route the caller
 * selected cannot serve that tool natively, the search is executed here by one
 * of the operator-configured search providers (`/v1/search`'s own adapters),
 * and the normalized hits are injected into the conversation as a completed
 * web-search tool round — so the selected model still writes the answer, now
 * with real sources, and the client's own tool loop stays intact.
 *
 * This module never answers the client: it only produces the search results
 * and the canonical turns that carry them. Dispatch, encoding, accounting, and
 * failover remain the ordinary proxy path's job.
 */
import { GatewayError } from "../../protocol/gateway-error";
import { log } from "../../observability/logger";
import type { CanonicalEvent, CanonicalRequest, SourceSurface } from "../../protocol/canonical-model";
import type { RouteCandidate } from "../routing/route-model";
import { extractWebSearchInvocation, isWebSearchTool, isWebSearchToolName } from "../translation/search";
import type { ProviderAdapter, ProviderDispatchTarget, WebSearchOutcome } from "../../providers/contracts";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { ProxyRequestState } from "../request/state";

/** One search round executed by a configured fallback provider. */
export interface WebSearchBridgeResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly query: string;
  readonly results: WebSearchOutcome;
  /**
   * The client's own `tool_use` id, when the search arrived as a hosted tool
   * call. The completed round must be addressed back to it or the client's
   * pending call is never closed and it re-issues the search — see
   * {@link WebSearchInvocation.callId}.
   */
  readonly callId?: string;
}

/** Collaborators the bridge reads from the dispatch handler. */
export interface WebSearchBridgeDeps {
  readonly db: CartethyiaDatabase;
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly providerAdapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
}

export interface WebSearchBridgeInput {
  readonly state: ProxyRequestState;
  readonly deps: WebSearchBridgeDeps;
  readonly request: CanonicalRequest;
  /** Ordered configured search candidates; the first one that answers wins. */
  readonly candidates: readonly RouteCandidate[];
}

/**
 * Runs the caller's web-search query on the first configured search provider
 * that answers, in operator order. Returns `undefined` when no configured
 * provider could serve it, which leaves the request on its original route
 * rather than failing it — an unanswered search must not break a chat turn.
 */
export async function runWebSearchBridge(
  input: WebSearchBridgeInput,
): Promise<WebSearchBridgeResult | undefined> {
  const invocation = extractWebSearchInvocation(input.request);
  if (invocation === undefined) return undefined;
  if (input.candidates.length === 0) return undefined;
  const { state } = input;
  let lastError: unknown;
  for (const candidate of input.candidates) {
    try {
      const credential = candidate.provider_account_id
        ? await resolveCredentialForAccount(
            input.deps.db,
            candidate.provider_id,
            candidate.provider_account_id,
          )
        : {
            provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
            credential_kind: "none" as const,
          };
      const adapter = input.deps.resolveProviderAdapter
        ? await input.deps.resolveProviderAdapter(candidate.provider_id)
        : input.deps.providerAdapters?.get(candidate.provider_id);
      if (!adapter || typeof adapter.websearch !== "function") {
        throw new GatewayError(
          "capability_unsupported",
          400,
          "web search is unavailable for this provider",
        );
      }
      const target: ProviderDispatchTarget = {
        provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
        model_id: candidate.model_id,
        wire_family: candidate.wire_family,
        endpoint_path: candidate.endpoint,
        capabilities: candidate.capability_profile,
      };
      const results = await adapter.websearch(
        { query: invocation.query, max_results: invocation.maxResults },
        target,
        {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...(candidate.user_agent === undefined ? {} : { user_agent: candidate.user_agent }),
          ...(input.deps.networkBindingFactory
            ? {
                outbound_fetch: input.deps.networkBindingFactory.fetch(
                  undefined,
                  state.authorization?.tenantId,
                ),
              }
            : {}),
        },
      );
      if (results.results.length === 0) {
        throw new GatewayError("platform_unavailable", 502, "search returned no results");
      }
      log.info("[routing] web search served by configured fallback", {
        provider: candidate.provider_id,
        model: candidate.model_id,
        query: invocation.query.slice(0, 200),
        results: results.results.length,
        requestId: state.requestId,
      });
      return {
        providerId: candidate.provider_id,
        modelId: candidate.model_id,
        query: invocation.query,
        results,
        ...(invocation.callId === undefined ? {} : { callId: invocation.callId }),
      };
    } catch (error) {
      // Every configured provider is tried before giving up: a fallback that
      // fails must advance to the next one, exactly like a normal failover.
      lastError = error;
      log.warn("[routing] web search fallback provider failed", {
        provider: candidate.provider_id,
        model: candidate.model_id,
        error: error instanceof Error ? error.message : String(error),
        requestId: state.requestId,
      });
    }
  }
  if (lastError !== undefined) {
    log.warn("[routing] web search fallback exhausted", {
      attempted: input.candidates.length,
      requestId: state.requestId,
    });
  }
  return undefined;
}

/** Formats normalized hits as the text a model can quote from. */
export function formatSearchResults(result: WebSearchBridgeResult): string {
  const lines: string[] = [`Web search results for "${result.query}":`, ""];
  for (const [index, hit] of result.results.results.entries()) {
    const title = hit.title.length > 0 ? hit.title : hit.url;
    lines.push(`${index + 1}. ${title}`);
    lines.push(`   URL: ${hit.url}`);
    if (hit.snippet.length > 0) lines.push(`   ${hit.snippet}`);
    lines.push("");
  }
  lines.push("Answer the user's question using these results and cite the URLs you used.");
  return lines.join("\n");
}

/**
 * Accounting id for one served search round — **never** a `tool_use` id.
 *
 * It is derived from the provider, the query length, and the hit count, so two
 * rounds that happen to share those three values produce the *same* string. That
 * is fine for correlating telemetry and useless as a tool id, because the
 * Messages contract requires every `tool_use`/`tool_use_id` pair in one
 * conversation to be distinct. A per-round suffix makes it unique; the caller
 * prefers the client's own {@link WebSearchBridgeResult.callId} on the wire and
 * only reaches for this when there is no client call to address.
 */
function servedSearchCallId(result: WebSearchBridgeResult): string {
  return `srvtoolu_${result.providerId}_${result.query.length}_${result.results.results.length}_${crypto.randomUUID().slice(0, 8)}`;
}
/**
 * The id a served round must be addressed by on the wire.
 *
 * The client's own call id when it sent one — that is what closes its pending
 * tool round. Otherwise a fresh gateway id, never a shared one.
 */
function servedSearchWireId(result: WebSearchBridgeResult): string {
  return result.callId ?? servedSearchCallId(result);
}
/** Visible hit list: title and URL only, so a chat client shows the results, not the query. */
function visibleSearchHits(result: WebSearchBridgeResult): string {
  return result.results.results
    .map((hit) => `${hit.title.length > 0 ? hit.title : hit.url} — ${hit.url}`)
    .join("\n");
}

/**
 * The search round the client should see, in the shape its own surface counts
 * as a completed search. Claude Code counts `web_search_tool_result`; Chat and
 * Responses clients count a tool call whose arguments are the hits. A text
 * delta carries the same titles and URLs so a client that only renders answer
 * text still shows the results. Emitted ahead of the selected model's answer.
 */
export function servedSearchEvents(
  result: WebSearchBridgeResult,
  surface: SourceSurface,
): readonly CanonicalEvent[] {
  // The client's own call id when it sent one: this is the pair that closes its
  // pending tool round, and a mismatched id is what made it re-issue the search.
  const callId = servedSearchWireId(result);
  const hits = result.results.results.map((hit) => ({
    type: "web_search_result",
    title: hit.title.length > 0 ? hit.title : hit.url,
    url: hit.url,
  }));
  const visible = {
    type: "content_delta" as const,
    sequence_number: 0,
    content: { kind: "text" as const, text: `${visibleSearchHits(result)}\n\n` },
  };
  if (surface === "messages") {
    return [
      visible,
      {
        type: "content_delta",
        sequence_number: 1,
        content: {
          kind: "extension",
          name: "server_tool_use",
          payload: {
            type: "server_tool_use",
            id: callId,
            name: "web_search",
            input: { query: result.query },
          },
        },
      },
      {
        type: "content_delta",
        sequence_number: 2,
        content: {
          kind: "extension",
          name: "web_search_tool_result",
          payload: {
            type: "web_search_tool_result",
            tool_use_id: callId,
            content: hits,
          },
        },
      },
    ];
  }
  return [
    visible,
    {
      type: "tool_call_delta",
      sequence_number: 1,
      call_id: callId,
      name: "web_search",
      arguments_delta: JSON.stringify({
        query: result.query,
        provider: result.providerId,
        results: hits,
      }),
    },
  ];
}

/** One completed web-search function call the model asked the gateway to run. */
export interface WebSearchToolCall {
  readonly callId: string;
  readonly name: string;
  readonly query: string;
}

/**
 * Reads a finished `web_search` function call out of a non-stream event
 * batch. Only the function-tool spelling counts here: a hosted tool never
 * produces a call the gateway must execute, and matching a hosted name would
 * feed the fallback into a route that was supposed to search natively.
 */
export function pendingWebSearchToolCall(events: readonly CanonicalEvent[]): WebSearchToolCall | undefined {
  let callId: string | undefined;
  let name: string | undefined;
  let argumentsText = "";
  let sawEnd = false;
  for (const event of events) {
    if (event.type === "tool_call_delta") {
      if (event.name !== undefined) name = event.name;
      if (event.call_id !== undefined) callId = event.call_id;
      if (event.arguments_delta !== undefined) argumentsText += event.arguments_delta;
    } else if (event.type === "tool_result") {
      continue;
    } else if (event.type === "terminal") {
      if (event.state === "complete") sawEnd = true;
    }
  }
  if (!sawEnd || callId === undefined) return undefined;
  if (name === undefined || !isWebSearchToolName(name)) return undefined;
  let args: unknown;
  try {
    args = argumentsText.length > 0 ? JSON.parse(argumentsText) : {};
  } catch {
    args = {};
  }
  const query =
    args !== null && typeof args === "object" && typeof (args as Record<string, unknown>)["query"] === "string"
      ? ((args as Record<string, unknown>)["query"] as string).trim()
      : "";
  if (query.length === 0) return undefined;
  return { callId, name, query };
}

/**
 * Continues a turn whose model called the `web_search` function: the search
 * round is appended as a completed assistant call + tool result, and the
 * hosted search tool is removed so the model answers from the hits instead of
 * calling the tool again.
 */
export function withAnsweredWebSearchToolCall(
  request: CanonicalRequest,
  call: WebSearchToolCall,
  result: WebSearchBridgeResult,
): CanonicalRequest {
  const { tools: declaredTools, ...rest } = request;
  const remainingTools = declaredTools?.filter((tool) => !isWebSearchTool(tool));
  return {
    ...rest,
    ...(remainingTools !== undefined && remainingTools.length > 0 ? { tools: remainingTools } : {}),
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: call.callId, name: call.name, arguments: { query: call.query } }],
      },
      {
        role: "tool",
        content: [{ kind: "toolResult", call_id: call.callId, content: formatSearchResults(result) }],
      },
    ],
  };
}

/**
 * Rewrites the request as one whose web-search round already completed, so the
 * selected model answers from the injected results instead of declaring it
 * cannot browse. The hosted search tool itself is removed: the search already
 * ran, and leaving it declared invites the model to call it a second time
 * against a route that cannot serve it.
 */
export function withServedWebSearch(
  request: CanonicalRequest,
  result: WebSearchBridgeResult,
): CanonicalRequest {
  // The hosted search tool itself is removed: the search already ran, and
  // leaving it declared invites the model to call it a second time against a
  // route that cannot serve it.
  const { tools: declaredTools, ...rest } = request;
  const remainingTools = declaredTools?.filter((tool) => !isWebSearchTool(tool));
  const toolChoice =
    request.tool_choice !== undefined &&
    typeof request.tool_choice === "object" &&
    "name" in request.tool_choice &&
    isWebSearchToolName(request.tool_choice.name)
      ? "auto"
      : request.tool_choice;
  // Replayed as a completed assistant tool-call + tool-result round, which is
  // what the client's own transcript expects: Claude Code counts a search by
  // the `web_search_tool_result` block in the response, so injecting the hits
  // as plain user text reported "Did 0 searches" next to a correctly sourced
  // answer.
  //
  // That plain-text shape was tried first to stop DeepSeek-class models from
  // replying in raw DSML tool-call syntax — but the real cause was the tool
  // declaration still reaching the upstream, which is fixed at the source.
  // With the declaration gone, a finished round leaves no pattern to imitate.
  // The upstream injection is the other half of the same round, so it must carry
  // the same id the client is waiting on — a round whose two halves disagree
  // about the id is the loop.
  const callId = servedSearchWireId(result);
  const searchToolName = declaredTools?.find(isWebSearchTool)?.name ?? "web_search";
  return {
    ...rest,
    ...(remainingTools !== undefined && remainingTools.length > 0
      ? { tools: remainingTools }
      : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: [
          {
            kind: "toolCall",
            call_id: callId,
            name: searchToolName,
            arguments: { query: result.query },
          },
        ],
      },
      {
        role: "user",
        content: [
          { kind: "toolResult", call_id: callId, content: [{ kind: "text", text: formatSearchResults(result) }] },
        ],
      },
    ],
  };
}
