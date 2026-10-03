/**
 * Phase helpers extracted from `ProviderProbingService.probeModel`.
 *
 * `probeModel` stays the orchestrator: it loads the provider snapshot once and
 * then runs these phases in order — resolve the wire target, select a
 * health-filtered account, resolve an adapter, load the tenant's probe
 * preferences, build the canonical request, dispatch (still inline: it owns the
 * `events`/`ttfbMs`/`capturedRequest` mutations), record account health, and
 * compute the verdict. The pure stream helpers (`extractSample`,
 * `hasMeaningfulOutput`) and the provider-row → wire-context mapping live here
 * too; the mapping is shared with `syncModels`.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { consoleSettings, models, providerAccounts } from "../../persistence/schema";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ServiceKind,
  SourceSurface,
  UsageRecord,
  WireFamily,
} from "../../transport/canonical-model";
import {
  resolveSupportedReasoningEfforts,
  type ReasoningEffortLevel,
} from "../../transport/translation/thinking";
import type { CompatibilityProfile } from "../provider-metadata";
import type { ProbeModelRequest } from "./discovery-types";
import {
  constrainWireFamily,
  discoveryPathsFor,
  resolveDiscoveredWire,
  staticEndpointForWire,
  supportedWireFamiliesForProvider,
  type ProviderWireContext,
} from "./probe-wire";
import { OpenAICompatibleAdapter } from "../compatible-adapter";
import { resolveByokWireProfile, stripEndpointBasePath } from "../operations/byok-wire-profile";
import { recordAccountFailure, recordAccountSuccess } from "../operations/account-health-service";
import { buildCapabilityProfile } from "../../transport/routing/route-catalog";
import { classifyUpstreamFailure } from "../../transport/failure-policy";
import { GatewayError } from "../../transport/gateway-error";
import type {
  ModelDefinition,
  ProviderAdapter,
  ProviderId,
  ProviderRegistry,
} from "../provider-registry";

/**
 * The provider row columns `loadProviderWireRow` selects, shared by the phases
 * so one row shape serves wire resolution, the account gate, and the
 * custom-adapter fallback.
 */
export interface ProbeProviderRow {
  readonly baseUrl: string | null;
  readonly wireFamilyDefault: WireFamily | null;
  readonly compatibilityProfile: unknown;
  readonly requiresAccount: boolean;
}

/**
 * Maps a provider row onto the wire-resolution context. Nullable columns
 * normalize to `undefined` so the resolver's `??` layering applies.
 */
export function wireContextFrom(
  row: { wireFamilyDefault: WireFamily | null; compatibilityProfile: unknown } | undefined,
): ProviderWireContext {
  return {
    wireFamilyDefault: (row?.wireFamilyDefault as WireFamily | undefined) ?? undefined,
    endpointPathsByWireFamily: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.endpoint_paths_by_wire_family as Partial<Record<WireFamily, string>> | undefined,
    modelWireFamilies: (row?.compatibilityProfile as CompatibilityProfile | null)
      ?.model_wire_families as
      ReadonlyArray<{ pattern: string; wire_family: WireFamily }> | undefined,
  };
}

/** Best-effort visible text extracted from a probe's streamed content deltas, capped for display. */
export function extractSample(events: readonly CanonicalEvent[]): string | undefined {
  let text = "";
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text")
      text += event.content.text;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
}

export function hasMeaningfulOutput(events: readonly CanonicalEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "tool_call_delta") return true;
    if (event.type !== "content_delta") return false;
    const content = event.content;
    if (content.kind === "text" || content.kind === "refusal")
      return content.text.trim().length > 0;
    if (content.kind === "reasoning")
      return typeof content.summary === "string" && content.summary.trim().length > 0;
    return false;
  });
}

/** Resolved wire target for one probe: family, endpoint path, canonical surface. */
export interface ProbeTarget {
  readonly wireFamily: WireFamily;
  /**
   * Protocol shape of the probed row. A non-`llm` row (System One) is probed
   * through its native endpoint with a decision body, not the canonical chat
   * pipeline — the same split routing uses.
   */
  readonly serviceKind: ServiceKind;
  readonly endpointPath: string;
  readonly sourceSurface: SourceSurface;
  /**
   * The capability profile the probe dispatches under.
   *
   * A probe runs the real adapter, and a real adapter gates on capabilities
   * (`ClaudeAdapter` rejects every request whose required capabilities the
   * target does not declare). An empty profile therefore rejected the probe on
   * capabilities the route actually has — `prompt_caching`, `tools`,
   * `reasoning` — reporting a provider as broken over a gate the provider
   * passes for live traffic. Resolved from the same model row the router reads
   * so the probe tests the route, not an empty stand-in.
   */
  readonly capabilityProfile: Readonly<Record<string, boolean>>;
}

