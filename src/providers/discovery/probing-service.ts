/**
 * Provider probing and model-discovery orchestration.
 *
 * Network probes and `/v1/models` discovery stay separate from the Drizzle
 * catalog repository while sharing the provider catalog contract.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { models, providerAccounts, providers } from "../../persistence/schema";
import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../../transport/canonical-model";
import { WIRE_FAMILIES } from "../../transport/canonical-model";
import { isRecord } from "../../protocol/primitives";
import type { FetchLike } from "../quota/quota-contracts";
import type { CompatibilityProfile } from "../provider-metadata";
import {
  type ByokConnectionTestRequest,
  type ByokConnectionTestResult,
  type ProbeAllAccountsResult,
  type ProbeAllModelsResult,
  type ProbeModelRequest,
  type ProbeModelResult,
} from "./discovery-types";
import { modelsDevCatalog } from "./models-dev-catalog";
import { fetchOpenAICompatibleModels } from "./openai-model-discovery";
import {
  applyDiscoveredWire,
  resolveDiscoveredWire,
  staticEndpointForWire,
  type DiscoveredModelWire,
} from "./probe-wire";
import {
  buildProbeCanonicalRequest,
  computeProbeVerdict,
  extractSample,
  hasMeaningfulOutput,
  loadProbePreferences,
  recordProbeHealth,
  resolveProbeAdapter,
  resolveProbeTarget,
  selectProbeAccount,
  wireContextFrom,
  type ProbeProviderRow,
} from "./probe-phases";
import { createDefaultProviderRegistry } from "../default-registry";
import { authHeaders } from "../compatible-adapter";
import {
  byokAuthHeaderShape,
  modelDiscoveryBaseUrl,
  modelListUrl,
  resolveByokWireProfile,
} from "../operations/byok-wire-profile";
import { resolveCustomCliHeaders } from "../operations/custom-cli-headers";
import { GATEWAY_PROBE_USER_AGENT } from "../operations/gateway-user-agent";
import { resolveCredentialForAccount } from "../operations/provider-credential-service";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../../transport/gateway-error";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { computeTokensPerSec } from "../../observability/token-speed";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import {
  providerBaseUrl,
  parseProviderId,
  type ProviderDispatchTarget as AdapterDispatchTarget,
  type ModelDefinition,
  type ValidatedOutboundFetch,
  type ProviderRegistry,
} from "../provider-registry";

/** Max models probed concurrently per batch (outside the sequential warm-up). */
const PROBE_CONCURRENCY = 5;

export interface ProbeOutboundBinding {
  readonly fetch: ValidatedOutboundFetch;
  readonly networkPoolId?: string;
  readonly release?: () => void;
}

export type ProbeOutboundResolver = (
  tenantId: string,
  providerId?: string,
) => Promise<ValidatedOutboundFetch | ProbeOutboundBinding> | ValidatedOutboundFetch | ProbeOutboundBinding;

interface ProviderProbingDeps {
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor: ProbeOutboundResolver;
  readonly snapshotInvalidator: { invalidate(): unknown };
  readonly providerRegistry: ProviderRegistry;
}

interface ProviderProbingTestDeps {
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly defaultEndpoints?: Record<WireFamily, string>;
  readonly bundledModelCatalog?: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor?: ProbeOutboundResolver;
  readonly snapshotInvalidator?: { invalidate(): unknown };
  readonly providerRegistry?: ProviderRegistry;
}

export function createProviderProbingServiceForTests(deps: ProviderProbingTestDeps): ProviderProbingService {
  return new ProviderProbingService({
    db: deps.db,
    telemetryBuffer: deps.telemetryBuffer,
    defaultEndpoints: deps.defaultEndpoints ?? {
      chat: "/v1/chat/completions",
      responses: "/v1/responses",
      messages: "/v1/messages",
      native: "/v1/chat/completions",
    },
    bundledModelCatalog: deps.bundledModelCatalog ?? new Map(),
    outboundFetchFor:
      deps.outboundFetchFor ??
      (() => ({ fetch: (async () => new Response("{}", { status: 500 })) as ValidatedOutboundFetch })),
    snapshotInvalidator: deps.snapshotInvalidator ?? { invalidate: () => 0 },
    providerRegistry: deps.providerRegistry ?? createDefaultProviderRegistry(),
  });
}

