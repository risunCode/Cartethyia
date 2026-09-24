import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { getDb } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { apiKeys, tenants } from "../../../src/persistence/schema";
import { hashSecret } from "../../../src/security/crypto";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { GatewayError } from "../../../src/transport/gateway-error";
import { getInFlightCount, resetInFlightForTests } from "../../../src/transport/request/inflight";
import { getConsoleLogSnapshot, resetConsoleLogsForTests } from "../../../src/observability/log-ring";
import {
  readIngressBody,
  createApiKeyAuthenticationMiddleware,
  createConsoleMutationLimiterMiddleware,
  createErrorNormalizationMiddleware,
  createRequestContextMiddleware,
  registerTelemetryLifecycle,
} from "../../../src/transport/middleware/ingress";

describe("context.test.ts", () => {
  function requestWithBody(body: ReadableStream<Uint8Array>): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  describe("bounded ingress body reader", () => {
    test("reads chunked JSON once and preserves parsing semantics", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":"gpt-test",'));
          controller.enqueue(new TextEncoder().encode('"stream":false}'));
          controller.close();
        },
      });

      await expect(readIngressBody(requestWithBody(body))).resolves.toEqual({
        model: "gpt-test",
        stream: false,
      });
    });

    test("cancels as soon as a chunk exceeds the remaining limit", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"oversized":true}'));
        },
        cancel() {
          cancelled = true;
        },
      });

      await expect(readIngressBody(requestWithBody(body), { maxBodyBytes: 8 })).rejects.toMatchObject(
        {
          status: 413,
        },
      );
      expect(cancelled).toBe(true);
    });

    test("rejects overflow after earlier chunks without decoding the body", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(3));
        },
        cancel() {
          cancelled = true;
        },
      });

      await expect(readIngressBody(requestWithBody(body), { maxBodyBytes: 8 })).rejects.toMatchObject(
        {
          status: 413,
        },
      );
      expect(cancelled).toBe(true);
    });

    test("recognizes Responses compact as a JSON ingress route", async () => {
      const request = new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      await expect(readIngressBody(request)).rejects.toMatchObject({ status: 415 });
    });
  });
});

describe("createRequestContextMiddleware — /v1 scoping", () => {
  beforeEach(() => resetInFlightForTests());

  function buildContextApp(stateStore: ProxyRequestStateStore): Elysia {
    return new Elysia()
      .use(createRequestContextMiddleware({ stateStore }))
      .all("/*", () => ({ ok: true }));
  }

  test("initializes proxy state and counts one flight for /v1 routes", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = buildContextApp(stateStore);
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const response = await app.handle(req);
    expect(response.status).toBe(200);
    expect(stateStore.get(req)).toBeDefined();
    expect(getInFlightCount()).toBe(1);
  });

  test("skips proxy state for health, console, and static paths", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = buildContextApp(stateStore);
    for (const pathname of [
      "/health",
      "/metrics",
      "/console/api/usage/summary",
      "/console/usage",
      "/assets/app.js",
      "/",
    ]) {
      const req = new Request(`http://localhost${pathname}`);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
      expect(stateStore.get(req)).toBeUndefined();
    }
    expect(getInFlightCount()).toBe(0);
  });
});

