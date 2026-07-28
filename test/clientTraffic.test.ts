import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { ActiveFlightTracker, identifyClient } from "../src/http/traffic";
import { createRequestTrafficMiddleware } from "../src/http/middleware";

const logSpy = spyOn(console, "log").mockImplementation(() => undefined);

afterEach(() => {
  logSpy.mockClear();
});

describe("client identity", () => {
  test("does not trust spoofable forwarded headers unless trustProxy is enabled", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "client-a" });

    expect(identifyClient(headers, "10.0.0.7", false).ip).toBe("10.0.0.7");
    expect(identifyClient(headers, "10.0.0.7", true).ip).toBe("203.0.113.9");
  });

  test("creates a stable short fingerprint without retaining raw user-agent text", () => {
    const headers = new Headers({ "user-agent": "CartethyiaTest/1.0", "accept-language": "en-US" });
    const first = identifyClient(headers, "127.0.0.1", false);
    const second = identifyClient(headers, "127.0.0.1", false);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).not.toContain("CartethyiaTest");
  });
});

describe("per-IP active-flight limits", () => {
  test("rejects a second /v1 request from the same trusted forwarded IP until the first flight completes", async () => {
    const tracker = new ActiveFlightTracker();
    const release = Promise.withResolvers<void>();
    const traffic = createRequestTrafficMiddleware({ maxFlightsPerIp: 1, trustProxy: true }, tracker);
    const app = new Elysia()
      .use(traffic)
      .post("/v1/work", async () => {
        await release.promise;
        return { ok: true };
      });
    const first = app.handle(new Request("http://localhost/v1/work", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } }));

    for (let attempt = 0; tracker.active("203.0.113.9") !== 1 && attempt < 20; attempt++) {
      await Bun.sleep(5);
    }
    const second = await app.handle(new Request("http://localhost/v1/work", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } }));
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { type: "rate_limit_error", message: expect.stringContaining("1 active requests") } });

    release.resolve();
    expect((await first).status).toBe(200);
    for (let attempt = 0; tracker.active("203.0.113.9") !== 0 && attempt < 20; attempt++) {
      await Bun.sleep(5);
    }
    expect(tracker.active("203.0.113.9")).toBe(0);
  });

  test("keeps different IPs independent", async () => {
    const tracker = new ActiveFlightTracker();
    const release = Promise.withResolvers<void>();
    const traffic = createRequestTrafficMiddleware({ maxFlightsPerIp: 1, trustProxy: true }, tracker);
    const app = new Elysia()
      .use(traffic)
      .post("/v1/work", async () => {
        await release.promise;
        return { ok: true };
      });
    const first = app.handle(new Request("http://localhost/v1/work", { method: "POST", headers: { "x-forwarded-for": "203.0.113.1" } }));
    const second = app.handle(new Request("http://localhost/v1/work", { method: "POST", headers: { "x-forwarded-for": "203.0.113.2" } }));

    for (let attempt = 0; (tracker.active("203.0.113.1") !== 1 || tracker.active("203.0.113.2") !== 1) && attempt < 20; attempt++) {
      await Bun.sleep(5);
    }
    expect(tracker.active("203.0.113.1")).toBe(1);
    expect(tracker.active("203.0.113.2")).toBe(1);

    release.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    for (let attempt = 0; (tracker.active("203.0.113.1") !== 0 || tracker.active("203.0.113.2") !== 0) && attempt < 20; attempt++) {
      await Bun.sleep(5);
    }
    expect(tracker.active("203.0.113.1")).toBe(0);
    expect(tracker.active("203.0.113.2")).toBe(0);
  });

  test("leaves health outside the concurrency gate", async () => {
    const tracker = new ActiveFlightTracker();
    const traffic = createRequestTrafficMiddleware({ maxFlightsPerIp: 1, trustProxy: true }, tracker);
    const app = new Elysia().use(traffic).get("/health", () => ({ ok: true }));

    const response = await app.handle(new Request("http://localhost/health", { headers: { "x-forwarded-for": "203.0.113.9" } }));

    expect(response.status).toBe(200);
    expect(tracker.active("203.0.113.9")).toBe(0);
  });
});