/**
 * Phase 1 — resolve which wire family and endpoint path the probe dispatches
 * to. The provider's own contract decides which wires are reachable at all (the
 * adapter rejects anything else with `capability_unsupported`), so a stored
 * row, a bundled catalog row, or a discovery guess naming an unserved family
 * can only produce a 400; the resolved family is constrained to the contract
 * and a corrected family recomputes its endpoint.
 */
export async function resolveProbeTarget(args: {
  readonly db: CartethyiaDatabase;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly providerId: string;
  readonly modelId: string;
  readonly request: ProbeModelRequest;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProbeTarget> {
  const { db, bundledModelCatalog, defaultEndpoints, providerId, modelId, request, providerWireRow } =
    args;
  const declaredFamilies = supportedWireFamiliesForProvider(
    providerId,
    providerWireRow?.wireFamilyDefault,
    providerWireRow?.compatibilityProfile,
  );
  // Operator profile > the provider's own bundled catalog (cline serves chat
  // from `/chat/completions`; the generic `/v1/…` default would join into an
  // unreachable path and surface as upstream 404) > probe map > generic
  // default. A custom provider's operator-entered base may already carry
  // `/v1`, so the resolved path is stripped to avoid `/v1/v1/messages`.
  const endpointForFamily = (family: WireFamily): string => {
    const profile = providerWireRow?.compatibilityProfile as CompatibilityProfile | null;
    const ep =
      profile?.endpoint_paths_by_wire_family?.[family] ??
      staticEndpointForWire(bundledModelCatalog, providerId, family) ??
      discoveryPathsFor(providerId)?.[family];
    return stripEndpointBasePath(
      ep ?? defaultEndpoints[family] ?? "/v1/chat/completions",
      providerWireRow?.baseUrl ?? undefined,
    );
  };

  let wireFamily: WireFamily;
  let endpointPath: string;
  // A native-service row (System One) probes through its native endpoint, not a
  // chat wire. Read from the same row the wire came from; an explicit
  // `request.wireFamily` never carries it (the operator is naming a chat wire).
  let serviceKind: ServiceKind = "llm";
  // Capability columns for the row the probe lands on. Resolved alongside the
  // wire so the profile describes the same row the probe dispatches to.
  let capabilitySource: {
    modalities: unknown;
    reasoning: boolean;
    toolCall: boolean;
    webSearch: boolean;
  } = { modalities: null, reasoning: false, toolCall: false, webSearch: false };
  if (request.wireFamily) {
    wireFamily = request.wireFamily as WireFamily;
    endpointPath = endpointForFamily(wireFamily);
  } else {
    const staticDef = bundledModelCatalog
      .get(providerId)
      ?.find(
        (def) => def.modelId === modelId && (!request.route || def.endpointPath === request.route),
      );
    if (staticDef) {
      wireFamily = staticDef.wireFamily;
      endpointPath = staticDef.endpointPath;
      serviceKind = staticDef.serviceKind ?? "llm";
      capabilitySource = {
        modalities: staticDef.modalities,
        reasoning: staticDef.reasoning,
        toolCall: staticDef.toolCall,
        webSearch: staticDef.webSearch,
      };
    } else {
      const existing = await db
        .select({
          wireFamily: models.wireFamily,
          serviceKind: models.serviceKind,
          endpointPath: models.endpointPath,
          modalities: models.modalities,
          reasoning: models.reasoning,
          toolCall: models.toolCall,
          webSearch: models.webSearch,
        })
        .from(models)
        .where(
          request.route
            ? and(
                eq(models.providerId, providerId),
                eq(models.modelId, modelId),
                eq(models.endpointPath, request.route),
              )
            : and(eq(models.providerId, providerId), eq(models.modelId, modelId)),
        )
        .limit(1);
      if (existing[0]) {
        wireFamily = existing[0].wireFamily as WireFamily;
        endpointPath = existing[0].endpointPath;
        serviceKind = existing[0].serviceKind as ServiceKind;
        capabilitySource = {
          modalities: existing[0].modalities,
          reasoning: existing[0].reasoning,
          toolCall: existing[0].toolCall,
          webSearch: existing[0].webSearch,
        };
        // A stored row carries no effort scale of its own (the `models` table has
        // no such column), so the ladder is derived from the id — exactly what
        // the dispatch path does for live traffic on the same row.
      } else {
        const ctx = wireContextFrom(providerWireRow);
        const resolved = resolveDiscoveredWire(
          modelId,
          ctx,
          discoveryPathsFor(providerId),
          defaultEndpoints,
        );
        wireFamily = resolved.wireFamily;
        endpointPath = resolved.endpointPath;
      }
    }
  }
  // A stored row, a bundled catalog row, or a discovery guess is a cache of the
  // derivation, not an authority: it can name a wire the provider's own
  // declaration does not list, and dispatch would then answer
  // `capability_unsupported` for a probe the operator never asked for. The
  // contract wins for those derived sources and the endpoint is recomputed for
  // the family it selected, so the probe reports the provider's real shape.
  //
  // An explicit `request.wireFamily` is deliberately exempt: that is the
  // operator naming the wire themselves, not a derivation to be corrected. The
  // wire selector exists to reach an upstream protocol this gateway carries no
  // bundled knowledge of, so silently swapping the choice would probe a
  // different wire than the one requested — the failure this exemption fixes.
  if (!request.wireFamily) {
    const contracted = constrainWireFamily(wireFamily, declaredFamilies);
    if (contracted.corrected) {
      wireFamily = contracted.wireFamily;
      endpointPath = endpointForFamily(wireFamily);
    }
  }
  const sourceSurface: SourceSurface = wireFamily;
  // Built from the row the probe resolves to, so the adapter's capability gate
  // sees the same profile live traffic would. `providerId` is part of the
  // profile because a bespoke-wire provider has no canonical codec and must not
  // inherit a codec's modality grants.
  const capabilityProfile = buildCapabilityProfile({
    modalities: capabilitySource.modalities,
    reasoning: capabilitySource.reasoning,
    toolCall: capabilitySource.toolCall,
    webSearch: capabilitySource.webSearch,
    providerId,
  });
  return {
    wireFamily,
    serviceKind,
    endpointPath,
    sourceSurface,
    capabilityProfile,
  };
}

/**
 * Refuse a probe whose requested effort the model's own ladder does not contain.
 *
 * Dispatch clamps an out-of-ladder effort down to the model's ceiling, which is
 * the right call for live traffic (a caller asking for `max` on a model that
 * stops at `xhigh` should still get an answer) but the wrong one for a probe:
 * the operator picked a level specifically to observe how the route behaves at
 * it, and a silently downgraded probe reports success for a request that was
 * never made.
 *
 * The ladder is resolved exactly as the dispatch codecs resolve it —
 * `resolveSupportedReasoningEfforts(modelId, wireFamily)` with no declared-scale
 * override — because that is what a live request through this same route would
 * be clamped against. Reading the catalog's declared scale here instead would
 * make the gate stricter than the wire it is gating: it would refuse a level
 * that dispatch would in fact have carried through.
 *
 * Returns `undefined` when the request is fine (including every `auto`/omitted
 * probe, which carries no intent to contradict), or the operator-facing reason
 * when it is not.
 */
export function reasoningEffortRejection(args: {
  readonly requested: ProbeModelRequest["reasoningEffort"];
  readonly modelId: string;
  readonly wireFamily: WireFamily;
}): string | undefined {
  const { requested, modelId, wireFamily } = args;
  if (requested === undefined || requested === "auto") return undefined;
  const supported = resolveSupportedReasoningEfforts(modelId, wireFamily);
  if (supported.includes(requested as ReasoningEffortLevel)) return undefined;
  return (
    `Model ${modelId} does not support reasoning effort '${requested}' on the ` +
    `${wireFamily} wire. Supported: ${supported.join(", ")}.`
  );
}

/** The account a probe selected, or the operator-facing reason it could not. */
export type ProbeAccountSelection =
  | { readonly ok: true; readonly accountId: string | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Phase 2 — pick the account the probe runs as. Snapshot-equivalent health
 * filtering: disabled accounts and live cooldowns never route, so probes must
 * not select them either. Tenant-owned accounts win over shared global ones.
 */
export async function selectProbeAccount(args: {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly providerId: string;
  readonly requestedAccountId: string | undefined;
  readonly requiresAccount: boolean;
}): Promise<ProbeAccountSelection> {
  const { db, tenantId, providerId, requestedAccountId, requiresAccount } = args;
  const accountRows = requiresAccount
    ? await db
        .select({
          id: providerAccounts.id,
          tenantId: providerAccounts.tenantId,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          cooldownUntil: providerAccounts.cooldownUntil,
        })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.providerId, providerId),
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
            ...(requestedAccountId ? [eq(providerAccounts.id, requestedAccountId)] : []),
          ),
        )
    : [];
  const now = Date.now();
  const usableAccounts = accountRows
    .filter(
      (row) =>
        row.status !== "disabled" &&
        (row.cooldownUntil === null || row.cooldownUntil.getTime() <= now),
    )
    .sort((left, right) => Number(right.tenantId !== null) - Number(left.tenantId !== null));
  const accountId = requestedAccountId ?? usableAccounts[0]?.id;
  if (!accountId && requiresAccount) {
    return {
      ok: false,
      error:
        accountRows.length > 0
          ? "All configured accounts for this provider are disabled or cooling down."
          : "No account configured for this provider yet — add one before probing a model.",
    };
  }
  return { ok: true, accountId };
}

