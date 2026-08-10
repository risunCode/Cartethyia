// Set isolation env BEFORE any runtime imports are evaluated. When
// NODE_ENV is unset, getPersistenceEnv() defaults DATA_DIR to ./data and
// opens a pre-existing production database — which would seed settings and
// API keys that contaminate the test contracts. These must be in module
// scope (top-level) so they are set before createCartethyiaRuntime() runs.
process.env.NODE_ENV = "test";
process.env.CARTETHYIA_REQUEST_LOGS = "0";
const _dataDir = mkdtempSync(join(tmpdir(), "cartethyia-gateway-"));
process.env.DATA_DIR = _dataDir;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCartethyiaRuntime, type CartethyiaRuntime } from "../../src/bootstrap/composition";
import { lookupProxyEndpoint } from "../../src/open-sse/translate";
import { isRouteAllowed } from "../../src/security/access";
import { activePerIpFlights } from "../../src/traffic/per-ip";
import { SlidingWindowRateLimiter } from "../../src/traffic/rate-limiter";
import { runtimeMemoryLimits } from "../../src/traffic/limits";
import { resetInFlightForTests } from "../../src/traffic/in-flight";
import { createConsoleCsrfToken, signSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from "../../src/console/session";
import { safeConsoleHandle } from "../../src/middleware/console";
import { aclFor, buildCatalog, readProxyBody, requestToken } from "../../src/middleware/proxy";
import { errorResponse, recordAccessLog } from "../../src/middleware/shared";
import { translateLegacyGet } from "../../src/middleware/query";
import type { ApiKeyCreateInput } from "../../src/storage";

// ───────────────────────────── Test harness ─────────────────────────────

/**
 * A local middleware boundary test server that mirrors src/middleware/server.ts main()
 * routing for paths under contract. Uses a real CartethyiaRuntime with
 * in-memory SQLite (tmpdir DATA_DIR) — no external providers, no network.
 */
interface TestServer {
  readonly url: string;
  readonly server: Bun.Server<undefined>;
  readonly runtime: CartethyiaRuntime;
  dispose(): void;
}


let runtime: CartethyiaRuntime;
let testServer: TestServer;
const PUBLIC_V1_HEALTH_BODY = [
  "          .     .",
  "       .  /|\\ . /|\\  .",
  "        \\-***-/-***-/",
  "       .-'  .---.  '-.",
  "      /    / o o \\    \\",
  "     ;    |   ^   |    ;",
  "     |     \\ '-' /     |",
  "     ;      '---'      ;",
  "      \\    CARTETHYIA /",
  "       '.           .'",
  "         '-._____.-'",
  "          IS SERVING",
  "",
  "Endpoints:",
  "POST /v1/chat/completions",
  "POST /v1/responses",
  "POST /v1/messages",
  "POST /v1/images/generations",
  "POST /v1/images/edits",
  "QUERY /v1/models",
].join("\n");

function startTestServer(rt: CartethyiaRuntime, port = 0): TestServer {
  const rateLimiter = new SlidingWindowRateLimiter(runtimeMemoryLimits.rateLimitMaxRequests, runtimeMemoryLimits.rateLimitWindowMs);
  let globalInFlight = 0;
  const MAX_GLOBAL_IN_FLIGHT = 500;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request: Request): Promise<Response> {
      request = translateLegacyGet(request);
      const url = new URL(request.url);
      if (url.pathname.length > 2048) return errorResponse(414, "uri_too_long", "URI too long");
      if (url.pathname === "/health" && request.method === "GET") {
        return new Response(`${PUBLIC_V1_HEALTH_BODY}\n`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/") {
        return Response.redirect(new URL("/console/login", request.url).toString(), 302);
      }
      if (url.pathname === "/v1/models" && request.method === "QUERY") {
        const token = requestToken(request);
        const key = token === null ? null : rt.config.apiKeys.getBySecret(token);
        if (key === null) return errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.");
        const acl = aclFor(key);
        const entries = await buildCatalog(rt);
        const data = entries
          .filter((entry) => isRouteAllowed(entry.owned_by, entry.id, acl))
          .map((entry) => ({ id: entry.id, object: "model" as const, owned_by: entry.owned_by, metadata: entry.metadata }));
        return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store", "accept-query": "application/json" } });
      }
      const route = lookupProxyEndpoint(url.pathname);
      if (route === null || request.method !== "POST") {
        return errorResponse(404, "not_found", "Route not found");
      }
      const requestId = crypto.randomUUID();
      const startedAt = performance.now();
      const token = requestToken(request);
      const key = token === null ? null : rt.config.apiKeys.getBySecret(token);
      if (key === null) {
        const response = errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.", requestId);
        recordAccessLog(rt, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      if (globalInFlight >= MAX_GLOBAL_IN_FLIGHT) {
        const response = errorResponse(429, "rate_limit_error", "Server is at capacity. Try again shortly.", requestId);
        response.headers.set("retry-after", "5");
        recordAccessLog(rt, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      globalInFlight++;
      const parsedBody = await readProxyBody(request, route.endpoint);
      if (parsedBody instanceof Response) {
        globalInFlight--;
        recordAccessLog(rt, url.pathname, request, requestId, parsedBody.status, startedAt);
        return parsedBody;
      }
      // Without real provider accounts the proxy can't execute; return the
      // body-parse success boundary only — the proxy-execution path needs
      // provider credentials and is out of scope for contract tests.
      globalInFlight--;
      return errorResponse(503, "provider_unavailable", "No provider accounts are configured for this endpoint.", requestId);
    },
  });

  let disposed = false;
  return {
    url: server.url.href.replace(/\/$/, ""),
    server,
    runtime: rt,
    dispose(): void {
      disposed = true;
      server.stop(true);
      resetInFlightForTests();
      activePerIpFlights.clear();
    },
  };
}

function createApiKey(name: string, opts: Partial<ApiKeyCreateInput> = {}): string {
  const secret = `ck-${crypto.randomUUID().replaceAll("-", "")}`;
  runtime.config.apiKeys.create({
    id: crypto.randomUUID(),
    name,
    key: secret,
    keyPrefix: secret.slice(0, 10),
    ...opts,
  });
  return secret;
}

async function fetchGateway(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${testServer.url}${path}`, init);
}
async function fetchGatewayQuery(path: string, init: RequestInit = {}): Promise<Response> {
  return fetchGateway(path, {
    ...init,
    method: "QUERY",
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: init.body ?? "{}",
  });
}

function consoleRequest(path: string, init?: RequestInit): Request {
  return new Request(`${testServer.url}${path}`, init);
}

async function fetchConsole(path: string, init?: RequestInit): Promise<Response> {
  return safeConsoleHandle(runtime, translateLegacyGet(consoleRequest(path, init)));
}
async function fetchConsoleQuery(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetchConsole(path, {
    method: "QUERY",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}
type JsonObject = Record<string, unknown> & { error: Record<string, unknown> };
async function jsonObject(response: Response): Promise<JsonObject> {
  const value: unknown = await response.json();
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : { error: {} };
}

function withOrigin(init: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      origin: testServer.url,
      host: new URL(testServer.url).host,
    },
  };
}

// ───────────────────────────── Setup / teardown ─────────────────────────────

beforeAll(async () => {
  runtime = await createCartethyiaRuntime();
  testServer = startTestServer(runtime);
  // Initialize settings so safeConsoleHandle's pre-check guard runs
  // consistently (settings.get() !== null) across all console tests.
  runtime.config.settings.ensure();
  runtime.config.settings.rotateJwtSecret(crypto.randomUUID());
  runtime.config.settings.setPasswordHash(await Bun.password.hash("test-pass-123", { algorithm: "argon2id" }));
});


afterAll(() => {
  testServer?.dispose();
  runtime?.close();
  try { rmSync(_dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});




// ───────────────────────────── Health & root ─────────────────────────────

describe("gateway: /health", () => {
  test("GET /health returns the public v1 endpoint listing", async () => {
    const res = await fetchGateway("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(`${PUBLIC_V1_HEALTH_BODY}\n`);
  });

  test("POST /health returns 404 (only GET is handled)", async () => {
    const res = await fetchGateway("/health", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("not_found");
  });
});

describe("gateway: / (root)", () => {
  test("GET / redirects to /console/login with 302", async () => {
    const res = await fetchGateway("/", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(location).toContain("/console/login");
  });
});

// ───────────────────────────── /v1/models auth ─────────────────────────────

describe("gateway: /v1/models authentication", () => {
  test("missing API key returns 401 authentication_failed", async () => {
    const res = await fetchGatewayQuery("/v1/models");
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.type).toBe("error");
    expect(body.error.code).toBe("authentication_failed");
    expect(body.error.request_id).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("invalid API key returns 401", async () => {
    const res = await fetchGatewayQuery("/v1/models", {
      headers: { "x-api-key": "ck-nonexistent" },
    });
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
  });

  test("valid x-api-key returns 200 with list envelope", async () => {
    const key = createApiKey("models-list-key");
    const res = await fetchGatewayQuery("/v1/models", {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("includes enabled CLI mapping source models in the public catalog", async () => {
    runtime.config.cliModelMappings.setEnabled("claude", true);
    runtime.config.cliModelMappings.upsert({
      toolId: "claude",
      slotKey: "opus",
      sourceModel: "claude/claude-opus-4-8",
      targetModel: "opencodeft/deepseek-v4-flash-free",
      enabled: true,
    });
    try {
      const key = createApiKey("mapped-models-list-key");
      const res = await fetchGatewayQuery("/v1/models", { headers: { "x-api-key": key } });
      expect(res.status).toBe(200);
      const body = await jsonObject(res);
      const models = Array.isArray(body.data) ? body.data as Array<{ id?: unknown }> : [];
      expect(models.some((model) => model.id === "claude/claude-opus-4-8")).toBe(true);
    } finally {
      runtime.config.cliModelMappings.reset("claude");
    }
  });

  test("valid Bearer token returns 200", async () => {
    const key = createApiKey("bearer-key");
    const res = await fetchGatewayQuery("/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.object).toBe("list");
  });

  test("empty Bearer token is treated as missing", async () => {
    const res = await fetchGatewayQuery("/v1/models", {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  test("legacy GET with x-api-key is translated to QUERY", async () => {
    const key = createApiKey("legacy-models-get-key");
    const res = await fetchGateway("/v1/models", { headers: { "x-api-key": key } });
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-query")).toBe("application/json");
    expect((await jsonObject(res)).object).toBe("list");
  });

  test("Authorization header without Bearer prefix falls back to x-api-key (null)", async () => {
    const res = await fetchGatewayQuery("/v1/models", {
      headers: { authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────── Error envelope stability ─────────────────────────────

describe("gateway: stable error envelopes", () => {
  test("request_id in body matches x-request-id header", async () => {
    const res = await fetchGatewayQuery("/v1/models");
    const body = await jsonObject(res);
    const headerId = res.headers.get("x-request-id");
    expect(headerId).toBeTruthy();
    expect(body.error.request_id).toBe(headerId);
    expect(headerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("error envelope shape: { error: { type, code, message, request_id } }", async () => {
    const res = await fetchGatewayQuery("/v1/models");
    const body = await jsonObject(res);
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("type", "error");
    expect(body.error).toHaveProperty("code");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.request_id).toBe("string");
  });

  test("error responses carry cache-control: no-store", async () => {
    const res = await fetchGatewayQuery("/v1/models");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("two concurrent errors get distinct request IDs", async () => {
    const [a, b] = await Promise.all([
      fetchGatewayQuery("/v1/models"),
      fetchGatewayQuery("/v1/models"),
    ]);
    const idA = a.headers.get("x-request-id");
    const idB = b.headers.get("x-request-id");
    expect(idA).not.toBe(idB);
  });
});

// ───────────────────────────── Unknown routes ─────────────────────────────

describe("gateway: unknown routes", () => {
  test("GET /nonexistent returns 404 not_found", async () => {
    const res = await fetchGateway("/nonexistent");
    expect(res.status).toBe(404);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("not_found");
  });

  test("URI exceeding 2048 chars returns 414 uri_too_long", async () => {
    const longPath = "/" + "a".repeat(2048);
    const res = await fetchGateway(longPath);
    expect(res.status).toBe(414);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("uri_too_long");
  });

  test("GET on a proxy endpoint (only POST accepted) returns 404", async () => {
    const res = await fetchGateway("/v1/chat/completions");
    expect(res.status).toBe(404);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("not_found");
  });
});

// ───────────────────────────── Proxy route selection ─────────────────────────────

describe("gateway: proxy route selection (lookupProxyEndpoint)", () => {
  test("/v1/chat/completions resolves to openai-chat surface", () => {
    const route = lookupProxyEndpoint("/v1/chat/completions");
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe("/v1/chat/completions");
    expect(route!.surface).toBe("openai-chat");
  });

  test("/v1/messages resolves to anthropic-messages surface", () => {
    const route = lookupProxyEndpoint("/v1/messages");
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe("/v1/messages");
    expect(route!.surface).toBe("anthropic-messages");
  });

  test("/v1/responses resolves to openai-responses surface", () => {
    const route = lookupProxyEndpoint("/v1/responses");
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe("/v1/responses");
    expect(route!.surface).toBe("openai-responses");
  });

  test("/v1/images/generations resolves to images surface", () => {
    const route = lookupProxyEndpoint("/v1/images/generations");
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe("/v1/images/generations");
    expect(route!.surface).toBe("images");
  });

  test("/v1/images/edits resolves to images surface", () => {
    const route = lookupProxyEndpoint("/v1/images/edits");
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe("/v1/images/edits");
    expect(route!.surface).toBe("images");
  });

  test("non-proxy paths resolve to null", () => {
    expect(lookupProxyEndpoint("/health")).toBeNull();
    expect(lookupProxyEndpoint("/v1/models")).toBeNull();
    expect(lookupProxyEndpoint("/console/api/keys")).toBeNull();
    expect(lookupProxyEndpoint("/random")).toBeNull();
  });
});

// ───────────────────────────── Body parsing: malformed JSON ─────────────────────────────

describe("gateway: proxy body parsing", () => {
  test("malformed JSON on proxy endpoint returns 400 invalid_request", async () => {
    const key = createApiKey("malformed-json-key");
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("JSON");
  });

  test("empty body returns 400 invalid_request", async () => {
    const key = createApiKey("empty-body-key");
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("invalid_request");
  });

  test("NDJSON batch body is rejected", async () => {
    const key = createApiKey("ndjson-key");
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: '{"model":"x"}\n{"model":"y"}',
    });
    expect(res.status).toBe(400);
  });

  test("JSON array body parses as valid JSON (rejection is downstream in normalizeRequest)", async () => {
    const key = createApiKey("array-body-key");
    const request = new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: '[{"model":"x"}]',
    });
    const result = await readProxyBody(request, "/v1/chat/completions");
    // readProxyBody returns the parsed value (array is valid JSON);
    // downstream normalizeRequest is responsible for type-checking.
    expect(Array.isArray(result)).toBe(true);
  });
});

// ───────────────────────────── Body-size limits ─────────────────────────────

describe("gateway: body-size limits", () => {
  test("oversized body via content-length returns 413 request_too_large", async () => {
    const key = createApiKey("oversized-cl-key");
    const maxBytes = runtimeMemoryLimits.requestBodyBytes;
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "content-type": "application/json",
        "content-length": String(maxBytes + 1),
      },
      body: "x".repeat(maxBytes + 1),
    });
    expect(res.status).toBe(413);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("request_too_large");
  });

  test("oversized streaming body returns 413 request_too_large", async () => {
    const key = createApiKey("oversized-stream-key");
    const maxBytes = runtimeMemoryLimits.requestBodyBytes;
    const large = "x".repeat(maxBytes + 1024);
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: large,
    });
    expect(res.status).toBe(413);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("request_too_large");
  });
});

// ───────────────────────────── Multipart / content-type boundaries ─────────────────────────────

describe("gateway: multipart and content-type boundaries", () => {
  test("multipart form on /v1/images/edits without model field returns 400", async () => {
    const key = createApiKey("multipart-no-model-key");
    const formData = new FormData();
    formData.append("prompt", "edit this");
    const res = await fetchGateway("/v1/images/edits", {
      method: "POST",
      headers: { "x-api-key": key },
      body: formData,
    });
    expect(res.status).toBe(400);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("model");
  });

  test("multipart form on /v1/images/edits without prompt field returns 400", async () => {
    const key = createApiKey("multipart-no-prompt-key");
    const formData = new FormData();
    formData.append("model", "dall-e-3");
    const res = await fetchGateway("/v1/images/edits", {
      method: "POST",
      headers: { "x-api-key": key },
      body: formData,
    });
    expect(res.status).toBe(400);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("invalid_request");
  });

  test("valid multipart with model+prompt parses but returns 503 (no providers)", async () => {
    const key = createApiKey("multipart-valid-key");
    const formData = new FormData();
    formData.append("model", "dall-e-3");
    formData.append("prompt", "a cat");
    const res = await fetchGateway("/v1/images/edits", {
      method: "POST",
      headers: { "x-api-key": key },
      body: formData,
    });
    expect(res.status).toBe(503);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("provider_unavailable");
  });

  test("non-JSON body on chat endpoint returns 400", async () => {
    const key = createApiKey("non-json-key");
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "text/plain" },
      body: "hello world",
    });
    expect(res.status).toBe(400);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("invalid_request");
  });
});

// ───────────────────────────── Proxy auth gating ─────────────────────────────

describe("gateway: proxy endpoint authentication", () => {
  test("missing key on proxy POST returns 401 with request_id in header", async () => {
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
  });

  test("invalid key on proxy POST returns 401", async () => {
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": "ck-fake", "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  test("valid key with valid JSON passes auth+body parse, returns 503 (no providers)", async () => {
    const key = createApiKey("proxy-valid-key");
    const res = await fetchGateway("/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(503);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("provider_unavailable");
    expect(body.error.request_id).toBeTruthy();
  });
});

// ───────────────────────────── Console: login (public route) ─────────────────────────────

describe("console: login (public route)", () => {
  test("wrong password returns 401 with console error envelope", async () => {
    const res = await fetchConsole("/console/api/login", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    }));
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.type).toBe("error");
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.request_id).toBeTruthy();
  });

  test("missing password field returns 401", async () => {
    const res = await fetchConsole("/console/api/login", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });

  test("non-JSON body returns error status (Elysia parse error)", async () => {
    const res = await fetchConsole("/console/api/login", withOrigin({
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "password=test",
    }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("GET /console/api/login is not a GET route", async () => {
    const res = await fetchConsole("/console/api/login");
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────── Console: missing session ─────────────────────────────

describe("console: authenticated routes — missing session", () => {
  test("QUERY /console/api/session without cookie returns 401 authentication_failed", async () => {
    const res = await fetchConsoleQuery("/console/api/session");
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
    expect(body.error.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("QUERY /console/api/keys without cookie returns 401", async () => {
    const res = await fetchConsoleQuery("/console/api/keys");
    expect(res.status).toBe(401);
  });

  test("POST /console/api/settings without cookie returns 401", async () => {
    const res = await fetchConsole("/console/api/settings", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────── Console: invalid session ─────────────────────────────

describe("console: authenticated routes — invalid session", () => {
  test("garbage cookie token returns 401", async () => {
    const res = await fetchConsoleQuery("/console/api/session", { cookie: `${SESSION_COOKIE_NAME}=garbage.token.here` });
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
  });

  test("malformed token (not 3 parts) returns 401", async () => {
    const res = await fetchConsoleQuery("/console/api/session", { cookie: `${SESSION_COOKIE_NAME}=notajwt` });
    expect(res.status).toBe(401);
  });

  test("token signed with wrong secret returns 401", async () => {
    const token = await signSessionToken({ secret: "wrong-secret-that-is-long-enough-123456", pv: 1, ttlSeconds: 3600 });
    const res = await fetchConsoleQuery("/console/api/session", { cookie: `${SESSION_COOKIE_NAME}=${token}` });
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────── Console: expired session ─────────────────────────────

describe("console: expired session", () => {
  test("expired token returns 401", async () => {
    const current = runtime.config.settings.ensure();
    const expiredToken = await signSessionToken({
      secret: current.jwtSecret ?? "",
      pv: current.passwordVersion,
      ttlSeconds: 1,
      nowSeconds: Math.floor(Date.now() / 1000) - 2,
    });
    const res = await fetchConsoleQuery("/console/api/session", { cookie: `${SESSION_COOKIE_NAME}=${expiredToken}` });
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
  });
});

// ───────────────────────────── Console: mutation guard ─────────────────────────────

describe("console: mutation guard — content-type and same-origin", () => {
  let validToken: string;

  beforeAll(async () => {
    const current = runtime.config.settings.ensure();
    validToken = await signSessionToken({
      secret: current.jwtSecret ?? "",
      pv: current.passwordVersion,
      ttlSeconds: 3600,
    });
  });

  test("POST without content-type application/json returns 403 authorization_denied", async () => {
    const res = await fetchConsole("/console/api/settings", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        cookie: `${SESSION_COOKIE_NAME}=${validToken}`,
        origin: testServer.url,
        host: new URL(testServer.url).host,
      },
      body: "hello",
    });
    expect(res.status).toBe(403);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authorization_denied");
  });

  test("POST with cross-origin Origin returns 403 authorization_denied", async () => {
    const res = await fetchConsole("/console/api/settings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${validToken}`,
        origin: "https://evil.example",
        host: new URL(testServer.url).host,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authorization_denied");
  });
});

