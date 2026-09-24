import { GatewayError } from "../gateway-error";
import type { CanonicalRequest, ContentPart } from "../canonical-model";
import type { ApiKeyAdmissionService } from "../../security/admission";
import type { RouteCandidate as RouteCandidate, InMemoryRouteSnapshotService, RoutePlan } from "../routing/route-model";
import { resolveAliasTarget, type RoutingEngine } from "../routing/router";
import { deriveRequiredCapabilities, projectForRoute, routeCapabilitiesFor } from "../translation/capabilities";
import type { RequiredCapability } from "../translation/capabilities";
import { isModelAllowed, isProviderAllowed, type ResolvedApiKey } from "../../security/api-key-auth";
import { dropIncompleteToolRounds, repairRequestToolCalls } from "../translation/tool-repair";
import { sanitizeRequestToolIds } from "../translation/tool-id";
import { log } from "../../observability/logger";

const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1024;

// Degradation is often sustained — a client that always asks for tools against
// a tools-less route degrades every single request. An unthrottled warn would
// flood pino and push unrelated lines out of the bounded in-memory console
// ring, so each (model, capability-set) pair logs at most once per minute.
const DEGRADATION_WARN_INTERVAL_MS = 60_000;
const DEGRADATION_WARN_MAX_KEYS = 256;
const lastDegradationWarnAt = new Map<string, number>();

function shouldWarnDegradation(key: string, now: number): boolean {
  const previous = lastDegradationWarnAt.get(key);
  if (previous !== undefined && now - previous < DEGRADATION_WARN_INTERVAL_MS) return false;
  if (lastDegradationWarnAt.size >= DEGRADATION_WARN_MAX_KEYS) {
    for (const [existingKey, at] of lastDegradationWarnAt)
      if (now - at >= DEGRADATION_WARN_INTERVAL_MS) lastDegradationWarnAt.delete(existingKey);
    // Still full after pruning: a burst of distinct keys, not sustained
    // traffic. Reset rather than grow unbounded; the next warn re-establishes.
    if (lastDegradationWarnAt.size >= DEGRADATION_WARN_MAX_KEYS) lastDegradationWarnAt.clear();
  }
  lastDegradationWarnAt.set(key, now);
  return true;
}

function estimateInputTokens(request: CanonicalRequest): number {
  let chars = 0;
  for (const message of request.messages)
    for (const part of message.content) if (part.kind === "text") chars += part.text.length;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Ordered by blast radius: cheapest to degrade first, most semantic (tools/image)
 * last. Generation controls and extensions are stripped before prompt caching,
 * structured output, reasoning, and finally tools/images. This keeps the happy
 * path lossless while guaranteeing a text-only degraded fallback always exists
 * (unless the model itself is unknown).
 */
function degradeRequestForCapability(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  if (capability.startsWith("generation_control:"))
    return degradeGenerationControl(request, capability);
  if (capability.startsWith("extension:")) return degradeExtensionPart(request, capability);
  switch (capability) {
    case "prompt_caching":
      return degradePromptCaching(request);
    case "response_format.json_object":
    case "response_format.json_schema":
      return degradeResponseFormat(request);
    case "reasoning.encrypted_content":
      return degradeEncryptedReasoning(request);
    case "reasoning":
      return degradeReasoning(request);
    case "parallel_tool_calls":
      return degradeParallelToolCalls(request);
    case "tools":
      return degradeTools(request);
    case "image":
    case "document":
    case "audio":
      return degradeMediaPart(request, capability);
    default:
      return null;
  }
}

/** Drops one generation-control key. Passthrough hints, so nothing else moves. */
function degradeGenerationControl(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const key = capability.slice(
    "generation_control:".length,
  ) as keyof typeof request.generation_controls;
  if (!(key in request.generation_controls)) return null;
  const next = { ...request.generation_controls };
  delete next[key];
  return { ...request, generation_controls: next };
}

/**
 * Strips content parts carrying one named extension.
 *
 * Content-part extension: the `RequiredCapability` namespace. Generation-
 * control keys on `GenerationControls` share the `extension:` prefix but are
 * passthrough hints read by the wire codec; they are not degradable by name and
 * are deliberately left untouched here.
 */
function degradeExtensionPart(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const name = capability.slice("extension:".length);
  const stripExtensionParts = (parts: readonly ContentPart[]): readonly ContentPart[] =>
    parts.filter((p) => !(p.kind === "extension" && p.name === name));
  const nextMessages = request.messages.map((m) => ({
    ...m,
    content: stripExtensionParts(m.content),
  }));
  const nextSystem = request.system ? stripExtensionParts(request.system) : request.system;
  const nextInstructions = request.instructions
    ? stripExtensionParts(request.instructions)
    : request.instructions;
  const hasExtension = request.messages.some((m) =>
    m.content.some((p) => p.kind === "extension" && p.name === name),
  );
  if (!hasExtension && !nextSystem?.length && !nextInstructions?.length) return null;
  return {
    ...request,
    messages: nextMessages,
    ...(nextSystem !== undefined ? { system: nextSystem } : {}),
    ...(nextInstructions !== undefined ? { instructions: nextInstructions } : {}),
  };
}

function degradePromptCaching(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.cache_hint) return null;
  const { cache_hint: _ch, ...rest } = request;
  return rest;
}

