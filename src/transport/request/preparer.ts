import { GatewayError } from "../../protocol/gateway-error";
import type { CanonicalRequest, ServiceKind } from "../../protocol/canonical-model";
import { providerSupportsWebSearch } from "../../providers/metadata";
import type { ApiKeyAdmissionService } from "../../security/admission/service";
import type { RouteCandidate as RouteCandidate, InMemoryRouteSnapshotService, RoutePlan } from "../routing/route-model";
import { resolveAliasTarget, type RoutingEngine } from "../routing/router";
import { projectForRoute, routeCapabilitiesFor } from "../translation/capabilities";
import { requestUsesWebSearch } from "../translation/search";
import type { RequiredCapability } from "../translation/capabilities";
import { isModelAllowed, type ResolvedApiKey } from "../../security/api-key-auth";
import { allowsCliToolMappings } from "../../security/cli-client-fingerprint";
import { dropIncompleteToolRounds, repairRequestToolCalls } from "../translation/tool-repair";
import { sanitizeRequestToolIds } from "../translation/tool-id";
import { dropCorruptAttachments } from "../translation/attachment-integrity";
import { parseThinkingSuffix, withThinkingSuffixIntent } from "../translation/thinking";
import { nativeServicePathFor } from "../contracts";
import { log } from "../../observability/logger";
import { BUDDY_PROVIDER_IDS } from "../../providers/metadata";
import {
  degradedRequestVariants,
  degradeEncryptedReasoning,
  shouldWarnDegradation,
} from "./degradation";
import { DEFAULT_ESTIMATED_OUTPUT_TOKENS, estimateInputTokens } from "./token-estimate";

/** True when the request carries tools or message parts that need repair/sanitize. */
function requestNeedsToolRepair(request: CanonicalRequest): boolean {
  if (request.tools !== undefined && request.tools.length > 0) return true;
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === "toolCall" || part.kind === "toolResult") return true;
    }
  }
  return false;
}

export interface PreparedProxyRequest {
  readonly canonicalRequest: CanonicalRequest;
  readonly authorization: ResolvedApiKey;
  readonly candidate: RouteCandidate;
  /** Ordered fallback candidates already filtered for capability support (includes primary). */
  readonly eligibleRouteCandidates: readonly RouteCandidate[];
  /** Capabilities stripped from the original request to achieve eligibility. */
  readonly degradedCapabilities?: readonly RequiredCapability[];
  /** Snapshot-consistent plan used to reserve each individual attempt. */
  readonly plan: RoutePlan;
  /** True when the caller asked for a web-search tool, enabling routed fallback. */
  readonly webSearch?: boolean;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly deadlineMs: number;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

/** Routing and admission inputs for a native body that must not enter canonical translation. */
export interface PreparedNativeRequest {
  readonly authorization: ResolvedApiKey;
  readonly candidates: readonly RouteCandidate[];
  readonly plan: RoutePlan;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

export interface ProxyRequestPreparerDeps {
  readonly snapshotService: InMemoryRouteSnapshotService;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

export class ProxyRequestPreparer {
  constructor(private readonly deps: ProxyRequestPreparerDeps) {}