// ───────────────────────────── Console: body-size fast rejection ─────────────────────────────

describe("console: body-size fast rejection", () => {
  test("content-length > 5 MiB on non-restore path returns 413", async () => {
    const res = await fetchConsole("/console/api/settings", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(5_000_001) },
      body: "",
    }));
    expect(res.status).toBe(413);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("request_too_large");
  });

  test("content-length > 64 MiB on restore path returns 413", async () => {
    const res = await fetchConsole("/console/api/settings/restore", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024 + 1) },
      body: "",
    }));
    expect(res.status).toBe(413);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("request_too_large");
  });

  test("content-length under 5 MiB on non-restore path is not fast-rejected", async () => {
    const res = await fetchConsole("/console/api/settings", withOrigin({
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(100) },
      body: JSON.stringify({}),
    }));
    expect(res.status).not.toBe(413);
  });
});

// ───────────────────────────── Console: valid session flow ─────────────────────────────

describe("console: valid session authenticated access", () => {
  let validToken: string;
  let validCsrfToken: string;

  beforeAll(async () => {
    const current = runtime.config.settings.ensure();
    validToken = await signSessionToken({
      secret: current.jwtSecret ?? "",
      pv: current.passwordVersion,
      ttlSeconds: 3600,
    });
    const verified = await verifySessionToken(validToken, { secret: current.jwtSecret ?? "", expectedPv: current.passwordVersion });
    if (!verified.ok) throw new Error("test session token failed verification");
    validCsrfToken = await createConsoleCsrfToken(current.jwtSecret ?? "", verified.payload.jti);
  });

  test("QUERY /console/api/session returns 200 with role admin", async () => {
    const res = await fetchConsoleQuery("/console/api/session", { cookie: `${SESSION_COOKIE_NAME}=${validToken}` });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.role).toBe("admin");
    expect(typeof body.hasPassword).toBe("boolean");
    expect(res.headers.get("accept-query")).toBe("application/json");
  });

  test("QUERY /console/api/keys returns 200 with items array", async () => {
    const res = await fetchConsoleQuery("/console/api/keys", { cookie: `${SESSION_COOKIE_NAME}=${validToken}` });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("QUERY /console/api/settings returns 200 with settings view", async () => {
    const res = await fetchConsoleQuery("/console/api/settings", { cookie: `${SESSION_COOKIE_NAME}=${validToken}` });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body).toHaveProperty("settings");
    expect(body.settings).toHaveProperty("runtime");
  });
  test("legacy GET /console/api/session is translated to QUERY", async () => {
    const res = await fetchConsole("/console/api/session", { headers: { cookie: `${SESSION_COOKIE_NAME}=${validToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-query")).toBe("application/json");
    expect((await jsonObject(res)).role).toBe("admin");
  });


  test("POST /console/api/logout returns ok and clears cookie", async () => {
    const res = await fetchConsole("/console/api/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${validToken}`,
        origin: testServer.url,
        host: new URL(testServer.url).host,
        "x-cartethyia-csrf": validCsrfToken,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.ok).toBe(true);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    expect(cookie).toContain("Max-Age=0");
  });
});

// ───────────────────────────── Console: stale password version ─────────────────────────────

describe("console: stale password version invalidates session", () => {
  test("token with old pv returns 401 after password version bump", async () => {
    const current = runtime.config.settings.ensure();
    const oldToken = await signSessionToken({
      secret: current.jwtSecret ?? "",
      pv: current.passwordVersion,
      ttlSeconds: 3600,
    });
    runtime.config.settings.bumpPasswordVersion();
    const res = await fetchConsole("/console/api/session", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${oldToken}` },
    });
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.code).toBe("authentication_failed");
  });
});

// ───────────────────────────── Console: error envelope shape ─────────────────────────────

describe("console: error envelope shape", () => {
  test("console errors use { error: { type, code, message, request_id } }", async () => {
    const res = await fetchConsole("/console/api/session");
    expect(res.status).toBe(401);
    const body = await jsonObject(res);
    expect(body.error.type).toBe("error");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