/**
 * Phase 3 — resolve the adapter that dispatches the probe. Custom/BYOK
 * providers (e.g. infercrot) have no bundled adapter but carry a baseUrl; fall
 * back to the generic OpenAI-compatible adapter so probe/dispatch still works.
 * The low-level compatible adapter is used directly to avoid importing concrete
 * integrations from discovery (which would violate the provider-architecture
 * layering test). `loadOne` returning `undefined` means "no bundled adapter";
 * a throw is a registry failure and propagates rather than being reported as
 * "no adapter registered".
 */
export async function resolveProbeAdapter(args: {
  readonly providerRegistry: ProviderRegistry;
  readonly providerId: string;
  readonly providerWireRow: ProbeProviderRow | undefined;
}): Promise<ProviderAdapter | undefined> {
  const { providerRegistry, providerId, providerWireRow } = args;
  let adapter = await providerRegistry.loadOne(providerId);
  if (!adapter) {
    try {
      if (providerWireRow?.baseUrl) {
        const wireProfile = resolveByokWireProfile(
          providerWireRow.wireFamilyDefault,
          providerWireRow.compatibilityProfile as CompatibilityProfile | null,
        );
        adapter = new OpenAICompatibleAdapter({
          provider_id: providerId as ProviderId,
          base_url: providerWireRow.baseUrl,
          authentication_header_shape: wireProfile.authHeaderShape,
          endpoint_paths_by_wire_family: wireProfile.endpointPathsByWireFamily,
        });
      }
    } catch {
      // Custom adapter resolution failures safely fall through to unconfigured provider response.
    }
  }
  return adapter;
}

