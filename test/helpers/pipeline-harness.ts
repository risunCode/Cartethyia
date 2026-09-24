import { createGatewayApp } from "../../src/app";
import type { App } from "../../src/app";
import type { CanonicalEvent, CanonicalRequest, UsageRecord } from "../../src/transport/canonical-model";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import type { ReadinessCheckResult } from "../../src/persistence/readiness";
import type { TelemetryBatchBuffer } from "../../src/observability/telemetry-buffer";
import type {
  PreparedProxyRequest,
  ProxyRequestPreparer,
} from "../../src/transport/request/preparer";
import { parseProviderId, type ProviderAdapter } from "../../src/providers/provider-registry";
import type { RouteCandidate, Reservation, RoutePlan } from "../../src/transport/routing/route-model";
import type { RoutingEngine } from "../../src/transport/routing/router";
import type { AdmissionLease, ApiKeyAdmissionService } from "../../src/security/admission";
import type { ResolvedApiKey } from "../../src/security/api-key-auth";
import type { ByokUpstreamHost } from "../../src/providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../../src/network/pool/resolver";
import type { ConsoleApiCompositionDeps } from "../../src/console/console-router";
import { projectForRoute, type RouteCapabilities } from "../../src/transport/translation/capabilities";
import type { ProductionAppDeps, ShutdownCoordinatorLike } from "../../src/app";
import { createConsoleApiStub } from "./console-api-stub";

/**
 * In-process production-pipeline harness.
 *
 * Drives the real HTTP composition root (`createGatewayApp` → ingress policy → client
 * identity → readiness → API-key authentication → canonical parse → proxy-route
 * preparation → provider dispatch) with in-process stubs for the I/O boundary:
 * the database, readiness probe, telemetry buffer, provider adapter, and the
 * upstream network binding. There is no test-only execution seam and no second
 * composition root — every assertion observes the production request path.
 *
 * Hermetic: no Postgres, Redis, or network access is required.
 */

/** Route capabilities that accept every canonical feature; the harness baseline. */
export const PERMISSIVE_ROUTE_CAPABILITIES: RouteCapabilities = {
  text: true,
  image: true,
  document: true,
  audio: true,
  webSearch: true,
  tools: true,
  parallelToolCalls: true,
  reasoning: true,
  reasoningEncryptedContent: true,
  responseJsonObject: true,
  responseJsonSchema: true,
  promptCaching: true,
  generationControls: new Set(),
  extensions: new Set(),
};

// A single permitted API-key row. `tenantId` stays empty so that
// `applyTenantPreferences` short-circuits (no tenant-preferences read) and the
// tenant-bound route check still passes (`"" === ""`). Only the DB keys
// `resolveApiKeyAuthorization` reads are present.
const harnessApiKeyRow = {
  id: "contract-key",
  tenantId: "",
  scopes: ["routing:invoke"] as const,
  revokedAt: null as Date | null,
};

/** Minimal drizzle-chain stub: API-key lookup is the only DB read on this path. */
function createApiKeyDb(): CartethyiaDatabase {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: async () => [harnessApiKeyRow],
              };
            },
          };
        },
      };
    },
  } as unknown as CartethyiaDatabase;
}

/**
 * Canonical event list the stub adapter yields: the same start → content (or
 * tool call) → terminal shape every surface encoder round-trips.
 */
function contractEvents(request: CanonicalRequest): readonly CanonicalEvent[] {
  const usage: UsageRecord = {
    input_tokens: request.messages.length,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: request.messages.length,
    output_tokens: 2,
    reasoning_tokens: "unavailable",
    estimated_cost: 0,
  };
  const events: CanonicalEvent[] = [
    {
      type: request.source_surface === "responses" ? "response_start" : "message_start",
      sequence_number: 1,
      event_id: "cartethyia-contract-response",
      model: request.model,
    },
  ];
  const toolName = request.tools?.[0]?.name;
  if (request.tools?.length) {
    events.push({
      type: "tool_call_delta",
      sequence_number: 2,
      call_id: "call-contract-1",
      arguments_delta: '{"key":"a"}',
      index: 0,
      ...(toolName === undefined ? {} : { name: toolName }),
    });
  } else {
    events.push({
      type: "content_delta",
      sequence_number: 2,
      content: { kind: "text", text: "Cartethyia contract response" },
    });
  }
  events.push({
    type: "terminal",
    sequence_number: 3,
    state: "complete",
    stop_reason: request.tools?.length ? "tool_use" : "stop",
    usage,
  });
  return events;
}

export interface PipelineHarnessOptions {
  /** Overrides the canonical events the stub adapter yields. */
  readonly events?: (request: CanonicalRequest) => readonly CanonicalEvent[];
  /** Provider id the stub adapter is registered under and the preparer selects. */
  readonly providerId?: string;
  /**
   * Makes the preparer stub reject any request the permissive route cannot
   * carry (image content, in practice) through the real `projectForRoute`
   * projection, before any adapter dispatch.
   */
  readonly rejectCapabilities?: boolean;
  /** Readiness probe override, for fail-closed coverage. Defaults to ready. */
  readonly readiness?: () => Promise<ReadinessCheckResult>;
  /** Dashboard static build directory for `/console/*` ownership coverage. */
  readonly dashboardDist?: string;
  /** Console API composition, for ownership coverage that spans both surfaces. */
  readonly consoleApi?: ConsoleApiCompositionDeps;
  /** Drain state source, so shutdown rejection is covered on the real pipeline. */
  readonly shutdownCoordinator?: ShutdownCoordinatorLike;
  /**
   * Overrides the in-process database stub. Defaults to the API-key-only stub;
   * pass a wider stub to exercise DB-backed read routes (`/v1/models*`).
   */
  readonly db?: CartethyiaDatabase;
}