function degradeResponseFormat(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.response_format) return null;
  const { response_format: _rf, ...rest } = request;
  return rest;
}

/** Drops encrypted reasoning from the request and from every carried part. */
function degradeEncryptedReasoning(request: CanonicalRequest): CanonicalRequest | null {
  if (
    !request.reasoning &&
    !request.messages.some((m) =>
      m.content.some(
        (p) =>
          p.kind === "reasoning" &&
          (p as Extract<ContentPart, { kind: "reasoning" }>).encrypted_content,
      ),
    )
  )
    return null;
  const nextMessages = request.messages.map((m) => ({
    ...m,
    content: m.content.map((p) => {
      if (
        p.kind === "reasoning" &&
        (p as Extract<ContentPart, { kind: "reasoning" }>).encrypted_content
      ) {
        const { encrypted_content: _ec, ...rest } = p as Extract<
          ContentPart,
          { kind: "reasoning" }
        >;
        return rest as ContentPart;
      }
      return p;
    }),
  }));
  return { ...request, messages: nextMessages };
}

function degradeReasoning(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.reasoning) return null;
  const { reasoning: _r, ...rest } = request;
  return rest;
}

function degradeParallelToolCalls(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.generation_controls.parallel_tool_calls) return null;
  return {
    ...request,
    generation_controls: { ...request.generation_controls, parallel_tool_calls: false },
  };
}

/**
 * Drops the tool catalog and rewrites tool traffic in every message to a text
 * placeholder, so the conversation still reads as a transcript of what
 * happened rather than losing the turns entirely.
 */
function degradeTools(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.tools?.length) return null;
  const nextMessages = request.messages.map((m) => {
    const hasToolPart = m.content.some((p) => p.kind === "toolCall" || p.kind === "toolResult");
    if (!hasToolPart) return m;
    const textFallback = m.content
      .filter((p) => p.kind === "toolCall")
      .map((p) => `[tool:${(p as Extract<ContentPart, { kind: "toolCall" }>).name}]`)
      .join("\n");
    const remaining: ContentPart[] = m.content.filter((p) => p.kind === "text") as ContentPart[];
    if (textFallback) remaining.push({ kind: "text", text: textFallback });
    const content: readonly ContentPart[] = remaining.length
      ? remaining
      : [{ kind: "text", text: "[tools removed]" }];
    return { ...m, content };
  });
  const { tools: _t, tool_choice: _tc, ...rest } = request;
  return { ...rest, messages: nextMessages };
}

/**
 * Replaces one attached-media kind with a text placeholder. `document` also
 * covers the `file` part kind, which is the same attachment on a different
 * wire family.
 */