/**
 * The reasoning shape a probe carries. `effort` is the level every reasoning
 * wire honors, so an explicit operator choice must reach the wire that serves
 * the model — not only the Responses one. `summary_mode` is Responses-only
 * (Chat and Messages have no summary knob), so it is omitted there rather than
 * sent as a field the wire codec would silently drop.
 */
export interface ProbeReasoning {
  effort: ReasoningEffortLevel;
  summary_mode?: "auto" | "concise" | "detailed";
}

/** Tenant probe preferences that shape the request and telemetry. */
export interface ProbePreferences {
  readonly probeReasoning: ProbeReasoning | undefined;
  readonly payloadCaptureEnabled: boolean;
}

/**
 * Phase 4 — load the tenant's probe preferences. Global Responses reasoning
 * mode defaults to `detailed` (not hard-coded probe/v1). When the probed model
 * is a Responses wire (muse-spark etc) the summary is forced to the tenant's
 * preference.
 */
export async function loadProbePreferences(args: {
  readonly db: CartethyiaDatabase;
  readonly tenantId: string;
  readonly wireFamily: WireFamily;
  readonly request: ProbeModelRequest;
}): Promise<ProbePreferences> {
  const { db, tenantId, wireFamily, request } = args;
  let probeReasoning: ProbeReasoning | undefined;
  let payloadCaptureEnabled = false;
  // `auto` (and an omitted effort) means "send no reasoning intent": the probe
  // must reflect what the route does by itself, and a model that does not
  // support reasoning would otherwise fail a probe that should have passed.
  const requestedEffort =
    request.reasoningEffort === undefined || request.reasoningEffort === "auto"
      ? undefined
      : request.reasoningEffort;
  try {
    const rows = await db
      .select({ preferences: consoleSettings.preferences })
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    const preferences = rows[0]?.preferences;
    const raw = preferences?.responsesReasoningSummary;
    const mode: "auto" | "concise" | "detailed" =
      raw === "auto" || raw === "concise" || raw === "detailed" ? raw : "detailed";
    payloadCaptureEnabled =
      preferences?.telemetryPayloads === "full" ||
      preferences?.telemetryPayloads === "metadata";
    if (requestedEffort !== undefined) {
      probeReasoning = {
        effort: requestedEffort,
        // Only the Responses wire has a summary knob; Chat/Messages probes carry
        // the effort alone.
        ...(wireFamily === "responses" ? { summary_mode: mode } : {}),
      };
    }
  } catch {
    if (requestedEffort !== undefined) {
      probeReasoning = {
        effort: requestedEffort,
        ...(wireFamily === "responses" ? { summary_mode: "detailed" as const } : {}),
      };
    }
  }
  return { probeReasoning, payloadCaptureEnabled };
}

