/**
 * The authentication boundary on `/v1/*`.
 *
 * Every request that reaches a proxy route passes
 * `createApiKeyAuthenticationMiddleware` before routing, so this suite owns the
 * gateway's outer trust decision. It is a database suite on purpose: the
 * lookup, the hash, the scope check, and the client-router denylist all read
 * real rows, and a stub would have replaced exactly the code whose SQL can be
 * wrong.
 *
 * The cases below are the ones that decide whether an unauthenticated caller
 * can reach an upstream. They are grouped by what they protect: credential
 * extraction, lookup and revocation, scope and tenant binding, the client
 * router denylist, and the order the checks run in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe, getTestPool } from "../helpers/database";
import { invalidateApiKeyCache } from "../../src/security/api-key-auth";

/** Body every chat request in this suite sends. */
const CHAT_BODY = {
  model: "placeholder",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
};

dbDescribe("gateway authentication", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: world.accountId },
    ]);
    gateway.adapter(world.providerId);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  const chat = (init: RequestInit & { token?: string; clientIp?: string } = {}) =>
    gateway.json("/v1/chat/completions", { ...CHAT_BODY, model: world.qualifiedModel }, init);

  describe("credential extraction", () => {
    test("a missing Authorization header is refused as a 401", async () => {
      const response = await chat();
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });

    test("a malformed Authorization header never reaches the key lookup", async () => {
      const response = await chat({ headers: { authorization: "Token abc" } });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { message: string } };
      // The message names the header, not the credential: a caller learns its
      // request was malformed without learning whether the token exists.
      expect(body.error.message).toContain("Authorization");
    });

    test("an empty bearer value is refused rather than treated as anonymous", async () => {
      const response = await chat({ headers: { authorization: "Bearer " } });
      expect(response.status).toBe(401);
    });

    test("two different credentials in one request are a conflict, not a choice", async () => {
      // Accepting whichever header came first would silently decide the
      // request's identity, so the pair is rejected.
      const response = await chat({
        headers: {
          authorization: `Bearer ${world.token}`,
          "x-api-key": "rk_test_different_credential",
        },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain("conflicting");
    });

    test("the same credential in both headers is accepted as a compatibility idiom", async () => {
      // An Anthropic-compatible client sends both headers with one key; the
      // gateway must read either without refusing the pair.
      const response = await chat({
        headers: { authorization: `Bearer ${world.token}`, "x-api-key": world.token },
      });
      expect(response.status).toBe(200);
    });

    test("x-api-key alone authenticates", async () => {
      const response = await chat({ headers: { "x-api-key": world.token } });
      expect(response.status).toBe(200);
    });

    test("bearer matching is case-insensitive and tolerates extra spacing", async () => {
      const response = await chat({ headers: { authorization: `bEaReR   ${world.token}` } });
      expect(response.status).toBe(200);
    });

    test("a bearer token containing whitespace is malformed, not truncated", async () => {
      // Truncating at the space would authenticate as a *prefix* of the key,
      // which is a different credential than the caller sent.
      const response = await chat({ headers: { authorization: `Bearer ${world.token} extra` } });
      expect(response.status).toBe(401);
    });
  });

  describe("lookup and revocation", () => {
    test("an unknown token is refused without disclosing that it is unknown", async () => {
      const response = await chat({ token: "rk_test_never_issued" });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { message: string } };
      // "invalid or revoked" is deliberately one message: distinguishing them
      // would let a caller confirm a guessed token once existed.
      expect(body.error.message).toContain("invalid or revoked");
    });

    test("a key deleted after it authenticated is refused on the next request", async () => {
      // Proves the auth cache cannot outlive the row: the second request must
      // re-resolve, not answer from the memoized decision the first one wrote.
      const key = await world.createKey();
      expect((await chat({ token: key.token })).status).toBe(200);
      const pool = await getTestPool();
      await pool.query("delete from api_keys where id = $1", [key.id]);
      invalidateApiKeyCache(key.id);
      expect((await chat({ token: key.token })).status).toBe(401);
    });
    test("a disabled key is refused without revoking or deleting it", async () => {
      const key = await world.createKey();
      expect((await chat({ token: key.token })).status).toBe(200);
      const pool = await getTestPool();
      await pool.query("update api_keys set enabled = false where id = $1", [key.id]);
      invalidateApiKeyCache(key.id);
      expect((await chat({ token: key.token })).status).toBe(401);
    });
  });

  describe("scope enforcement", () => {
    test("a key without routing:invoke is refused with 403", async () => {
      const limited = await world.createKey({ scopes: ["dashboard:read"] });
      const response = await chat({ token: limited.token });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain("routing:invoke");
    });

    test("routing:invoke alone is sufficient", async () => {
      const minimal = await world.createKey({ scopes: ["routing:invoke"] });
      expect((await chat({ token: minimal.token })).status).toBe(200);
    });

    test("an empty scope list on a tenant key defaults to routing:invoke", async () => {
      // `createAccessDecision` grants `routing:invoke` when a tenant-owned key
      // carries no scopes, so an empty list is not a lockout. The console never
      // writes one (`validateApiKeyRequest` defaults to the same single scope),
      // which is what makes this a backstop rather than the normal path — and
      // why the assertion pins the documented behavior rather than an
      // accident of the fixture.
      const empty = await world.createKey({ scopes: [] });
      expect((await chat({ token: empty.token })).status).toBe(200);
    });

    test("platform:admin alongside routing:invoke changes nothing on a proxy route", async () => {
      const elevated = await world.createKey({
        scopes: ["routing:invoke", "platform:admin"],
      });
      expect((await chat({ token: elevated.token })).status).toBe(200);
    });
  });

  describe("client-router denylist", () => {
    // The detector's only registered fingerprint is 9Router/OmniRoute, matched
    // on its own headers and on a User-Agent naming it. These cases use that
    // real signal rather than an invented client name, so the suite proves the
    // denylist path rather than the fixture's spelling.
    const NINE_ROUTER_HEADERS = { "x-msh-platform": "9router" };

    test("a denied client router is refused before a route is planned", async () => {
      const denied = await world.createKey({ clientRouterDenylist: ["9router"] });
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: world.qualifiedModel },
        { token: denied.token, headers: NINE_ROUTER_HEADERS },
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("client_router_denied");
    });

    test("a key with no denylist accepts the same client", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: world.qualifiedModel },
        { token: world.token, headers: NINE_ROUTER_HEADERS },
      );
      expect(response.status).toBe(200);
    });

    test("a denylist naming a different router does not block this one", async () => {
      // An entry that resolves to no known router is ignored, not treated as a
      // match: a typo must not refuse traffic.
      const other = await world.createKey({ clientRouterDenylist: ["some-other-router"] });
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: world.qualifiedModel },
        { token: other.token, headers: NINE_ROUTER_HEADERS },
      );
      expect(response.status).toBe(200);
    });

    test("the pre-merge id still matches after the rename", async () => {
      // `omniroute` folded into `9router`; a denylist persisted before that
      // rename must keep refusing the same client instead of silently lapsing.
      const legacy = await world.createKey({ clientRouterDenylist: ["omniroute"] });
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: world.qualifiedModel },
        { token: legacy.token, headers: NINE_ROUTER_HEADERS },
      );
      expect(response.status).toBe(403);
    });

    test("an unrecognised client is not matched by a denylist", async () => {
      const denied = await world.createKey({ clientRouterDenylist: ["9router"] });
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: world.qualifiedModel },
        { token: denied.token, headers: { "user-agent": "curl/8.0.0" } },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("order of checks", () => {
    test("an unauthenticated request to an unknown model fails on auth, not the model", async () => {
      // The error must describe the first check that failed. Returning
      // `model_not_found` here would tell an unauthenticated caller which
      // models exist.
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: "definitely-not-a-model" },
        {},
      );
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });

    test("an authenticated request to an unknown model fails on the model", async () => {
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: "definitely-not-a-model" },
        { token: world.token },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("model_not_found");
    });

    test("a denied client router is refused before the model is resolved", async () => {
      // Same reasoning: a 404 here would leak model existence to a client the
      // key has already refused.
      const denied = await world.createKey({ clientRouterDenylist: ["9router"] });
      const response = await gateway.json(
        "/v1/chat/completions",
        { ...CHAT_BODY, model: "definitely-not-a-model" },
        { token: denied.token, headers: { "x-msh-platform": "9router" } },
      );
      expect(response.status).toBe(403);
    });
  });
});

