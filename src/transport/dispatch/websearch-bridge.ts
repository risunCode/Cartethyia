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
import { GatewayError } from "../gateway-error";
import { log } from "../../observability/logger";
import type { CanonicalRequest } from "../canonical-model";
import type { RouteCandidate } from "../routing/route-model";
import { extractWebSearchInvocation, isWebSearchTool } from "../translation/capabilities";
import type {
  ProviderAdapter,
  ProviderDispatchTarget,
  WebSearchOutcome,
} from "../../providers/provider-registry";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { ProxyRequestState } from "../request/state";

/** One search round executed by a configured fallback provider. */
export interface WebSearchBridgeResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly query: string;
  readonly results: WebSearchOutcome;
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
function formatSearchResults(result: WebSearchBridgeResult): string {
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
    isWebSearchTool({ name: request.tool_choice.name })
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
  const callId = `srvtoolu_${result.providerId}_${Date.now().toString(36)}`;
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
