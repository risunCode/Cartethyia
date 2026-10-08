/**
 * In-process driver for the real production HTTP composition root.
 *
 * Suites call `createTestGateway()` and then `gateway.request(...)`; every
 * request travels the deployed path — ingress policy, client identity,
 * readiness, API-key authentication, canonical parse, route preparation,
 * dispatch, surface encode — with only the *network* boundary replaced by an
 * in-process adapter. There is no second composition root and no test-only
 * execution seam, so an assertion here is an assertion about the gateway.
 *
 * Two properties make it fast enough to run thousands of times:
 *
 * - **No listening socket.** `app.handle(request)` invokes Elysia's router
 *   directly, so a request costs a function call instead of a TCP round trip.
 * - **No upstream.** The stub adapter yields canonical events from memory, so
 *   a suite never waits on DNS, TLS, or a provider.
 *
 * PostgreSQL is real: API-key resolution, routing snapshots, and telemetry all
 * read the test database, because those are exactly the layers whose SQL a
 * stub would stop covering.
 */
import { createGatewayApp } from "../../src/app";
import type { App } from "../../src/app";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { getDb } from "../../src/persistence/postgres";
import type { ReadinessCheckResult } from "../../src/persistence/readiness";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ContentPart,
  UsageRecord,
} from "../../src/transport/canonical-model";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  WebSearchOutcome,
  WebSearchResult,
} from "../../src/providers/provider-registry";
import { parseProviderId } from "../../src/providers/provider-registry";
import { ProxyRequestPreparer } from "../../src/transport/request/preparer";
import { RoutingEngine } from "../../src/transport/routing/router";
import { ApiKeyAdmissionService } from "../../src/security/admission/service";
import { InMemoryAdmissionCounterStore } from "../../src/security/admission/in-memory-store";
import { ProxyRequestStateStore } from "../../src/transport/request/state";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";
import { TelemetryBatchBuffer } from "../../src/observability/telemetry-buffer";
import { IpAbuseProtectionService, InMemoryIpAbuseStore } from "../../src/security/abuse";
import { ValidatedNetworkBindingFactory } from "../../src/network/pool/resolver";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import { ShutdownCoordinator } from "../../src/runtime/lifecycle";
import type { TrustedProxyBoundary } from "../../src/config";
import { getTestPool } from "./database";

/**
 * Loopback-only trust boundary. The test peer address is `127.0.0.1`, so a
 * suite can drive a forwarded client IP by setting `x-forwarded-for`; without
 * this the gateway would correctly ignore that header and every
 * client-identity assertion would be untestable.
 */
const TEST_TRUSTED_PROXY_BOUNDARY: TrustedProxyBoundary = {
  mode: "trusted",
  allowlist: ["127.0.0.1/32", "::1/128"],
};

/** A routing snapshot that serves one model on one provider account. */
export interface TestRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
  readonly accountLabel?: string;
  readonly wireFamily?: "chat" | "responses" | "messages";
  readonly endpoint?: string;
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly maxInflight?: number;
  /** Service kind the catalog row carries; `websearch` models a search route. */
  readonly serviceKind?: "llm" | "systemone" | "websearch";
  /**
   * Health marker the catalog would project onto this candidate.
   *
   * `cooldown` leaves the candidate eligible but ordered last; `model_cooldown`
   * and `disabled` are hard exclusions. A suite sets it here rather than
   * writing account rows because the router reads the *candidate*, and
   * `route-catalog.ts` is what turns `provider_accounts.status` plus an
   * unexpired `model_cooldowns` entry into this marker.
   */
  readonly healthStatus?: "cooldown" | "model_cooldown" | "disabled";
  /** Cooldown class the catalog projects when `healthStatus` is `cooldown`. */
  readonly cooldownKind?: "hard" | "soft";
}
/**
 * Capabilities a fixture route advertises unless a suite says otherwise.
 *
 * A route with an empty capability profile is a route that supports nothing,
 * and the router responds by *degrading* the request — stripping tools, then
 * reasoning, then images — until something fits. That is correct behavior and
 * it makes an empty profile a trap for a suite: a test asserting on tool-call
 * encoding would silently exercise the degraded (tool-less) path instead.
 *
 * This is the permissive baseline, so a suite that wants to observe degradation
 * declares the narrow profile explicitly. It mirrors what a real
 * OpenAI-compatible provider row carries.
 */