/**
 * Phase 5 — build the canonical probe request. The probe prompt must pass every
 * provider's content-policy review (a bare "hi" trips CodeBuddy's 11140 safety
 * filter) AND produce a useful sample: ask the model to identify itself and
 * state its knowledge cutoff, which both proves a live text response and
 * surfaces a small diagnostic sample in the probe result.
 */
export function buildProbeCanonicalRequest(args: {
  readonly modelId: string;
  readonly request: ProbeModelRequest;
  readonly probeReasoning: ProbeReasoning | undefined;
  readonly sourceSurface: SourceSurface;
}): CanonicalRequest {
  const { modelId, request, probeReasoning, sourceSurface } = args;
  return {
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          {
            kind: "text",
            text:
              request.prompt ??
              "What model are you, and what is your knowledge cutoff date? Answer in one sentence.",
          },
        ],
      },
    ],
    generation_controls: {
      max_tokens: request.maxOutputTokens ?? 1024,
      max_output_tokens: request.maxOutputTokens ?? 1024,
      temperature: 0.2,
    },
    ...(probeReasoning ? { reasoning: probeReasoning as never } : {}),
    // Streaming by default. Every probe funnels through here, so one default
    // gives all three entry points (single model, all models, all accounts) the
    // same transport — and a streamed probe is the only one that observes
    // time-to-first-byte, which is what the dashboard reports. A caller that
    // explicitly asks for a non-streamed probe (`stream: false`) still gets one.
    stream: request.stream ?? true,
    source_surface: sourceSurface,
  };
}

/**
 * Phase 7 — mirror the probe's outcome onto the account's health machine. A
 * probe that fails against a real account carries the same health signal as
 * live traffic (quota exhaustion, dead credentials): record it so the account
 * cools down / disables instead of staying green while every probe fails.
 * Non-mutating categories (unknown, policy) are no-ops inside
 * `recordAccountFailure`; this never throws. A successful probe proves the
 * account works, so recover it symmetrically (a cooling account flips back to
 * active instead of staying stale).
 */
