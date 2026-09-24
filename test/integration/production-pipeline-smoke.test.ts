import { describe, expect, test } from "bun:test";
import { createGatewayApp } from "../../src/app";
import type { ProductionAppDeps } from "../../src/app";
import { createConsoleApiStub } from "../helpers/console-api-stub";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import type { ReadinessCheckResult } from "../../src/persistence/readiness";
import type { TelemetryBatchBuffer } from "../../src/observability/telemetry-buffer";
import type {
  PreparedProxyRequest,
  ProxyRequestPreparer,
} from "../../src/transport/request/preparer";
import type { ProviderAdapter } from "../../src/providers/provider-registry";
import type { RouteCandidate, RoutePlan } from "../../src/transport/routing/route-model";
import type { RoutingEngine } from "../../src/transport/routing/router";
import type { ApiKeyAdmissionService } from "../../src/security/admission";
import type { ResolvedApiKey } from "../../src/security/api-key-auth";

/**
 * Production-pipeline smoke test.
 *
 * Proves the Phase-2 public HTTP composition root carries an authenticated
 * `/v1` request through the real middleware chain (ingress policy → client
 * identity → dependency readiness → API-key authentication → canonical
 * request → proxy-route preparation) and reaches provider dispatch
 * (`handleProviderProxyRequest`), which consults the injected provider-adapter
 * registry.
 *
 * The smoking gun is the dispatch-only sentinel: an unregistered provider
 * candidate surfaces `503 { error: { code: "admission_unavailable" } }` with
 * the message "provider adapter not registered". That message is thrown in
 * exactly one place — inside provider dispatch, after authentication,
 * canonical parsing, and proxy-route preparation have all succeeded.
 *
 * This test is hermetic: every dependency (`db`, `readiness`,
 * `telemetryBuffer`, `proxyPreparer`, `providerAdapters`, `resolvePeerAddress`)
 * is an in-process stub, so it needs no runtime fixtures (Postgres, Redis,
 * network) and requires no skip gate.
 */

interface ConfigurableProxyAdapter {
  readonly db: CartethyiaDatabase;
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly readinessSink: number[];
  readonly providerAdapters: Map<string, ProviderAdapter>;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly prepareSink: string[];
}

// A single permitted API-key row. `tenantId` stays empty so that
// `applyTenantPreferences` short-circuits (no tenant-preferences read) and
// `authorizeRoute`'s tenant-bound check still passes (`"" === ""`). Only the
// DB keys `resolveApiKeyAuthorization` reads are present.
const smokeApiKeyRow = {
  id: "smoke-key",
  tenantId: "",
  scopes: ["routing:invoke"] as const,
  revokedAt: null as Date | null,
};