export const PERMISSIVE_CAPABILITIES: Readonly<Record<string, boolean>> = {
  text: true,
  image: true,
  document: true,
  audio: true,
  web_search: true,
  tools: true,
  parallel_tool_calls: true,
  reasoning: true,
  reasoning_encrypted_content: true,
  response_format_json_object: true,
  response_format_json_schema: true,
  prompt_caching: true,
};

/**
 * Canonical event sequence the stub adapter produces for one dispatch.
 *
 * Deliberately minimal and complete: a start frame, one content delta, and the
 * single `terminal` frame that closes every canonical stream. The shapes come
 * from `canonical-model.ts` rather than from a hand-written approximation, so a
 * suite asserting on the encoded client response is asserting on what the
 * production encoders really produce from real provider input.
 */
function defaultEvents(request: CanonicalRequest): readonly CanonicalEvent[] {
  const usage: UsageRecord = {
    input_tokens: 12,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    uncached_input_tokens: 12,
    output_tokens: 4,
    reasoning_tokens: 0,
    estimated_cost: 0,
  };
  const start: CanonicalEvent =
    request.source_surface === "responses"
      ? {
          type: "response_start",
          sequence_number: 0,
          response_id: "resp_test",
          model: request.model,
        }
      : {
          type: "message_start",
          sequence_number: 0,
          event_id: "msg_test",
          model: request.model,
        };
  const text: ContentPart = { kind: "text", text: "Hello from Cartethyia" };
  const terminal: CanonicalEvent = {
    type: "terminal",
    sequence_number: 2,
    state: "complete",
    stop_reason: "stop",
    usage,
  };
  const toolName = request.tools?.[0]?.name;
  if (request.tools !== undefined && request.tools.length > 0 && toolName !== undefined) {
    return [
      start,
      {
        type: "tool_call_delta",
        sequence_number: 1,
        call_id: "call_test_1",
        index: 0,
        name: toolName,
        arguments_delta: '{"location":"Jakarta"}',
      },
      { ...terminal, stop_reason: "tool_use" },
    ];
  }
  return [
    start,
    { type: "content_delta", sequence_number: 1, content: text },
    terminal,
  ];
}

/** Records what the stub adapter observed, so a suite can assert on dispatch. */
export interface DispatchRecord {
  readonly request: CanonicalRequest;
  readonly candidate: ProviderDispatchTarget;
  readonly context: ProviderDispatchContext;
}

export interface StubAdapterOptions {
  /** Replaces the default event sequence for every dispatch. */
  readonly events?: (request: CanonicalRequest) => readonly CanonicalEvent[];
  /** Throws instead of yielding, to exercise the failure/retry path. */
  readonly failWith?: (request: CanonicalRequest, attempt: number) => Error | undefined;
  /** Emits a non-streaming-style single response for `stream: false` requests. */
  readonly onDispatch?: (record: DispatchRecord) => void;
  /**
   * Makes the stub a search provider: `websearch` answers instead of throwing.
   * `failSearchWith` models a configured provider that cannot answer, so a
   * suite can observe fallback advancing to the next configured candidate.
   */
  readonly searchResults?: readonly WebSearchResult[];
  readonly failSearchWith?: (query: string, attempt: number) => Error | undefined;
  readonly onSearch?: (query: string) => void;
}