export interface PipelineHarness {
  readonly app: App;
  /** Dispatch counter shared with the stub adapter. */
  readonly dispatchCounter: { count: number };
  /** Admission leases granted through the real attempt lifecycle. */
  readonly admissionCounter: { count: number };
  /** Routing reservations taken through the real attempt lifecycle. */
  readonly reservationCounter: { count: number };
  /** Lease releases observed; equals admissions once a request settles. */
  readonly leaseReleaseCounter: { count: number };
}

/**
 * Builds the production app wired to in-process stubs. The provider is
 * deliberately not a built-in id, so the request exercises the configurable
 * upstream path (validated host + network binding) exactly as a BYOK provider
 * would.
 */
export function buildPipelineHarness(options: PipelineHarnessOptions = {}): PipelineHarness {
  const providerId = options.providerId ?? "contract-stub";
  const dispatchCounter = { count: 0 };
  const events = options.events ?? contractEvents;
  const adapter: ProviderAdapter = {
    provider_id: parseProviderId(providerId),
    async *dispatch(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
      dispatchCounter.count += 1;
      yield* events(request);
    },
  };
  const byokUpstreamHosts = new Map<string, ByokUpstreamHost>([
    [providerId, { hostname: "upstream.test", port: 443 }],
  ]);
  const networkBindingFactory = {
    async resolve(hostname: string, _signal: AbortSignal, port = 443) {
      return { hostname, resolved_address: "127.0.0.1", endpoint_path: `:${port}` };
    },
    fetch() {
      return async () => new Response("{}", { headers: { "content-type": "application/json" } });
    },
  } as unknown as ValidatedNetworkBindingFactory;

  const readiness =
    options.readiness ??
    (async (): Promise<ReadinessCheckResult> => ({
      status: "ready",
      db: "connected",
      migrations: "applied",
      redis: "not_configured",
    }));
  // Mounting the production pipeline requires a telemetry buffer; its
  // `afterResponse` drain is not observable through `app.handle()`.
  const telemetryBuffer = { enqueue(): void {} } as unknown as TelemetryBatchBuffer;

  const admissionCounter = { count: 0 };
  const reservationCounter = { count: 0 };
  const leaseReleaseCounter = { count: 0 };
  const admissionService = {
    async admit(): Promise<AdmissionLease> {
      admissionCounter.count += 1;
      return {
        reservationId: "contract-lease",
        apiKeyId: harnessApiKeyRow.id,
        commitUsage: async () => {},
        release: async () => {
          leaseReleaseCounter.count += 1;
        },
        released: false,
      };
    },
  } as unknown as ApiKeyAdmissionService;

  const proxyPreparer = {
    async prepare(input: {
      readonly canonicalRequest: CanonicalRequest;
      readonly authorization: ResolvedApiKey;
      readonly deadlineMs: number;
    }): Promise<PreparedProxyRequest> {
      if (options.rejectCapabilities) {
        projectForRoute(input.canonicalRequest, {
          ...PERMISSIVE_ROUTE_CAPABILITIES,
          image: false,
        });
      }
      const candidate: RouteCandidate = {
        provider_id: providerId,
        model_id: input.canonicalRequest.model,
        wire_family:
          input.canonicalRequest.source_surface === "completion"
            ? "chat"
            : input.canonicalRequest.source_surface,
        endpoint: "/v1/chat/completions",
        capability_profile: {},
        requires_account: false,
      };
      const plan: RoutePlan = {
        revision: 1,
        candidates: [candidate],
        requested_model: input.canonicalRequest.model,
        resolved_model: input.canonicalRequest.model,
        provider_id: providerId,
      };
      const routingEngine = {
        async reserve(): Promise<Reservation> {
          reservationCounter.count += 1;
          return {
            candidate,
            lease_id: "contract-reservation",
            acquired_at: Date.now(),
            expires_at: Date.now() + 60_000,
          };
        },
        async release(): Promise<void> {},
      } as unknown as RoutingEngine;
      return {
        canonicalRequest: input.canonicalRequest,
        authorization: input.authorization,
        candidate,
        eligibleRouteCandidates: [candidate],
        plan,
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        deadlineMs: input.deadlineMs,
        routingEngine,
        admissionService,
      };
    },
  } as unknown as ProxyRequestPreparer;

  const db = options.db ?? createApiKeyDb();
  const app = createGatewayApp({
    mode: "production",
    db,
    readiness,
    telemetryBuffer,
    proxyPreparer,
    providerAdapters: new Map<string, ProviderAdapter>([[providerId, adapter]]),
    resolveProviderAdapter: async (id: string) =>
      id === providerId ? adapter : undefined,
    byokUpstreamHosts,
    networkBindingFactory,
    ipAbuseProtection: { checkBeforeAccess: async () => undefined } as never,
    trustedProxyBoundary: { mode: "disabled" },
    poolSelector: {} as never,
    snapshotService: {} as never,
    resolveOAuthRefresher: async () => undefined,
    oauthRefreshService: {} as never,
    consoleApi: options.consoleApi ?? createConsoleApiStub(db),
    ...(options.shutdownCoordinator === undefined
      ? {}
      : { shutdownCoordinator: options.shutdownCoordinator }),
    resolvePeerAddress: () => "127.0.0.1",
    ...(options.dashboardDist === undefined ? {} : { dashboardDist: options.dashboardDist }),
  } as unknown as ProductionAppDeps);

  return { app, dispatchCounter, admissionCounter, reservationCounter, leaseReleaseCounter };
}