dbDescribe("gateway authentication — route coverage", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: world.accountId },
    ]);
    gateway.adapter(world.providerId);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  // Every proxy route shares one authentication stage, so a route that skipped
  // it would be an unauthenticated hole. Asserting each path is cheap and is
  // what proves the stage is mounted on the gateway plugin rather than on a
  // single route.
  const POST_ROUTES = [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/completions",
    "/v1/responses/compact",
    "/v1/systemone",
    "/v1/search",
  ] as const;

  for (const path of POST_ROUTES) {
    test(`${path} refuses a request with no credential`, async () => {
      const response = await gateway.json(path, { model: "x", messages: [] });
      expect(response.status).toBe(401);
    });
  }

  const GET_ROUTES = ["/v1/models", "/v1/models/info", "/v1/models/some-model"] as const;

  for (const path of GET_ROUTES) {
    test(`${path} refuses a request with no credential`, async () => {
      const response = await gateway.request(path);
      expect(response.status).toBe(401);
    });
  }

  test("an unregistered /v1 path answers 404 rather than reaching the SPA", async () => {
    // Measured behavior: a `/v1/*` path matching no route is answered by the
    // root fallback's reserved-namespace branch with a JSON `not_found`
    // envelope, so an unknown API path can never be answered with the dashboard
    // document. The IP-abuse counter still runs for it (it is mounted on the
    // root `request` hook, which fires regardless of whether a route matched) —
    // that is asserted in the abuse suite, where the limiter is configured low
    // enough to observe it.
    const response = await gateway.json("/v1/not-a-route", {});
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("an unknown /v1 path is answered as JSON, never as the dashboard document", async () => {
    const response = await gateway.request("/v1/nope");
    const text = await response.text();
    expect(text).not.toContain("<div id=\"root\">");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