dbDescribe("checks.test.ts", () => {
  /** Real end-to-end test of the `/v1/*` route-policy gate: builds an Elysia
   * app with the middleware installed, backed by real API-key rows in
   * Postgres, and drives requests through `app.handle()`. */
  function buildApp(stateStore: ProxyRequestStateStore): Elysia {
    const db = getDb();
    return new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .use(createApiKeyAuthenticationMiddleware({ db, stateStore }))
      .all("/*", () => ({ ok: true }));
  }

  function requestFor(pathname: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost${pathname}`, { headers });
  }

  describe("createApiKeyAuthenticationMiddleware — routing:invoke enforcement", () => {
    const cleanupTenantIds: string[] = [];

    afterEach(async () => {
      const db = getDb();
      for (const tenantId of cleanupTenantIds.splice(0)) {
        await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));
        await db.delete(tenants).where(eq(tenants.id, tenantId));
      }
    });

    async function createTenantWithKey(
      scopes: readonly string[],
    ): Promise<{ tenantId: string; token: string }> {
      const db = getDb();
      const [tenant] = await db
        .insert(tenants)
        .values({ name: `auth-mw-test-${crypto.randomUUID()}`, status: "active" })
        .returning();
      if (!tenant) throw new Error("failed to create test tenant");
      cleanupTenantIds.push(tenant.id);
      const token = `test-token-${crypto.randomUUID()}`;
      await db.insert(apiKeys).values({
        tenantId: tenant.id,
        keyHash: hashSecret(token),
        label: "auth middleware test key",
        scopes,
      });
      return { tenantId: tenant.id, token };
    }

    test("passes through non-/v1/ paths without requiring a credential", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/console/api/whatever");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
    });

    // The restructure (B8) removed the per-route pre-auth 404: the single
    // gateway policy authenticates every /v1/* request first, so an unmapped
    // path without a credential is rejected as 401, not 404.
    test("rejects an unmapped /v1/ route by authenticating first (401 without credential)", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/not-a-real-route");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects a /v1/ request with no credential as 401", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("does not bypass API-key authorization for Responses compact", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/responses/compact");
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects an unknown/revoked bearer token as 401", async () => {
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", {
        authorization: "Bearer definitely-not-a-real-key",
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(401);
    });

    test("rejects a valid key lacking routing:invoke scope as 403", async () => {
      const { token } = await createTenantWithKey(["dashboard:read"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", { authorization: `Bearer ${token}` });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(403);
    });

    test("admits a valid key with routing:invoke scope and populates state.authorization", async () => {
      const { tenantId, token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/chat/completions", { authorization: `Bearer ${token}` });
      const state = stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
      expect(state.authorization?.tenantId).toBe(tenantId);
      expect(state.authorization?.scopes).toContain("routing:invoke");
    });

    test("accepts credentials via x-api-key as an alternative to Authorization", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/messages", { "x-api-key": token });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(200);
    });

    test("rejects conflicting Authorization and x-api-key headers as 400", async () => {
      const { token } = await createTenantWithKey(["routing:invoke"]);
      const stateStore = new ProxyRequestStateStore();
      const app = buildApp(stateStore);
      const req = requestFor("/v1/messages", {
        authorization: `Bearer ${token}`,
        "x-api-key": token,
      });
      stateStore.initialize(req, Date.now(), 30_000);
      const response = await app.handle(req);
      expect(response.status).toBe(400);
    });
  });
});

describe("security header middleware", () => {
  test("normalized error responses carry CSP and clickjacking headers", async () => {
    const stateStore = new ProxyRequestStateStore();
    const app = new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore }))
      .get("/boom", () => {
        throw new Error("boom");
      });
    const response = await app.handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("retry-after emission on normalized errors", () => {
  function appWith(error: unknown) {
    return new Elysia()
      .use(createErrorNormalizationMiddleware({ stateStore: new ProxyRequestStateStore() }))
      .get("/boom", () => {
        throw error;
      });
  }

  test("publishes the upstream's own wait hint, not only on a literal 429", async () => {
    // A 503 `admission_unavailable` is retryable and can carry a measured wait;
    // the client used to receive no `retry-after` at all because the header was
    // gated on status === 429.
    const response = await appWith(
      new GatewayError("admission_unavailable", 503, "store unreachable", { retryAfterMs: 2500 }),
    ).handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
  });

  test("converts an absolute retryAt into whole seconds", async () => {
    const retryAt = new Date(Date.now() + 7000).toISOString();
    const response = await appWith(
      new GatewayError("proxy_pool_capacity_exceeded", 429, "at capacity", { retryAt }),
    ).handle(new Request("http://localhost/boom"));
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(6);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(7);
  });

  test("keeps the one-second floor for a 429 with no measured evidence", async () => {
    const response = await appWith(
      new GatewayError("quota_exceeded", 429, "slow down"),
    ).handle(new Request("http://localhost/boom"));
    expect(response.headers.get("retry-after")).toBe("1");
  });

  test("invents no header for a failure that carries no wait evidence", async () => {
    // A fabricated backoff is worse than none: the client would wait for a
    // number nobody measured.
    const response = await appWith(
      new GatewayError("platform_unavailable", 502, "upstream broke"),
    ).handle(new Request("http://localhost/boom"));
    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

describe("console mutation limiter middleware", () => {
  function app() {
    return new Elysia()
      .use(createConsoleMutationLimiterMiddleware())
      .use(createErrorNormalizationMiddleware({ stateStore: new ProxyRequestStateStore() }))
      .post("/console/api/providers", () => ({ ok: true }))
      .get("/console/api/providers", () => ({ ok: true }));
  }

  function authed(method: string, session: string): Request {
    return new Request("http://localhost/console/api/providers", {
      method,
      headers: { cookie: `session_token=${session}` },
    });
  }

  test("allows a burst of 30 mutations then 429s with retry-after", async () => {
    const session = `limiter-test-${crypto.randomUUID()}`;
    const a = app();
    for (let i = 0; i < 240; i++) {
      const response = await a.handle(authed("POST", session));
      expect(response.status).toBe(200);
    }
    const limited = await a.handle(authed("POST", session));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
  });

  test("tracks sessions independently and ignores safe methods", async () => {
    const a = app();
    const other = `limiter-other-${crypto.randomUUID()}`;
    for (let i = 0; i < 240; i++) {
      await a.handle(authed("POST", other));
    }
    // A different session still has budget.
    const fresh = `limiter-fresh-${crypto.randomUUID()}`;
    expect((await a.handle(authed("POST", fresh))).status).toBe(200);
    // Safe methods never consume budget.
    for (let i = 0; i < 6; i++) {
      expect((await a.handle(authed("GET", other))).status).toBe(200);
    }
    expect((await a.handle(authed("POST", other))).status).toBe(429);
  });

  test("mutations without a session pass through to downstream auth", async () => {
    const a = app();
    for (let i = 0; i < 6; i++) {
      const response = await a.handle(
        new Request("http://localhost/console/api/providers", { method: "POST" }),
      );
      expect(response.status).toBe(200);
    }
  });
});

describe("registerTelemetryLifecycle — in-flight release", () => {
  beforeEach(() => resetInFlightForTests());

  function captureHook(deps: {
    readonly stateStore: ProxyRequestStateStore;
    readonly enqueued: { count: number };
  }): (context: { request: Request }) => Promise<void> {
    let captured: ((context: { request: Request }) => Promise<void>) | undefined;
    const fakeApp = {
      afterResponse(handler: (context: { request: Request }) => Promise<void>) {
        captured = handler;
        return fakeApp;
      },
    };
    registerTelemetryLifecycle(fakeApp as never, {
      stateStore: deps.stateStore,
      telemetryBuffer: {
        enqueue: () => {
          deps.enqueued.count += 1;
        },
      } as never,
    });
    if (!captured) throw new Error("telemetry lifecycle hook was not registered");
    return captured;
  }

  function authorizedState(
    stateStore: ProxyRequestStateStore,
    request: Request,
  ): void {
    const state = stateStore.require(request);
    state.authorization = {
      id: "key",
      tenantId: "tenant",
      scopes: [],
      snapshot: { api_key_id: "key", tenant_id: "tenant" },
    } as never;
  }

  test("a completed non-stream request releases its flight without a second telemetry row", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    // Terminal non-stream attempt: telemetry already finalized inside
    // completeAttempt, exactly like production dispatch.
    state.outcome = { status: "completed" };
    state.completed = true;
    expect(getInFlightCount()).toBe(1);
    await hook({ request: req });
    // The flight is gone (no leak) and no duplicate telemetry row was queued.
    expect(getInFlightCount()).toBe(0);
    expect(enqueued.count).toBe(0);
    expect(stateStore.get(req)).toBeUndefined();
  });

  test("an early rejection finalizes telemetry and releases its flight", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    await hook({ request: req });
    expect(enqueued.count).toBe(1);
    expect(getInFlightCount()).toBe(0);
  });

  test("a live stream is left untouched for stream-end finalization", async () => {
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    state.streaming = true;
    await hook({ request: req });
    // Still hanging by design: the stream owns this flight until it
    // terminates; touching it here would abort the live stream.
    expect(getInFlightCount()).toBe(1);
    expect(enqueued.count).toBe(0);
    state.cleanup();
  });

  test("a non-dispatching /v1 discovery route emits neither telemetry nor a lifecycle event", async () => {
    resetConsoleLogsForTests();
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/models", { method: "GET" });
    stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    await hook({ request: req });
    // `/v1/models` never dispatches upstream, so it is not a proxy request:
    // no phantom failed row and no request lifecycle event.
    expect(enqueued.count).toBe(0);
    expect(getConsoleLogSnapshot().filter((line) => line.event !== undefined)).toHaveLength(0);
    expect(getInFlightCount()).toBe(0);
  });

  test("an early rejection records the client's real HTTP status, not a generic 500", async () => {
    resetConsoleLogsForTests();
    const stateStore = new ProxyRequestStateStore();
    const enqueued = { count: 0 };
    const hook = captureHook({ stateStore, enqueued });
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(req, Date.now(), 30_000);
    authorizedState(stateStore, req);
    // What the error-normalization middleware records for a 400 rejection.
    state.outcome = { status: "failed", errorCategory: "invalid_request", httpStatus: 400 };
    await hook({ request: req });
    expect(getConsoleLogSnapshot().at(-1)).toMatchObject({
      event: "request_error",
      status: 400,
      errorCode: "invalid_request",
    });
  });
});