/** Builds a provider adapter backed by memory instead of a network socket. */
export function createStubAdapter(
  providerId: string,
  options: StubAdapterOptions = {},
): ProviderAdapter & { readonly dispatches: readonly DispatchRecord[]; readonly searches: readonly string[] } {
  const dispatches: DispatchRecord[] = [];
  const searches: string[] = [];
  let attempt = 0;
  let searchAttempt = 0;
  return {
    // A fixture id is not a bundled provider, so it is a custom slug by
    // construction. `parseProviderId` is the same normalizer the registry uses
    // when it registers a custom provider, so the fixture's id and the real
    // registration agree.
    provider_id: parseProviderId(providerId),
    dispatches,
    searches,
    async *dispatch(
      request: CanonicalRequest,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      attempt += 1;
      const record: DispatchRecord = { request, candidate, context };
      dispatches.push(record);
      options.onDispatch?.(record);
      const failure = options.failWith?.(request, attempt);
      if (failure) throw failure;
      const events = options.events?.(request) ?? defaultEvents(request);
      for (const event of events) {
        // Yield to the microtask queue between frames so an aborted request is
        // observed the way a real stream would observe it, without a timer.
        if (context.abort_signal.aborted) return;
        await Bun.sleep(0);
        yield event;
      }
    },
    ...(options.searchResults === undefined && options.failSearchWith === undefined
      ? {}
      : {
          async websearch(
            body: Record<string, unknown>,
            _candidate: ProviderDispatchTarget,
            _context: ProviderDispatchContext,
          ): Promise<WebSearchOutcome> {
            searchAttempt += 1;
            const query = typeof body.query === "string" ? body.query : "";
            searches.push(query);
            options.onSearch?.(query);
            const failure = options.failSearchWith?.(query, searchAttempt);
            if (failure) throw failure;
            const results = options.searchResults ?? [];
            return { results, total_results: results.length };
          },
        }),
  };
}

/**
 * The peer address the harness reports for every request.
 *
 * `app.handle()` invokes the router directly, so there is no socket and
 * `server.requestIP()` returns null — which the client-identity stage correctly
 * rejects as `admission_unavailable`. Reporting loopback is the honest
 * substitute: it is the address a local connection really has, and because
 * loopback is inside {@link TEST_TRUSTED_PROXY_BOUNDARY} a suite can still
 * drive a specific client IP through `x-forwarded-for`.
 */
const TEST_PEER_ADDRESS = "127.0.0.1";
/** Everything a suite needs to drive and inspect one gateway instance. */
export interface TestGateway {
  readonly app: App;
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
  readonly snapshotService: InMemoryRouteSnapshotService;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly adapters: Map<string, ReturnType<typeof createStubAdapter>>;
  readonly shutdownCoordinator: ShutdownCoordinator;
  /** Issues an HTTP request through the real router. */
  request(path: string, init?: RequestInit & { clientIp?: string }): Promise<Response>;
  /** Sends a JSON body with the bearer token a suite was issued. */
  json(
    path: string,
    body: unknown,
    init?: RequestInit & { clientIp?: string; token?: string },
  ): Promise<Response>;
  /** Replaces the routing snapshot; call after changing fixture rows. */
  setRoutes(routes: readonly TestRoute[]): void;
  /**
   * Serves every model a world created, on that world's provider and account.
   *
   * The common case for a suite that only cares about the request/response
   * contract: one provider, one account, several models. Calling this instead
   * of hand-writing a `setRoutes` list is what keeps a suite from silently
   * omitting a model it just created — the failure being a confusing 404 on a
   * row that really is in Postgres.
   */
  serveWorld(world: {
    readonly providerId: string;
    readonly accountId: string;
    readonly modelIds: readonly string[];
  }): void;
  /** Registers an adapter for a provider the suite is about to route to. */
  adapter(providerId: string, options?: StubAdapterOptions): ReturnType<typeof createStubAdapter>;
  close(): Promise<void>;
}