function degradeMediaPart(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const placeholder =
    capability === "image" ? "[image]" : capability === "document" ? "[document]" : "[audio]";
  const matches = (part: ContentPart): boolean =>
    capability === "document"
      ? part.kind === "document" || part.kind === "file"
      : part.kind === capability;
  const strip = (parts: readonly ContentPart[]): readonly ContentPart[] =>
    parts.flatMap((p): ContentPart[] => (matches(p) ? [{ kind: "text", text: placeholder }] : [p]));
  const hasPart =
    request.messages.some((m) => m.content.some(matches)) ||
    (request.system?.some(matches) ?? false);
  if (!hasPart) return null;
  const nextMessages = request.messages.map((m) => ({ ...m, content: strip(m.content) }));
  if (request.system) {
    return { ...request, messages: nextMessages, system: strip(request.system) };
  }
  return { ...request, messages: nextMessages };
}

/**
 * Ordered request variants for capability-aware routing: the original
 * request first, then progressively degraded copies (same greedy
 * least-impact-first order as before). The planner plans each variant in
 * turn — the router filters candidates per variant, so the first variant
 * with a non-empty plan wins without ever consulting a blind pool.
 */
function degradedRequestVariants(
  original: CanonicalRequest,
): Array<{ request: CanonicalRequest; degraded: readonly RequiredCapability[]; required: readonly RequiredCapability[] }> {
  const required = deriveRequiredCapabilities(original);
  const variants: Array<{ request: CanonicalRequest; degraded: readonly RequiredCapability[]; required: readonly RequiredCapability[] }> = [
    { request: original, degraded: [], required },
  ];
  const priority: RequiredCapability[] = [
    ...required.filter((c) => c.startsWith("generation_control:") || c.startsWith("extension:")),
    "prompt_caching",
    "response_format.json_object",
    "response_format.json_schema",
    "reasoning.encrypted_content",
    "reasoning",
    "parallel_tool_calls",
    "tools",
    "image",
    "document",
    "audio",
  ] as RequiredCapability[];
  // Only consider capabilities actually required.
  const ordered = priority.filter((c) => required.includes(c));
  let current: CanonicalRequest = original;
  const degraded: RequiredCapability[] = [];
  for (const cap of ordered) {
    const next = degradeRequestForCapability(current, cap);
    if (!next) continue;
    degraded.push(cap);
    current = next;
    variants.push({ request: current, degraded: [...degraded], required: required.filter((c) => !degraded.includes(c)) });
  }
  return variants;
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
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly deadlineMs: number;
  readonly routingEngine: RoutingEngine;
  readonly admissionService: ApiKeyAdmissionService;
}