export async function recordProbeHealth(args: {
  readonly db: CartethyiaDatabase;
  readonly invalidator: { invalidate(): unknown } | undefined;
  readonly accountId: string | undefined;
  readonly dispatchError: unknown;
  readonly modelId: string;
  readonly upstreamStatusCode: number | undefined;
}): Promise<void> {
  const { db, invalidator, accountId, dispatchError, modelId, upstreamStatusCode } = args;
  if (dispatchError !== undefined && accountId) {
    const failureEvidence = {
      ...classifyUpstreamFailure(dispatchError),
      modelId,
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
    };
    // The health machine owns the outcome. A 202 that carries a rate limit is
    // already classified as `rate_limit_transient` with a real cooldown by
    // `classifyAccountError`, so writing a status here only clobbered that
    // cooldown with a state nothing recovers from.
    await recordAccountFailure(db, accountId, dispatchError, failureEvidence)
      .then((classification) => {
        if (classification?.mutatesAccount) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
  // Symmetric: a successful probe proves the account works, so recover it
  // (a cooling account flips back to active instead of staying stale).
  // recordAccountSuccess is a no-op write for already-healthy accounts and
  // never throws.
  if (dispatchError === undefined && accountId) {
    await recordAccountSuccess(db, accountId)
      .then((recovered) => {
        if (recovered) void invalidator?.invalidate();
      })
      .catch(() => {});
  }
}

/** The connectivity verdict a probe's event stream and dispatch error yield. */
export interface ProbeVerdict {
  readonly ok: boolean;
  readonly errorMessage: string | undefined;
  readonly usage: UsageRecord | undefined;
}

/**
 * Phase 8 — turn the probe's event stream and any dispatch error into the
 * verdict. Reasoning-only models can exhaust the tiny probe budget before
 * emitting visible text: a `length`-capped run that still produced reasoning
 * content proves connectivity, so count it as a pass.
 */
export function computeProbeVerdict(args: {
  readonly events: readonly CanonicalEvent[];
  readonly dispatchError: unknown;
  readonly providerId: string;
  readonly modelId: string;
  readonly wireFamily: WireFamily;
  readonly endpointPath: string;
}): ProbeVerdict {
  const { events, dispatchError, providerId, modelId, wireFamily, endpointPath } = args;
  const terminal = events.find((event) => event.type === "terminal");
  const producedReasoning = events.some(
    (event) => event.type === "content_delta" && event.content.kind === "reasoning",
  );
  const cappedButReasoning =
    terminal?.type === "terminal" &&
    terminal.state === "complete" &&
    terminal.stop_reason === "length" &&
    producedReasoning;
  const ok =
    dispatchError === undefined &&
    terminal?.type === "terminal" &&
    (terminal.state === "complete" || cappedButReasoning);
  let errorMessage: string | undefined;
  if (dispatchError !== undefined) {
    const base =
      dispatchError instanceof GatewayError
        ? dispatchError.message
        : dispatchError instanceof Error
          ? dispatchError.message
          : "Model probe failed";
    // Present upstream errors with provider/wire/status context instead of a
    // raw JSON blob like "{\"error\":\"Not Found\",\"success\":false}".
    // Try to unwrap a JSON-stringified error body first.
    let pretty = base;
    const trimmed = base.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : undefined;
        if (inner) pretty = inner;
      } catch {
        // Malformed or non-standard JSON error payloads safely retain original error message.
      }
    }
    const details =
      dispatchError instanceof GatewayError
        ? (dispatchError.details as Record<string, unknown>)
        : undefined;
    const status =
      dispatchError instanceof GatewayError && typeof dispatchError.status === "number"
        ? dispatchError.status
        : undefined;
    const providerCode =
      typeof details?.providerCode === "string" ? String(details.providerCode) : undefined;
    const providerStatus =
      typeof details?.providerStatus === "number" ? Number(details.providerStatus) : undefined;
    const upstreamReq =
      typeof details?.upstreamRequestId === "string"
        ? String(details.upstreamRequestId)
        : undefined;
    const wireLabel = `${wireFamily} ${endpointPath}`;
    const statusTag =
      providerCode !== undefined && providerStatus !== undefined
        ? `${providerCode} (upstream ${status ?? providerStatus})`
        : providerCode !== undefined
          ? providerCode
          : status !== undefined
            ? `upstream ${status}`
            : undefined;
    errorMessage =
      statusTag !== undefined
        ? `${providerId}/${modelId} via ${wireLabel} — ${pretty} (${statusTag})${upstreamReq ? ` [req ${upstreamReq}]` : ""}`
        : upstreamReq !== undefined
          ? `${providerId}/${modelId} via ${wireLabel} — ${pretty} [req ${upstreamReq}]`
          : `${providerId}/${modelId} via ${wireLabel} — ${pretty}`;

  } else if (terminal?.type === "terminal" && terminal.state !== "complete") {
    errorMessage = terminal.stop_reason ?? "Model probe failed";
  } else {
    errorMessage = undefined;
  }
  const usage = terminal?.type === "terminal" ? terminal.usage : undefined;
  return { ok, errorMessage, usage };
}