export interface TestGatewayOptions {
  /**
   * When `false`, `/console/api/*` is not mounted, which is the documented
   * Redis-less boot shape. Default `true` so console suites exercise the
   * deployed composition.
   */
  readonly console?: boolean;
  /** Overrides the readiness probe result. Default: always ready. */
  readonly readiness?: () => Promise<ReadinessCheckResult>;
  /** Caps request body bytes, for the ingress-limit suite. */
  readonly maxBodyBytes?: number;
  /** Per-request deadline in milliseconds. */
  readonly requestDeadlineMs?: number;
}

/**
 * Builds one gateway instance over the isolated test database.
 *
 * Each call gets its own state store, snapshot service, and telemetry buffer,
 * so two suites in one process cannot share a counter. The database pool is
 * shared (it is expensive), but every suite scopes its rows with `createRunId`.
 */
export async function createTestGateway(
  options: TestGatewayOptions = {},
): Promise<TestGateway> {
  const db = getDb();
  // Fail fast with a clear message when the test database is unreachable,
  // rather than surfacing a pool timeout from inside a test body.
  await getTestPool();

  const adapters = new Map<string, ReturnType<typeof createStubAdapter>>();
  const stateStore = new ProxyRequestStateStore(undefined);
  const telemetryBuffer = new TelemetryBatchBuffer(db, { flushIntervalMs: 50 });
  const shutdownCoordinator = new ShutdownCoordinator({}, { drainWindowMs: 0 });

  const routeSnapshot: { current: RouteSnapshot } = { current: emptySnapshot() };
  // The real snapshot service, over an in-memory catalog. Routing, alias
  // resolution, capability filtering, and admission all run for real; only the
  // catalog's origin is a fixture.
  const snapshotService = new InMemoryRouteSnapshotService(async () => routeSnapshot.current);
  const routingEngine = new RoutingEngine();
  const admissionService = new ApiKeyAdmissionService(new InMemoryAdmissionCounterStore());
  const proxyPreparer = new ProxyRequestPreparer({
    snapshotService,
    routingEngine,
    admissionService,
  });

  const ipAbuseProtection = new IpAbuseProtectionService(new InMemoryIpAbuseStore(), undefined, {
    // Effectively off by default: a suite that wants the limiter opts in by
    // constructing its own service. Leaving the production default (240/min)
    // would make a loop of requests trip the limiter and produce a confusing
    // 429 in an unrelated assertion.
    maxRequestsPerWindow: 1_000_000,
  });

  const networkBindingFactory = new ValidatedNetworkBindingFactory(
    // `allowPrivate` is on so a fixture hostname that resolves to a loopback or
    // private address is not rejected by the SSRF policy; the stub adapter
    // never opens a socket, so this relaxes nothing that is actually reached.
    { allowPrivate: true },
    // The stub adapter never fetches, so this is only reached if a code path
    // under test ignores the adapter — which is itself the finding. The cast is
    // the documented `typeof fetch` gap: the factory takes a real `fetch`
    // (including its `preconnect` static), while a test only ever supplies the
    // call signature. The thrown error is what makes a missed stub loud.
    (async () => {
      throw new Error("test gateway: outbound fetch is not stubbed for this path");
    }) as unknown as typeof fetch,
  );

  const app = createGatewayApp({
    mode: "production",
    db,
    proxyPreparer,
    resolveProviderAdapter: async (providerId) => adapters.get(providerId),
    providerAdapters: adapters as unknown as ReadonlyMap<string, ProviderAdapter>,
    // A fixture provider id (`tp-<runId>`) is by construction not bundled, so
    // the dispatch path treats it as a configurable upstream and requires an
    // SSRF-validated host before it will dispatch — it resolves the hostname
    // for real, which is why this must be a name that actually resolves rather
    // than a documentation-only `.test` domain. `localhost` resolves to
    // loopback, which the policy above permits, so the pre-dispatch validation
    // runs its real code path without touching the network.
    byokUpstreamHosts: { get: () => ({ hostname: "localhost", port: 443 }) },
    networkBindingFactory,
    ipAbuseProtection,
    trustedProxyBoundary: TEST_TRUSTED_PROXY_BOUNDARY,
    poolSelector: new NetworkPoolSelector(undefined),
    snapshotService,
    readiness:
      options.readiness ??
      (async () => ({
        status: "ready",
        db: "connected",
        migrations: "applied",
        redis: "connected",
      })),
    telemetryBuffer,
    resolveOAuthRefresher: async () => undefined,
    oauthRefreshService: {} as never,
    shutdownCoordinator,
    resolvePeerAddress: () => TEST_PEER_ADDRESS,
    ...(options.console === false
      ? {}
      : {
          consoleApi: {
            db,
            accessResolver: () => undefined,
            routeSnapshotService: snapshotService,
            poolSelector: new NetworkPoolSelector(undefined),
            telemetryBuffer,
            providerRegistry: createDefaultProviderRegistry(),
            bundledModelCatalog: { modelsByProvider: new Map() },
            networkBindingFactory,
            redis: undefined,
            oauthRefreshService: {} as never,
            admissionService,
          },
        }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.requestDeadlineMs === undefined
      ? {}
      : { requestDeadlineMs: options.requestDeadlineMs }),
  });

  const gateway: TestGateway = {
    app,
    db,
    stateStore,
    snapshotService,
    telemetryBuffer,
    adapters,
    shutdownCoordinator,
    async request(path, init = {}) {
      const { clientIp, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (clientIp !== undefined) headers.set("x-forwarded-for", clientIp);
      return app.handle(
        new Request(`http://cartethyia.test${path}`, { ...rest, headers }),
      );
    },
    async json(path, body, init = {}) {
      const { token, clientIp, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("content-type", "application/json");
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      if (clientIp !== undefined) headers.set("x-forwarded-for", clientIp);
      return app.handle(
        new Request(`http://cartethyia.test${path}`, {
          ...rest,
          method: rest.method ?? "POST",
          headers,
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
    },
    setRoutes(routes) {
      routeSnapshot.current = buildSnapshot(routes);
      // Drop the cached snapshot so the next request observes the new routes.
      void snapshotService.invalidate();
    },
    serveWorld(world) {
      gateway.setRoutes(
        world.modelIds.map((modelId) => ({
          providerId: world.providerId,
          modelId,
          accountId: world.accountId,
        })),
      );
    },
    adapter(providerId, adapterOptions = {}) {
      const adapter = createStubAdapter(providerId, adapterOptions);
      adapters.set(providerId, adapter);
      return adapter;
    },
    async close() {
      await telemetryBuffer.stop({ flush: false }).catch(() => undefined);
    },
  };
  return gateway;
}

/** An empty, valid snapshot: no candidates, so routing fails closed. */
function emptySnapshot(): RouteSnapshot {
  return {
    revision: 1,
    candidates: [],
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

/** Projects test routes onto the real `RouteSnapshot` shape. */
export function buildSnapshot(routes: readonly TestRoute[]): RouteSnapshot {
  const candidates: RouteCandidate[] = routes.map((route) => ({
    provider_id: route.providerId,
    model_id: route.modelId,
    wire_family: route.wireFamily ?? "chat",
    ...(route.serviceKind === undefined ? {} : { service_kind: route.serviceKind }),
    endpoint: route.endpoint ?? "/v1/chat/completions",
    capability_profile: route.capabilities ?? PERMISSIVE_CAPABILITIES,
    provider_account_id: route.accountId,
    ...(route.accountLabel === undefined ? {} : { provider_account_label: route.accountLabel }),
    ...(route.maxInflight === undefined ? {} : { max_inflight: route.maxInflight }),
    // The catalog attaches the health marker onto the candidate; the router's
    // `EligibilityEvaluator` reads it from there, so the fixture sets it there.
    ...(route.healthStatus === undefined ? {} : { health_status: route.healthStatus }),
    ...(route.cooldownKind === undefined ? {} : { cooldown_kind: route.cooldownKind }),
    tenant_id: null,
  }));
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}