  async prepare(input: {
    readonly canonicalRequest: CanonicalRequest;
    readonly authorization: ResolvedApiKey;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    /** Inbound `User-Agent`; gates remote CLI remaps so short slots stay tool-local. */
    readonly clientUserAgent?: string;
  }): Promise<PreparedProxyRequest> {
    const { canonicalRequest: initialRequest, authorization, signal } = input;
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    if (!initialRequest.model || initialRequest.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, "Request requires a non-empty model identifier", {
        field: "model",
      });
    }
    // A thinking suffix (`model(high)`) is stripped here, before anything reads
    // the model name. Alias resolution, the allowlist, the prefix check, and
    // routing all match against registered ids, so a name carrying `(high)`
    // would fail every one of them — and alias resolution swallows its own
    // failure, so the symptom would be a silent miss rather than an error.
    //
    // Doing it on the canonical request (rather than in a provider adapter) is
    // what makes the syntax global: at this point the target provider is not
    // chosen yet, and the level is a statement about the request, not about any
    // one upstream. Each model's own ladder is applied later, after routing.
    const { model: bareModel, intent: thinkingIntent } = parseThinkingSuffix(initialRequest.model);
    const request =
      thinkingIntent === null
        ? initialRequest
        : withThinkingSuffixIntent({ ...initialRequest, model: bareModel }, thinkingIntent);
    const snapshot = await this.deps.snapshotService.getSnapshot();
    // Scope opts the key into the mapping table; the User-Agent decides whether
    // *this* request may consume it. Without the UA gate, a Claude→DeepSeek
    // remap would also rewrite a non-Claude caller that named `opus`.
    const allowCliMappings = allowsCliToolMappings(authorization.scopes, {
      ...(input.clientUserAgent === undefined ? {} : { userAgent: input.clientUserAgent }),
    });
    // CLI source→target mappings are an explicit API-key capability. Ordinary
    // tenant aliases remain available to every key; only selected keys may
    // consume the CLI mapping table.
    const resolvedTarget = resolveAliasTarget(
      snapshot,
      authorization.tenantId,
      request.model,
      allowCliMappings,
      authorization.cliMappingOwnerId ?? authorization.id,
    );
    // Pass `request.model` as the requested name so an allowlisted alias / a
    // CLI remapping can authorize the resolved target (see modelRejectionReason).
    const allowedForKey = isModelAllowed(
      authorization.snapshot,
      resolvedTarget,
      undefined,
      request.model,
    );
    if (
      authorization.modelPrefix &&
      !request.model.startsWith(authorization.modelPrefix) &&
      !resolvedTarget.startsWith(authorization.modelPrefix) &&
      !allowedForKey
    )
      throw new GatewayError(
        "model_not_found",
        404,
        `This key may only use models starting with '${authorization.modelPrefix}'. Ask for one inside that prefix, or have an operator widen the key.`,
        { model: request.model, required_prefix: authorization.modelPrefix },
      );
    if (!allowedForKey) {
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key", {
        model: request.model,
      });
    }
    // An inline image that cannot survive the upstream is dropped here rather
    // than dispatched: a provider rejects the whole request for one corrupt
    // attachment, and the buddy family reports it with no field named, so the
    // caller gets a 400 it cannot act on. Running this before capability
    // derivation also means a request whose only image was defective no longer
    // requires the `image` capability — it plans like the text request it has
    // become, instead of being routed to a vision route for nothing.
    const requestWithAttachments = dropCorruptAttachments(request).request;
    // Capability-aware routing: derive requirements BEFORE planning so the
    // router filters candidates against snapshot profiles. When nothing
    // supports the full request, degrade (same greedy order) and re-plan
    // each variant against the same snapshot; the first non-empty plan wins.
    let plan: RoutePlan | undefined;
    let variantRequest = requestWithAttachments;
    let degraded: readonly RequiredCapability[] = [];
    // Explicit caller opt-out wins over capability routing: dropping encrypted
    // reasoning is a lossy request the caller asked for, so it applies before
    // planning rather than as a fallback when no route supports the artifacts.
    if (requestWithAttachments.generation_controls["extension:omit_encrypted_reasoning"] === true) {
      const stripped = degradeEncryptedReasoning(requestWithAttachments);
      if (stripped) {
        variantRequest = stripped;
        degraded = ["reasoning.encrypted_content"];
      }
    }
    const searchRouting = requestUsesWebSearch(variantRequest);
    for (const variant of degradedRequestVariants(variantRequest)) {
      try {
        plan = await this.deps.routingEngine.plan(
          request.model,
          snapshot,
          authorization.tenantId,
          variant.required,
          allowCliMappings,
          authorization.cliMappingOwnerId ?? authorization.id,
          searchRouting,
        );
      } catch (error) {
        if (error instanceof GatewayError && error.code === "capability_unsupported") continue;
        throw error;
      }
      variantRequest = variant.request;
      degraded = [...degraded, ...variant.degraded.filter((cap) => !degraded.includes(cap))];
      break;
    }
    if (!plan)
      throw new GatewayError(
        "capability_unsupported",
        400,
        "no eligible route supports this request's capabilities",
        { model: request.model },
      );
    const policyCandidates = plan.candidates.filter((candidate) =>
      isModelAllowed(
        authorization.snapshot,
        candidate.model_id,
        candidate.provider_id,
        request.model,
      ),
    );
    if (policyCandidates.length === 0)
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key", {
        model: request.model,
      });
    if (policyCandidates.length !== plan.candidates.length)
      plan = { ...plan, candidates: policyCandidates };
    // A canonical request is chat-shaped by definition, so only `llm` rows may
    // serve it. A non-`llm` row (System One) is dispatched by its native route
    // and its `wire_family` is an inert placeholder; without this filter the
    // chat pipeline would route to it and send a chat body to a decision
    // endpoint (upstream 400). The reverse direction is guarded by the native
    // route's own kind filter.
    const llmCandidates = plan.candidates.filter(
      (candidate) =>
        (candidate.service_kind ?? "llm") === "llm" ||
        // A configured search fallback rides the same chat request to run the
        // search tool on the caller's behalf; only the dispatcher uses it.
        (candidate.service_kind === "websearch" &&
          candidate.search_route === "fallback"),
    );
    if (llmCandidates.length === 0) {
      // Name the actual kind so the message stays correct as more native
      // services are added, and point at the route that can serve it.
      const kind = plan.candidates[0]?.service_kind ?? "native";
      const route = nativeServicePathFor(kind);
      throw new GatewayError(
        "capability_unsupported",
        400,
        `this model is not served on a chat wire — it is a '${kind}' service model${route === undefined ? "" : `; call it at POST ${route}`}`,
        { model: request.model, service_kind: kind, ...(route === undefined ? {} : { route }) },
      );
    }
    if (llmCandidates.length !== plan.candidates.length) {
      plan = { ...plan, candidates: llmCandidates };
    }
    if (degraded.length > 0) {
      // Degradation is a last resort, never silent: the client asked for
      // semantics (tools/images/reasoning) the winning route cannot serve,
      // so they were stripped to keep the request dispatchable at all.
      // Surfacing it here puts it on the live console log next to the
      // request it affected, throttled so sustained degradation cannot
      // drown out everything else in the ring.
      const degradedList = [...degraded];
      const warnKey = `${request.model}|${degradedList.join(",")}`;
      if (shouldWarnDegradation(warnKey, Date.now())) {
        log.warn("[routing] degraded request capabilities", {
          model: request.model,
          degraded: degradedList,
          tenantId: authorization.tenantId,
        });
      }
    }
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const eligible = plan.candidates;
    // The buddy gateway rejects partial tool rounds outright (`11148`) where
    // the generic synthesis policy would insert a placeholder result, so a
    // request bound for CodeBuddy/WorkBuddy drops the incomplete round instead.
    // The winner is the first candidate — the whole plan shares its provider —
    // hence the repair is chosen from the winning provider.
    //
    // Order is load-bearing: `dropIncompleteToolRounds` MUST run before
    // `repairRequestToolCalls`. The generic repair synthesizes a
    // `<missing tool output>` result for every unanswered call, which makes
    // every partial batch look complete — so running it first silently
    // disabled the buddy policy and dispatched exactly the shape the upstream
    // rejects (`assistant[c1 c2] + tool[c1]` became a "complete" round with a
    // fabricated c2 result). Dropping first also removes the dangling results
    // that would otherwise be re-emitted as unpaired `role:"tool"` turns.
    // Fast path: chat/completions without tools skip the three full-message
    // clones (repair → sanitize → project). Only run the heavy path when the
    // request actually carries tools or tool-call/result parts.
    let effectiveRequest = variantRequest;
    if (requestNeedsToolRepair(variantRequest)) {
      const winningProvider = eligible[0]?.provider_id;
      const buddyFamily =
        winningProvider !== undefined && BUDDY_PROVIDER_IDS.has(winningProvider);
      // Order is load-bearing: dropIncompleteToolRounds MUST run before
      // repairRequestToolCalls (see comment above).
      effectiveRequest = buddyFamily
        ? repairRequestToolCalls({
            ...variantRequest,
            messages: dropIncompleteToolRounds(variantRequest.messages),
          })
        : repairRequestToolCalls(variantRequest);
      effectiveRequest = sanitizeRequestToolIds(effectiveRequest);
    }
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    // Project against the chosen candidate, not the intersection of every
    // candidate in the plan. Still required for generation-control stripping
    // even on the no-tools path — keep it, but it is cheap vs message clones.
    effectiveRequest = projectForRoute(effectiveRequest, routeCapabilitiesFor(eligible[0]!));
    const estimatedInputTokens = estimateInputTokens(effectiveRequest);
    const estimatedOutputTokens =
      effectiveRequest.generation_controls.max_tokens ??
      effectiveRequest.generation_controls.max_output_tokens ??
      effectiveRequest.generation_controls.max_completion_tokens ??
      DEFAULT_ESTIMATED_OUTPUT_TOKENS;
    const chosen = eligible[0]!;
    // plan() guarantees a non-empty candidate list (it throws otherwise).
    return {
      canonicalRequest: effectiveRequest,
      authorization,
      candidate: chosen,
      eligibleRouteCandidates: eligible,
      degradedCapabilities: degraded,
      plan,
      ...(searchRouting ? { webSearch: true } : {}),
      estimatedInputTokens,
      estimatedOutputTokens,
      deadlineMs: input.deadlineMs,
      routingEngine: this.deps.routingEngine,
      admissionService: this.deps.admissionService,
    };
  }

  /**
   * Plans a native (non-canonical) body without parsing, projecting, or
   * mutating it. Shared by every native route: it applies the key's model-prefix
   * gate, plans the model, and keeps only the candidates the route's own
   * `eligible` predicate admits. Estimates intentionally reserve a conservative
   * fixed budget because native input is not canonicalized for token counting.
   */
  async #planNative(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    /** Inbound `User-Agent`; gates remote CLI remaps to the matching tool. */
    readonly clientUserAgent?: string;
    readonly eligible: (candidate: RouteCandidate) => boolean;
    readonly emptyMessage: string;
  }): Promise<PreparedNativeRequest> {
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const snapshot = await this.deps.snapshotService.getSnapshot();
    const allowCliMappings = allowsCliToolMappings(input.authorization.scopes, {
      ...(input.clientUserAgent === undefined ? {} : { userAgent: input.clientUserAgent }),
    });
    const resolvedTarget = resolveAliasTarget(
      snapshot,
      input.authorization.tenantId,
      input.model,
      allowCliMappings,
      input.authorization.cliMappingOwnerId ?? input.authorization.id,
    );
    const allowedForKey = isModelAllowed(
      input.authorization.snapshot,
      resolvedTarget,
      undefined,
      input.model,
    );
    if (
      input.authorization.modelPrefix &&
      !input.model.startsWith(input.authorization.modelPrefix) &&
      !resolvedTarget.startsWith(input.authorization.modelPrefix) &&
      !allowedForKey
    )
      throw new GatewayError(
        "model_not_found",
        404,
        `This key may only use models starting with '${input.authorization.modelPrefix}'. Ask for one inside that prefix, or have an operator widen the key.`,
        { model: input.model, required_prefix: input.authorization.modelPrefix },
      );
    if (!allowedForKey)
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key", {
        model: input.model,
      });
    const plan = await this.deps.routingEngine.plan(
      input.model,
      snapshot,
      input.authorization.tenantId,
      undefined,
      allowCliMappings,
      input.authorization.cliMappingOwnerId ?? input.authorization.id,
    );
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const policyCandidates = plan.candidates.filter((candidate) =>
      isModelAllowed(
        input.authorization.snapshot,
        candidate.model_id,
        candidate.provider_id,
        input.model,
      ),
    );
    if (policyCandidates.length === 0)
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key", {
        model: input.model,
      });
    const candidates = policyCandidates.filter(input.eligible);
    if (candidates.length === 0)
      throw new GatewayError("capability_unsupported", 400, input.emptyMessage, {
        model: input.model,
      });
    return {
      authorization: input.authorization,
      candidates,
      plan,
      estimatedInputTokens: DEFAULT_ESTIMATED_OUTPUT_TOKENS,
      estimatedOutputTokens: DEFAULT_ESTIMATED_OUTPUT_TOKENS,
      routingEngine: this.deps.routingEngine,
      admissionService: this.deps.admissionService,
    };
  }

  /**
   * Plans native Responses compaction. Compact is a Codex-only operation, so
   * the candidate set is filtered to the Codex provider.
   */
  async prepareNativeCompact(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => candidate.provider_id === "codex",
      emptyMessage: "no eligible Codex route supports Responses compact",
    });
  }

  /**
   * Plans a native service request (System One). Candidates are the routes whose
   * catalog classifies the model as this service kind — the model's own row is
   * what makes a provider eligible, so a chat model named on the systemone route
   * (or vice versa) finds no candidate and fails closed here rather than
   * dispatching a decision body to a chat endpoint.
   */
  async prepareNativeService(input: {
    readonly model: string;
    readonly serviceKind: Exclude<ServiceKind, "llm">;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => {
        const kind = candidate.service_kind ?? "llm";
        if (kind === input.serviceKind) return true;
        // Search providers serve their ordinary models. The adapter chooses
        // the upstream model; no fabricated `*-search` catalog row is needed.
        return input.serviceKind === "websearch" && kind === "llm" && providerSupportsWebSearch(candidate.provider_id);
      },
      emptyMessage: `no eligible route serves the '${input.serviceKind}' service for this model`,
    });
  }

  /**
   * Plans a token-count request: the same `llm` route that would serve the
   * message, restricted to providers that speak Anthropic Messages.
   *
   * Deliberately not a `serviceKind`. `/v1/messages/count_tokens` is a sibling
   * endpoint of `/v1/messages` on the *same* model, so the candidate is an
   * ordinary `llm` row — inventing a `tokenCounting` catalog kind would make it
   * selectable on a provider model that can then never serve chat, and would put
   * it in the console's picker for no reason. `wire_family` is the honest gate:
   * a count body is Anthropic-shaped, so a chat-completions or responses
   * provider has no equivalent endpoint and must not be dispatched to.
   */
  async prepareNativeTokenCount(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
    readonly clientUserAgent?: string;
  }): Promise<PreparedNativeRequest> {
    return this.#planNative({
      model: input.model,
      authorization: input.authorization,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.clientUserAgent === undefined ? {} : { clientUserAgent: input.clientUserAgent }),
      eligible: (candidate) => candidate.wire_family === "messages",
      emptyMessage:
        "no eligible route can count tokens for this model — only an Anthropic Messages provider has /v1/messages/count_tokens",
    });
  }
}