/** Routing and admission inputs for a native body that must not enter canonical translation. */
export interface PreparedNativeCompactRequest {
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
  }): Promise<PreparedProxyRequest> {
    const { canonicalRequest: request, authorization, signal } = input;
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const snapshot = await this.deps.snapshotService.getSnapshot();
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const allowCliMappings = authorization.scopes.includes("routing:cli_mapping");
    // CLI source→target mappings are an explicit API-key capability. Ordinary
    // tenant aliases remain available to every key; only selected keys may
    // consume the CLI mapping table.
    const resolvedTarget = resolveAliasTarget(
      snapshot,
      authorization.tenantId,
      request.model,
      allowCliMappings,
    );
    if (
      authorization.modelPrefix &&
      !request.model.startsWith(authorization.modelPrefix) &&
      !resolvedTarget.startsWith(authorization.modelPrefix) &&
      !isModelAllowed(authorization.snapshot, request.model) &&
      !isModelAllowed(authorization.snapshot, resolvedTarget)
    )
      throw new GatewayError(
        "model_not_found",
        404,
        "model does not match the key's required prefix",
        { model: request.model, required_prefix: authorization.modelPrefix },
      );
    if (
      !isModelAllowed(authorization.snapshot, request.model) &&
      !isModelAllowed(authorization.snapshot, resolvedTarget)
    ) {
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key", {
        model: request.model,
      });
    }
    // Capability-aware routing: derive requirements BEFORE planning so the
    // router filters candidates against snapshot profiles. When nothing
    // supports the full request, degrade (same greedy order) and re-plan
    // each variant against the same snapshot; the first non-empty plan wins.
    let plan: RoutePlan | undefined;
    let variantRequest = request;
    let degraded: readonly RequiredCapability[] = [];
    // Explicit caller opt-out wins over capability routing: dropping encrypted
    // reasoning is a lossy request the caller asked for, so it applies before
    // planning rather than as a fallback when no route supports the artifacts.
    if (request.generation_controls["extension:omit_encrypted_reasoning"] === true) {
      const stripped = degradeEncryptedReasoning(request);
      if (stripped) {
        variantRequest = stripped;
        degraded = ["reasoning.encrypted_content"];
      }
    }
    for (const variant of degradedRequestVariants(variantRequest)) {
      try {
        plan = await this.deps.routingEngine.plan(
          request.model,
          snapshot,
          authorization.tenantId,
          variant.required,
          allowCliMappings,
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
    const winningProvider = eligible[0]?.provider_id;
    const buddyFamily =
      winningProvider === "cb" || winningProvider === "cbcn" || winningProvider === "workbuddy";
    const repairedMessages = buddyFamily
      ? repairRequestToolCalls({
          ...variantRequest,
          messages: dropIncompleteToolRounds(variantRequest.messages),
        })
      : repairRequestToolCalls(variantRequest);
    let effectiveRequest = repairedMessages;
    // Anthropic-compatible tool ids are a structural requirement of the
    // Messages wire, and a request may be routed to any candidate in the plan.
    // Sanitizing after repair keeps synthesized results paired with their
    // calls while removing ids strict upstreams reject.
    effectiveRequest = sanitizeRequestToolIds(effectiveRequest);
    if (signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    // Project against the chosen candidate, not the intersection of every
    // candidate in the plan. The planner already filtered `eligible` to the
    // candidates that support this variant's requirements, so the chosen one
    // supports them; the intersection does not, because a later fallback
    // candidate can lack a control the chosen one has. Intersecting here made
    // a request fail with `capability_unsupported` for a capability its own
    // winning route supports — a `max_tokens` the chosen wire can express was
    // rejected because some other candidate in the fallback list cannot.
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
      estimatedInputTokens,
      estimatedOutputTokens,
      deadlineMs: input.deadlineMs,
      routingEngine: this.deps.routingEngine,
      admissionService: this.deps.admissionService,
    };
  }

  /**
   * Plans native Responses compaction without parsing, projecting, or mutating
   * its opaque wire body. Estimates intentionally reserve a conservative fixed
   * budget because native input items are not canonicalized for token counting.
   */
  async prepareNativeCompact(input: {
    readonly model: string;
    readonly authorization: ResolvedApiKey;
    readonly signal?: AbortSignal;
  }): Promise<PreparedNativeCompactRequest> {
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const snapshot = await this.deps.snapshotService.getSnapshot();
    if (
      input.authorization.modelPrefix &&
      !input.model.startsWith(input.authorization.modelPrefix) &&
      !isModelAllowed(input.authorization.snapshot, input.model)
    )
      throw new GatewayError(
        "model_not_found",
        404,
        "model does not match the key's required prefix",
        { model: input.model, required_prefix: input.authorization.modelPrefix },
      );
    // Responses compaction runs exclusively on Codex, so a key whose provider
    // policy excludes Codex can never be served. Reject before planning: the
    if (!isProviderAllowed(input.authorization.snapshot, "codex"))
      throw new GatewayError(
        "invalid_request",
        403,
        "Responses compact requires a key that allows the Codex provider",
        { provider: "codex" },
      );
    const plan = await this.deps.routingEngine.plan(
      input.model,
      snapshot,
      input.authorization.tenantId,
      undefined,
      input.authorization.scopes.includes("routing:cli_mapping"),
    );
    if (input.signal?.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    const candidates = plan.candidates.filter((candidate) => candidate.provider_id === "codex");
    if (candidates.length === 0)
      throw new GatewayError("capability_unsupported", 400, "no eligible Codex route supports Responses compact", {
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
}
