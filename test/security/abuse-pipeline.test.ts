import { describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { GatewayError } from "../../src/transport/gateway-error";
import {
  InMemoryIpAbuseStore,
  IpAbuseProtectionService,
  type ClientIdentity,
} from "../../src/security/abuse";
import { buildPipelineHarness } from "../helpers/pipeline-harness";

/**
 * A request that fails authentication still consumed ingress capacity, so it
 * must count toward the per-IP ceiling and must be able to reach the ban
 * threshold. The failure mode this guards against is the opposite one: an
 * error type that returns early *before* the counter is touched, which lets a
 * caller hammer the gateway with revoked or malformed credentials forever
 * without ever escalating — the exact traffic pattern the abuse layer exists
 * to stop.
 *
 * The counter runs in `createIpAbuseProtectionMiddleware`, which the pipeline
 * mounts before `createApiKeyAuthenticationMiddleware`, so these assert the
 * production middleware order rather than the service in isolation.
 */
function identity(address: string): ClientIdentity {
  return { address, source: "tcp-peer" };
}

const route = "/v1/chat/completions";

/** A DB stub whose API-key lookup finds nothing — a revoked or unknown key. */
function createRevokedKeyDb(): CartethyiaDatabase {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return { limit: async () => [] };
            },
          };
        },
      };
    },
  } as unknown as CartethyiaDatabase;
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(`http://cartethyia.test${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
}

describe("failed requests still count toward the abuse ceiling", () => {
  test("a revoked or unknown API key is counted and can be banned", async () => {
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 2,
      banThreshold: 4,
      banDurationMs: 60_000,
    });
    const { app } = buildPipelineHarness({
      ipAbuseProtection: svc,
      db: createRevokedKeyDb(),
    });

    // An unknown bearer token: `resolveApiKeyAuthorization` returns undefined
    // and auth rejects with 401 `invalid_request`.
    const request = () => post({ authorization: "Bearer revoked-key" });

    const first = await app.handle(request());
    expect(first.status).toBe(401);
    const second = await app.handle(request());
    expect(second.status).toBe(401);

    // Both failures were counted, so the next one is over the ceiling.
    const third = await app.handle(request());
    expect(third.status).toBe(429);

    // And the caller keeps failing, the count keeps rising to the threshold.
    const fourth = await app.handle(request());
    expect(fourth.status).toBe(429);
    expect(await store.isBanned("127.0.0.1", Date.now())).toBe(true);

    // Once banned, every later attempt is rejected as banned — not as a 401.
    const afterBan = await app.handle(request());
    expect(afterBan.status).toBe(429);
    const payload = (await afterBan.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("ip banned");
  });

  test("a request with no credentials at all is counted too", async () => {
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 1,
      banThreshold: 100,
      banDurationMs: 60_000,
    });
    const { app } = buildPipelineHarness({
      ipAbuseProtection: svc,
      db: createRevokedKeyDb(),
    });

    // No Authorization and no x-api-key: `requestToken` rejects before any
    // lookup, so this is a different error type from the revoked-key case.
    const response = await app.handle(post());
    expect(response.status).toBeGreaterThanOrEqual(400);

    // The attempt is in the window, so the very next one is over the ceiling.
    const second = await app.handle(post());
    expect(second.status).toBe(429);
  });

  test("a request to an unregistered /v1 path is still counted", async () => {
    // The regression this pins: the counter ran as a gateway plugin
    // `beforeHandle`, which only fires for a request that matches a registered
    // route. Addressing a path that does not exist — or a real path with the
    // wrong method — skipped the counter entirely, so a caller could hammer
    // the gateway forever without ever being counted. Measured before the fix:
    // 300 attempts rotating unregistered paths produced zero 429s.
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 5,
      banThreshold: 1_000,
      banDurationMs: 60_000,
    });
    const { app } = buildPipelineHarness({
      ipAbuseProtection: svc,
      db: createRevokedKeyDb(),
    });

    for (const path of ["/v1/chat/completions", "/v1/nonexistent", "/v1/models"]) {
      await app.handle(
        new Request(`http://cartethyia.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer x" },
          body: JSON.stringify({ model: "m", messages: [] }),
        }),
      );
      expect(await store.getCount("127.0.0.1", path, Date.now())).toBe(1);
    }
  });

  test("rotating the path cannot dodge the ban", async () => {
    // The second regression: escalation was read from the per-route window, so
    // spreading the same volume across many paths kept every individual count
    // below the threshold and no ban ever landed. Escalation is now counted per
    // identity, across every route, while admission stays per route.
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 2,
      banThreshold: 5,
      banDurationMs: 60_000,
    });
    const { app } = buildPipelineHarness({
      ipAbuseProtection: svc,
      db: createRevokedKeyDb(),
    });

    let sawBan = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await app.handle(
        new Request(`http://cartethyia.test/v1/rotating-${i}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer x" },
          body: JSON.stringify({ model: "m", messages: [] }),
        }),
      );
      if (response.status === 429) sawBan = true;
    }
    expect(sawBan).toBe(true);
    expect(await store.isBanned("127.0.0.1", Date.now())).toBe(true);
  });

  test("per-route admission budgets stay independent", async () => {
    // The property the fix must not break: exhausting one route's window does
    // not spend another route's, so a busy chat stream cannot take away a
    // client's ability to call the models list.
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 1,
      banThreshold: 10_000,
      banDurationMs: 60_000,
    });
    const { app } = buildPipelineHarness({
      ipAbuseProtection: svc,
      db: createRevokedKeyDb(),
    });

    const call = (path: string) =>
      app.handle(
        new Request(`http://cartethyia.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer x" },
          body: JSON.stringify({ model: "m", messages: [] }),
        }),
      );

    // The first call on each route is admitted; only the repeat is over limit.
    expect((await call("/v1/chat/completions")).status).not.toBe(429);
    expect((await call("/v1/chat/completions")).status).toBe(429);
    expect((await call("/v1/messages")).status).not.toBe(429);
  });

  test("the ban is per identity, so a second IP is unaffected", async () => {
    const store = new InMemoryIpAbuseStore(60_000);
    const svc = new IpAbuseProtectionService(store, () => Date.now(), {
      maxRequestsPerWindow: 1,
      banThreshold: 2,
      banDurationMs: 60_000,
    });
    // Two fixed identities, so the assertion does not depend on how the
    // harness resolves a peer address for one client.
    await expect(
      svc.checkBeforeAccess({ identity: identity("10.0.0.1"), route }),
    ).resolves.toBeUndefined();
    await expect(
      svc.checkBeforeAccess({ identity: identity("10.0.0.1"), route }),
    ).rejects.toBeInstanceOf(GatewayError);
    expect(await store.isBanned("10.0.0.1", Date.now())).toBe(true);
    expect(await store.isBanned("10.0.0.2", Date.now())).toBe(false);
    await expect(
      svc.checkBeforeAccess({ identity: identity("10.0.0.2"), route }),
    ).resolves.toBeUndefined();
  });
});