/**
 * Adapts a validated outbound fetch to the `FetchLike` shape discovery
 * helpers expect. Only the call signature is consumed downstream.
 */
function asFetchLike(fetchFn: ValidatedOutboundFetch): FetchLike {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetchFn(input, init);
  return Object.assign(wrapped, { preconnect: () => undefined });
}

function asOutboundBinding(
  resolved: ValidatedOutboundFetch | ProbeOutboundBinding,
): ProbeOutboundBinding {
  return typeof resolved === "function" ? { fetch: resolved } : resolved;
}
export class ProviderProbingService {
  private readonly db: CartethyiaDatabase;
  private readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  private readonly payloadCapture: TelemetryPayloadCapture;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeOutboundResolver;
  private readonly snapshotInvalidator: { invalidate(): unknown };
  private readonly providerRegistry: ProviderRegistry;

  constructor(deps: ProviderProbingDeps) {
    this.db = deps.db;
    this.telemetryBuffer = deps.telemetryBuffer;
    this.payloadCapture = new TelemetryPayloadCapture(this.db);
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.snapshotInvalidator = deps.snapshotInvalidator;
    this.providerRegistry = deps.providerRegistry;
  }

  /**
   * The provider row columns that decide wire-family/endpoint resolution.
   * `probeModel` loads this once and reuses it for the contract gate, the
   * custom-adapter fallback, and the wire context.
   */
  private async loadProviderWireRow(providerId: string): Promise<ProbeProviderRow | undefined> {
    const rows = await this.db
      .select({
        baseUrl: providers.baseUrl,
        wireFamilyDefault: providers.wireFamilyDefault,
        compatibilityProfile: providers.compatibilityProfile,
        requiresAccount: providers.requiresAccount,
      })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Static endpoint for one provider + wire family, if the bundled catalog
   * ships a static definition for it. Used by manual registration (via the
   * console store) so it resolves the same provider-truth endpoints as probes.
   */
  async resolveStaticEndpoint(
    providerId: string,
    wireFamily: WireFamily,
  ): Promise<string | undefined> {
    return staticEndpointForWire(this.bundledModelCatalog, providerId, wireFamily);
  }

  /** One-shot connectivity test: resolves a usable account + the real per-provider
   * adapter, dispatches a minimal canonical request through the model's own wire
   * family/endpoint (never a hardcoded `/v1/chat/completions`), and records the
   * outcome into `telemetry_events` via the same writer live traffic uses. */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    const startedAt = Date.now();
    const modelId = request.modelId;
    // One provider snapshot per probe: the contract gate, the account gate, the
    // custom-adapter fallback, and the wire context all read this same row, so a
    // concurrent edit cannot make two reads disagree.
    const providerWireRow = await this.loadProviderWireRow(providerId);
    const requiresAccount = providerWireRow?.requiresAccount ?? true;

    const { wireFamily, endpointPath, sourceSurface } = await resolveProbeTarget({
      db: this.db,
      bundledModelCatalog: this.bundledModelCatalog,
      defaultEndpoints: this.defaultEndpoints,
      providerId,
      modelId,
      request,
      providerWireRow,
    });

    const account = await selectProbeAccount({
      db: this.db,
      tenantId,
      providerId,
      requestedAccountId: request.accountId,
      requiresAccount,
    });
    if (!account.ok) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: account.error };
    }
    const accountId = account.accountId;

    const adapter = await resolveProbeAdapter({
      providerRegistry: this.providerRegistry,
      providerId,
      providerWireRow,
    });
    if (!adapter) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `No adapter registered for provider ${providerId}`,
      };
    }

    const { probeReasoning, payloadCaptureEnabled } = await loadProbePreferences({
      db: this.db,
      tenantId,
      wireFamily,
      request,
    });
    const canonicalRequest = buildProbeCanonicalRequest({
      modelId,
      request,
      probeReasoning,
      sourceSurface,
    });
    let capturedRequest = canonicalRequest;
    const parsedProviderId = parseProviderId(providerId);
    const candidate: AdapterDispatchTarget = {
      provider_id: parsedProviderId,
      model_id: modelId,
      wire_family: wireFamily,
      endpoint_path: endpointPath,
      capabilities: {},
    };

    const probeSignal = AbortSignal.timeout(30_000);
    const events: CanonicalEvent[] = [];
    let ttfbMs: number | undefined;
    let dispatchError: unknown;
    let networkPoolId: string | undefined;
    try {
      // Public providers (`requires_account: false`) probe credential-free;
      // anything else resolves the health-filtered account selected above.
      const credential = accountId
        ? await resolveCredentialForAccount(this.db, providerId, accountId)
        : { provider_id: parsedProviderId, credential_kind: "none" as const };
      const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
      networkPoolId = outbound.networkPoolId;
      try {
        const dispatchProbe = async (request: CanonicalRequest): Promise<void> => {
          capturedRequest = request;
          for await (const event of adapter.dispatch(request, candidate, {
            credential,
            deadline: startedAt + 30_000,
            abort_signal: probeSignal,
            outbound_fetch: outbound.fetch,
          })) {
            if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
            events.push(event);
          }
        };
        try {
          await dispatchProbe(canonicalRequest);
          if (!hasMeaningfulOutput(events)) throw new Error("probe response content empty");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/empty\s+(?:response\s+)?content|response\s+content\s+empty/i.test(message)) {
            throw error;
          }
          // Some reasoning models spend the short non-stream probe budget before
          // producing visible text. Retry generically as a streamed probe with a
          // larger output allowance; no provider/model id special case is needed.
          events.length = 0;
          ttfbMs = undefined;
          await dispatchProbe({
            ...canonicalRequest,
            stream: true,
            generation_controls: {
              ...canonicalRequest.generation_controls,
              max_tokens: 1024,
              max_output_tokens: 1024,
            },
          });
        }
      } finally {
        outbound.release?.();
      }
    } catch (error) {
      dispatchError = error;
    }

    const upstreamStatusCode =
      dispatchError instanceof GatewayError && typeof dispatchError.details.upstreamStatus === "number"
        ? dispatchError.details.upstreamStatus
        : undefined;
    await recordProbeHealth({
      db: this.db,
      invalidator: this.snapshotInvalidator,
      accountId,
      dispatchError,
      modelId,
      upstreamStatusCode,
    });

    const latencyMs = Date.now() - startedAt;
    const { ok, errorMessage, usage } = computeProbeVerdict({
      events,
      dispatchError,
      providerId,
      modelId,
      wireFamily,
      endpointPath,
    });

    const requestId = crypto.randomUUID();

    // Token speed shared with live traffic (`computeTokensPerSec`): probes
    // record TTFT+latency only, so they report end-to-end effective speed.
    const tokensPerSec = computeTokensPerSec({
      outputTokens: usage?.output_tokens,
      latencyMs,
    });

    // Probe telemetry rides the same batch buffer as live traffic. Keep the
    // probe bodies linked by request_id so the console can inspect the exact
    // canonical request and provider event stream that produced the result.
    this.telemetryBuffer?.enqueue({
      tenantId,
      requestId,
      sourceSurface,
      requestedModel: modelId,
      endpoint: endpointPath,
      userAgent: "gateway-probe",
      providerId,
      ...(accountId ? { accountId } : {}),
      ...(networkPoolId ? { networkPoolId } : {}),
      latencyMs,
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
      stream: capturedRequest.stream,
      status: ok ? "completed" : "failed",
      ...(ok ? {} : { errorCategory: errorMessage ?? "probe_failed" }),
      ...(usage ? { usage } : {}),
      ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
    });
    if (this.telemetryBuffer && payloadCaptureEnabled) {
      await this.payloadCapture
        .capture({
          tenantId,
          requestId,
          requestBody: capturedRequest,
          responseBody: events,
          scope: "tenant",
          tenantOptIn: true,
        })
        .catch(() => undefined);
    }

    const sample = extractSample(events);
    return {
      ...(accountId ? { accountId } : {}),
      ok,
      latencyMs,
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
      ...(sample ? { sample } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }

  /**
   * Ad-hoc connectivity test for a not-yet-persisted BYOK provider.
   *
   * Dispatches a real `GET <base>/models` through the same SSRF-validated
   * outbound fetch live traffic uses, stamping the credential with the auth
   * header the chosen wire family actually reads (`x-api-key` for Messages,
   * `Authorization: Bearer` otherwise) plus that wire's CLI identity headers.
   * Reachability is the contract: any HTTP response proves the operator's base
   * URL, credential, and egress path work — a 4xx is reported with its status
   * rather than disguised as a transport failure.
   */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    const startedAt = Date.now();
    const requestedWire = request.wireFamily;
    const wireFamily: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(requestedWire)
      ? (requestedWire as WireFamily)
      : "chat";
    const url = modelListUrl(request.baseUrl);
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId));
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        // Probes identify as the gateway, never as first-party CLI tooling:
        // this path only runs GET /models against a BYOK base URL the
        // operator is testing, never Codex/Claude-Code-shaped traffic.
        // The gateway probe identity is authoritative: it is assigned after
        // the CLI spread so an explicit CLI request cannot overwrite it,
        // while operator extra headers still can.
        ...authHeaders(
          byokAuthHeaderShape([wireFamily]),
          new TextEncoder().encode(request.apiKey),
          request.apiKey.trim().length > 0 ? "api_key" : "none",
        ),
        ...(request.cliIdentity === false ? {} : resolveCustomCliHeaders(wireFamily)),
        ...(request.extraHeaders ?? {}),
        "user-agent": GATEWAY_PROBE_USER_AGENT,
      };
      const response = await outbound.fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          latencyMs,
          statusCode: response.status,
          error: `Upstream rejected the connection test with HTTP ${response.status}`,
        };
      }
      // A body is nice to have but not required: some gateways answer `/models`
      // with an empty envelope. Read it defensively so a non-JSON body cannot
      // turn a successful reachability check into a failure.
      let modelCount: number | undefined;
      try {
        const payload = (await response.json()) as unknown;
        const entries = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload["data"])
            ? payload["data"]
            : isRecord(payload) && Array.isArray(payload["models"])
              ? payload["models"]
              : undefined;
        if (entries) modelCount = entries.length;
      } catch {
        // Non-JSON success body: reachability already proven by the 2xx.
      }
      return {
        ok: true,
        latencyMs,
        statusCode: response.status,
        ...(modelCount === undefined ? {} : { modelCount }),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Connection test failed",
      };
    } finally {
      outbound.release?.();
    }
  }

  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
    try {
      const discoveryFetch = asFetchLike(outbound.fetch);
      const resolver = await this.providerRegistry.resolveModelDiscovery(providerId);
      if (resolver) {
        const requiresCredential = this.providerRegistry.modelDiscoveryRequiresCredential(providerId);
        const secret = requiresCredential
          ? await this.usableAccountSecret(tenantId, providerId)
          : "";
        if (requiresCredential && secret === undefined) {
          throw new GatewayError(
            "invalid_request",
            409,
            `Model sync needs a usable (active, non-cooldown) ${providerId} account first`,
          );
        }
        const providerRow = await this.loadProviderWireRow(providerId);
        const effectiveBaseUrl = providerRow?.baseUrl ?? providerBaseUrl(providerId) ?? "";
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await resolver({
            baseUrl: effectiveBaseUrl,
            credential: secret ?? "",
            ...(discoveryFetch ? { fetcher: discoveryFetch } : {}),
          });
        } catch (error) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
        if (!discovered) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: endpoint returned no usable models`,
          );
        }
        const ctx = wireContextFrom(providerRow);
        return this.persistDiscoveredModels(
          providerId,
          discovered,
          (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
          ctx.endpointPathsByWireFamily,
          effectiveBaseUrl,
        );
      }

      const providerRow = await this.loadProviderWireRow(providerId);
      if (providerRow?.baseUrl) {
        const secret = await this.usableAccountSecret(tenantId, providerId);
        if (secret) {
          // An Anthropic-compatible root reads `x-api-key`, not bearer auth,
          // and a bare host needs its `/v1` segment before `/models` joins on.
          // Both are derived from the same wire profile dispatch uses, so
          // auto-fetch behaves identically for either flavor of custom provider.
          const wireProfile = resolveByokWireProfile(
            providerRow.wireFamilyDefault,
            providerRow.compatibilityProfile as CompatibilityProfile | null,
          );
          const modelsBaseUrl = modelDiscoveryBaseUrl(providerRow.baseUrl);
          let discovered: readonly ModelDefinition[] | null;
          try {
            discovered = await fetchOpenAICompatibleModels({
              baseUrl: modelsBaseUrl,
              providerId,
              headers: {
                ...authHeaders(
                  wireProfile.authHeaderShape,
                  new TextEncoder().encode(secret),
                  "api_key",
                ),
              },
              ...(discoveryFetch ? { fetcher: discoveryFetch as typeof fetch } : {}),
            });
          } catch (error) {
            throw new GatewayError(
              "transport_unavailable",
              502,
              `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
          if (discovered && discovered.length > 0) {
            const ctx = wireContextFrom(providerRow);
            return this.persistDiscoveredModels(
              providerId,
              discovered,
              (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
              ctx.endpointPathsByWireFamily,
              providerRow.baseUrl ?? undefined,
              // The generic `/models` fetch guesses a wire from the model id;
              // the row's own profile is what the adapter will enforce, so it
              // decides which guess is admissible.
              wireProfile.supportedWireFamilies,
            );
          }
        }
      }

      return { synced: 0 };
    } finally {
      outbound.release?.();
    }
  }

  private async persistDiscoveredModels(
    providerId: string,
    discoveredModels: readonly (string | ModelDefinition)[],
    resolve: (modelId: string) => DiscoveredModelWire,
    endpointOverrides?: Partial<Record<WireFamily, string>>,
    baseUrl?: string,
    supportedWireFamilies?: readonly WireFamily[],
  ): Promise<{ synced: number }> {
    // Static definitions are the injected bundled catalog; the probing service
    // and the console store are both handed the same startup-built map.
    const staticDefinitions: readonly ModelDefinition[] =
      this.bundledModelCatalog.get(providerId) ?? [];
    const staticEndpoints: Partial<Record<WireFamily, string>> = {};
    for (const definition of staticDefinitions) {
      staticEndpoints[definition.wireFamily] ??= definition.endpointPath;
    }
    // Fetch only adds genuinely new models: an id the builtin catalog
    // already owns stays exactly one (builtin) row instead of gaining a
    // discovered shadow that confuses pickers and deletes.
    const builtinIds = new Set(staticDefinitions.map((definition) => definition.modelId));
    // `(modelId, endpointPath)` is the row identity, so a corrected wire family
    // lands on a *new* row and would leave the old one behind as a dead route.
    // Collect this run's pairs and drop the provider's superseded discovered
    // rows for the same ids afterwards.
    const resolvedPairs: Array<{ modelId: string; endpointPath: string }> = [];
    const rows: Array<typeof models.$inferInsert> = [];
    // `(modelId, endpointPath)` is the row identity and the upsert's conflict
    // target, so a listing that repeats a pair (the bespoke discoveries return
    // raw upstream ids) would make a multi-row `ON CONFLICT DO UPDATE` fail with
    // "cannot affect row a second time". Keep the first row per pair, as the
    // builtin seeder does, so one statement can carry a whole chunk.
    const seenPairs = new Set<string>();
    for (const item of discoveredModels) {
      const modelId = typeof item === "string" ? item : item.modelId;
      if (builtinIds.has(modelId)) continue;
      const resolved = resolve(modelId);
      const discDef = typeof item === "string" ? undefined : item;
      const { wireFamily, endpointPath } = applyDiscoveredWire({
        resolvedWireFamily: resolved.wireFamily,
        resolvedEndpointPath: resolved.endpointPath,
        ...(discDef !== undefined
          ? { discoveredWireFamily: discDef.wireFamily, discoveredEndpointPath: discDef.endpointPath }
          : {}),
        staticEndpoints,
        ...(endpointOverrides !== undefined ? { endpointOverrides } : {}),
        ...(supportedWireFamilies !== undefined ? { supportedWireFamilies } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      resolvedPairs.push({ modelId, endpointPath });
      const pairKey = `${modelId}\u0000${endpointPath}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const knownDefinition = staticDefinitions.find((definition) => definition.modelId === modelId);
      const sourceUpdatedAt = new Date();
      const metadata = {
        contextLimit: knownDefinition?.contextLimit ?? discDef?.contextLimit ?? null,
        outputLimit: knownDefinition?.outputLimit ?? discDef?.outputLimit ?? null,
        modalities: knownDefinition?.modalities ?? discDef?.modalities ?? null,
        reasoning: knownDefinition?.reasoning ?? discDef?.reasoning ?? false,
        toolCall: knownDefinition?.toolCall ?? discDef?.toolCall ?? false,
        webSearch: knownDefinition?.webSearch ?? discDef?.webSearch ?? false,
        cost: modelsDevCatalog.costFor(providerId, modelId),
      };
      rows.push({
        providerId,
        modelId,
        wireFamily,
        endpointPath,
        ...metadata,
        source: "discovered",
        sourceUpdatedAt,
        enabled: true,
      });
    }
    // One statement per chunk (500, the account-health batch step) instead of
    // one round-trip per row. `excluded.*` reads the proposed row, so the update
    // set is the same columns the per-row upsert wrote.
    for (let offset = 0; offset < rows.length; offset += 500) {
      await this.db
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.providerId, models.modelId, models.endpointPath],
          set: {
            contextLimit: sql`excluded.context_limit`,
            outputLimit: sql`excluded.output_limit`,
            modalities: sql`excluded.modalities`,
            reasoning: sql`excluded.reasoning`,
            toolCall: sql`excluded.tool_call`,
            webSearch: sql`excluded.web_search`,
            cost: sql`excluded.cost`,
            source: sql`'discovered'`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
          },
        });
    }
    const synced = rows.length;
    // Drop this provider's discovered rows for the synced ids that are no
    // longer part of the resolved set — the stale `(model, endpoint)` pair left
    // behind when a corrected wire family moved a model to a new path. Rows the
    // operator added by hand (`manual`) and ids outside this run are untouched.
    if (resolvedPairs.length > 0) {
      const pairs = resolvedPairs.map(
        (pair) => sql`(${pair.modelId}, ${pair.endpointPath})`,
      );
      const ids = resolvedPairs.map((pair) => pair.modelId);
      await this.db
        .delete(models)
        .where(
          and(
            eq(models.providerId, providerId),
            eq(models.source, "discovered"),
            sql`${models.modelId} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`(${models.modelId}, ${models.endpointPath}) NOT IN (${sql.join(pairs, sql`, `)})`,
          ),
        );
    }
    return { synced };
  }

  private async usableAccountSecret(
    tenantId: string,
    providerId: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
        ),
      );
    const now = Date.now();
    const usable = rows
      .filter(
        (row) =>
          row.status !== "disabled" &&
          (row.cooldownUntil === null || row.cooldownUntil.getTime() <= now),
      )
      .sort((left, right) => Number(right.tenantId !== null) - Number(left.tenantId !== null))[0];
    if (!usable?.credentialCiphertext) return undefined;
    return decryptCredentialToString(usable.credentialCiphertext);
  }

  /**
   * Batched provider-wide probe: `modelIds[0]` runs sequentially (it warms
   * OAuth token caches and connection pools for the provider), the rest run
   * with `Promise.allSettled` bounded to `PROBE_CONCURRENCY`. Any per-model
   * failure is captured in its own result entry; the batch never rejects.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<ProbeAllModelsResult> {
    const results: Array<ProbeAllModelsResult["results"][number]> = [];
    const [firstModelId, ...restModelIds] = modelIds;
    if (firstModelId === undefined) return { providerId, results };

    const runOne = async (modelId: string): Promise<void> => {
      const outcome = await this.probeModel(tenantId, providerId, { modelId });
      results.push({
        modelId,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    };

    await runOne(firstModelId);
    for (let offset = 0; offset < restModelIds.length; offset += PROBE_CONCURRENCY) {
      const batch = restModelIds.slice(offset, offset + PROBE_CONCURRENCY);
      await Promise.allSettled(batch.map((modelId) => runOne(modelId)));
    }
    return { providerId, results };
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult> {
    const accounts = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
        ),
      );
    const results = await Promise.all(
      accounts.map(async (account) => {
        const result = await this.probeModel(tenantId, providerId, {
          ...request,
          accountId: account.id,
        });
        // No health write here: this used to regex the model's own answer text
        // for "202" and degrade the account on a match. A probe that genuinely
        // fails already reports through `recordAccountFailure`, which classifies
        // the real status; matching answer text is not a health signal.
        return { ...result, accountId: account.id };
      }),
    );
    return { providerId, modelId: request.modelId, results };
  }
}
