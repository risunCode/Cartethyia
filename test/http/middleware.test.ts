/**
 * Unit tests for createRequestTrafficMiddleware — the Elysia middleware wrapper
 * around ActiveFlightTracker. Exercises acquire/reject/release lifecycle,
 * per-IP limiting on /v1/* routes, and the x-request-id header injection.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { createRequestTrafficMiddleware } from "../../src/http/middleware";
import { ActiveFlightTracker } from "../../src/http/traffic";
import { Elysia } from "elysia";

function makeApp(maxFlightsPerIp: number, trustProxy = false) {
  const tracker = new ActiveFlightTracker();
  const middleware = createRequestTrafficMiddleware({ maxFlightsPerIp, trustProxy }, tracker);
  const app = new Elysia()
    .use(middleware)
    .get("/v1/chat/completions", () => new Response("ok", { status: 200 }))
    .get("/health", () => new Response("ok", { status: 200 }));
  return { app, tracker };
}

function req(path: string, ip = "127.0.0.1"): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "x-real-ip": ip },
  });
}

describe("createRequestTrafficMiddleware — request ID injection", () => {
  test("injects x-request-id header on every response", async () => {
    const { app } = makeApp(5);
    const res = await app.handle(req("/health"));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("each request gets a unique x-request-id", async () => {
    const { app } = makeApp(5);
    const [r1, r2] = await Promise.all([app.handle(req("/health")), app.handle(req("/health"))]);
    expect(r1!.headers.get("x-request-id")).not.toBe(r2!.headers.get("x-request-id"));
  });
});

describe("createRequestTrafficMiddleware — flight limiting on /v1/*", () => {
  test("returns 200 when within the flight limit", async () => {
    const { app } = makeApp(5);
    const res = await app.handle(req("/v1/chat/completions"));
    expect(res.status).toBe(200);
  });

  test("non-/v1/ routes are never flight-limited", async () => {
    const { app, tracker } = makeApp(1);
    // Saturate the IP slot externally
    tracker.acquire("127.0.0.1", 1);
    tracker.acquire("127.0.0.1", 1);
    const res = await app.handle(req("/health"));
    expect(res.status).toBe(200);
  });

  test("maxFlightsPerIp=0 disables limiting even for /v1/*", async () => {
    const { app, tracker } = makeApp(0);
    tracker.acquire("1.2.3.4", 0);
    const res = await app.handle(req("/v1/chat/completions", "1.2.3.4"));
    expect(res.status).toBe(200);
  });
});

describe("createRequestTrafficMiddleware — 429 when over limit", () => {
  // trustProxy=true so the middleware honors the x-real-ip header the test
  // sets ". identifyClient() ignores forwarded headers entirely when
  // trustProxy is false, always falling back to the (here, absent) direct
  // socket IP ". which would make every test request collapse onto the same
  // "unknown" bucket regardless of the IP argument.
  test("returns 429 when IP has already hit maxFlightsPerIp", async () => {
    const { app, tracker } = makeApp(1, true);
    // Manually saturate the slot before issuing the request
    tracker.acquire("9.9.9.9", 1);
    const res = await app.handle(req("/v1/chat/completions", "9.9.9.9"));
    expect(res.status).toBe(429);
  });

  test("429 response body is an OpenAI-compatible rate_limit_error envelope", async () => {
    const { app, tracker } = makeApp(1, true);
    tracker.acquire("9.9.9.9", 1);
    const res = await app.handle(req("/v1/chat/completions", "9.9.9.9"));
    const body = await res.json() as { error?: { type?: string; message?: string } };
    expect(body?.error?.type).toBe("rate_limit_error");
    expect(body?.error?.message).toBeTruthy();
  });
});