function createStubs(): ConfigurableProxyAdapter {
  // Minimal drizzle-chain stub: `resolveApiKeyAuthorization` is the only DB
  // consumer on this path (`db.select().from(apiKeys).where(...).limit(1)`).
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: async () => [smokeApiKeyRow],
              };
            },
          };
        },
      };
    },
  } as unknown as CartethyiaDatabase;

  const readinessSink: number[] = [];
  const readiness = async (): Promise<ReadinessCheckResult> => {
    readinessSink.push(1);
    return {
      status: "ready",
      db: "connected",
      migrations: "applied",
      redis: "not_configured",
    };
  };

  // Required to mount the production pipeline (the composition root gates on
  // `deps.telemetryBuffer`). Its `afterResponse` drain is not observable
  // through `app.handle()` in this harness, so `enqueue` stays a no-op seam.
  const telemetryBuffer = {
    enqueue(_event: unknown): void {
      // Production writes a durable telemetry row here; the smoke test does not
      // need to assert this stage.
    },
  } as unknown as TelemetryBatchBuffer;

  // A well-formed candidate whose provider is deliberately absent from the
  // adapter registry, so provider dispatch fails exactly one step after the
  // midpoint the test is proving we reached. `requires_account: false` keeps
  // credential resolution and its DB read out of the path.
  const candidate: RouteCandidate = {
    provider_id: "smoke-unregistered-provider",
    model_id: "smoke-model",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    requires_account: false,
  };

  const plan: RoutePlan = {
    revision: 1,
    candidates: [candidate],
    requested_model: "smoke-model",
    resolved_model: "smoke-model",
    provider_id: "smoke-unregistered-provider",
  };

  // Never reached in this smoke test (adapter lookup throws first); guarded so
  // a future path change fails loudly instead of silently short-circuiting.
  const routingEngine = {
    async plan(): Promise<RoutePlan> {
      return plan;
    },
    async reserve(): Promise<never> {
      throw new Error("routing reserve reached before provider dispatch in smoke test");
    },
    async release(): Promise<void> {},
  } as unknown as RoutingEngine;

  const admissionService = {
    async admit(): Promise<never> {
      throw new Error("admission admit reached before provider dispatch in smoke test");
    },
  } as unknown as ApiKeyAdmissionService;

  const prepareSink: string[] = [];
  const proxyPreparer = {
    async prepare(input: {
      readonly canonicalRequest: CanonicalRequest;
      readonly authorization: ResolvedApiKey;
      readonly deadlineMs: number;
      readonly signal?: AbortSignal;
    }): Promise<PreparedProxyRequest> {
      prepareSink.push(input.canonicalRequest.model);
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

  return {
    db,
    readiness,
    telemetryBuffer,
    readinessSink,
    providerAdapters: new Map<string, ProviderAdapter>(),
    proxyPreparer,
    prepareSink,
  };
}

describe("production pipeline smoke", () => {
  test("carries an authenticated /v1 request through the real middleware chain into provider dispatch", async () => {
    const stubs = createStubs();
    const app = createGatewayApp({
      mode: "production",
      db: stubs.db,
      consoleApi: createConsoleApiStub(stubs.db),
      readiness: stubs.readiness,
      telemetryBuffer: stubs.telemetryBuffer,
      proxyPreparer: stubs.proxyPreparer,
      providerAdapters: stubs.providerAdapters,
      resolveProviderAdapter: async () => undefined,
      byokUpstreamHosts: new Map(),
      networkBindingFactory: {} as never,
      ipAbuseProtection: { checkBeforeAccess: async () => undefined } as never,
      trustedProxyBoundary: { mode: "disabled" },
      poolSelector: {} as never,
      snapshotService: {} as never,
      resolveOAuthRefresher: async () => undefined,
      oauthRefreshService: {} as never,
      resolvePeerAddress: () => "127.0.0.1",
    } as unknown as ProductionAppDeps);

    const response = await app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer smoke-token",
        },
        body: JSON.stringify({
          model: "smoke-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // Provider dispatch threw its unregistered-adapter sentinel — proof the
    // request survived readiness, authentication, canonical parse, and
    // proxy-route preparation.
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("admission_unavailable");
    expect(body.error.message).toContain("provider adapter not registered");

    // The real proxy-route preparation middleware ran once with the parsed
    // canonical model.
    expect(stubs.prepareSink).toEqual(["smoke-model"]);
    // Readiness gating ran ahead of the rest of the chain.
    expect(stubs.readinessSink.length).toBeGreaterThan(0);
  });
  test("blocks an unauthenticated /v1 request at API-key authentication, before provider dispatch", async () => {
    const stubs = createStubs();
    const app = createGatewayApp({
      mode: "production",
      db: stubs.db,
      consoleApi: createConsoleApiStub(stubs.db),
      readiness: stubs.readiness,
      telemetryBuffer: stubs.telemetryBuffer,
      proxyPreparer: stubs.proxyPreparer,
      providerAdapters: stubs.providerAdapters,
      resolveProviderAdapter: async () => undefined,
      byokUpstreamHosts: new Map(),
      ipAbuseProtection: { checkBeforeAccess: async () => undefined } as never,
      trustedProxyBoundary: { mode: "disabled" },
      resolveOAuthRefresher: async () => undefined,
      oauthRefreshService: {} as never,
      resolvePeerAddress: () => "127.0.0.1",
    } as unknown as ProductionAppDeps);

    const response = await app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "smoke-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    // Authentication rejects before canonical parse / preparation / dispatch.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("missing or malformed Authorization header");
    expect(stubs.prepareSink).toHaveLength(0);
  });
});