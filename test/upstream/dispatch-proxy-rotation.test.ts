/**
 * Provider-level proxy routing (`proxyMode`): "proxy-pool" (Round Robin)
 * rotates across a pool's entries request-by-request; "mixed" (Round Robin
 * Mix) puts a direct (no-proxy) candidate in that same rotation. Both are
 * exercised end-to-end through the real /v1/chat/completions dispatch path
 * so the fix is verified where it actually matters, not just at the
 * function-unit level.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";

let fetchSpy: Mock<typeof fetch>;
let dnsLookupSpy: ReturnType<typeof spyOn<typeof Bun.dns, "lookup">>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
  dnsLookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4, ttl: 0 }]);
});

afterEach(() => {
  dnsLookupSpy.mockRestore();
  fetchSpy.mockRestore();
});

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1234,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const PROVIDER = "mistral";

async function setup(cookie: string) {
  const accountRes = await app.handle(
    postJson(`/console/api/providers/${PROVIDER}/accounts`, { name: "rot-account", credentialKind: "bearer", credential: "sk-secret" }, { cookie })
  );
  expect(accountRes.status).toBe(201);

  const poolRes = await app.handle(
    postJson(
      "/console/api/proxy-pools",
      { name: "rot-pool", entries: [{ url: "http://proxy-a.example.com:8080", scheme: "http" }, { url: "http://proxy-b.example.com:8080", scheme: "http" }], noProxy: "", strictProxy: false, platform: "custom" },
      { cookie }
    )
  );
  const pool = (await poolRes.json()) as { id: string };

  return { poolId: pool.id };
}

async function sendChat(): Promise<string | undefined> {
  fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
  await app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${PROVIDER}/mistral-large-latest`, messages: [{ role: "user", content: "hi" }] }),
    })
  );
  const call = fetchSpy.mock.calls.at(-1)!;
  const init = call[1] as (RequestInit & { proxy?: string }) | undefined;
  return init?.proxy;
}

describe("dispatchProvider \u2014 proxy-pool round robin", () => {
  test("rotates across pool entries request-by-request instead of pinning one entry", async () => {
    const cookie = await loginAndGetCookie();
    const { poolId } = await setup(cookie);
    const routingRes = await app.handle(postJson(`/console/api/providers/${PROVIDER}/routing`, { proxyMode: "proxy-pool", proxyPoolId: poolId }, { cookie }));
    expect(routingRes.status).toBe(200);

    const proxies = [await sendChat(), await sendChat(), await sendChat(), await sendChat()];

    for (const p of proxies) expect(p).toBeOneOf(["http://proxy-a.example.com:8080", "http://proxy-b.example.com:8080"]);
    // Round robin must actually alternate, not stick to one entry every call.
    expect(new Set(proxies).size).toBeGreaterThan(1);
  });
});

describe("dispatchProvider \u2014 mixed round robin", () => {
  test("includes a direct (no-proxy) candidate in the same rotation as the pool entries", async () => {
    const cookie = await loginAndGetCookie();
    const { poolId } = await setup(cookie);
    const routingRes = await app.handle(postJson(`/console/api/providers/${PROVIDER}/routing`, { proxyMode: "mixed", proxyPoolId: poolId }, { cookie }));
    expect(routingRes.status).toBe(200);

    const proxies = [await sendChat(), await sendChat(), await sendChat(), await sendChat(), await sendChat(), await sendChat()];

    expect(proxies).toContain(undefined); // at least one call went direct
    expect(proxies.some((p) => p !== undefined)).toBe(true); // and at least one went through a proxy
  });
});

describe("dispatchProvider \u2014 proxy-pool round robin survives a non-retryable status from one candidate", () => {
  // Regression: a plain 400 (not in the default retryable-status set, and
  // not matched by any retryable-text pattern) from ONE proxy candidate -
  // e.g. an edge/CDN gateway in front of that specific proxy rejecting the
  // connection with a generic "Bad request\n\nBAD_REQUEST" page, unrelated
  // to whether the actual request is valid - used to fail the whole
  // dispatch instantly without ever trying the pool's other entries.
  // Confirmed via a live report. A rotating pool must still try every
  // candidate at least once before giving up, regardless of the specific
  // status the failing candidate returned.
  test("falls over to the next pool entry on a plain 400 from the first, instead of failing instantly", async () => {
    const cookie = await loginAndGetCookie();
    const { poolId } = await setup(cookie);
    const routingRes = await app.handle(postJson(`/console/api/providers/${PROVIDER}/routing`, { proxyMode: "proxy-pool", proxyPoolId: poolId }, { cookie }));
    expect(routingRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(new Response("Bad request\n\nBAD_REQUEST", { status: 400 }));
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${PROVIDER}/mistral-large-latest`, messages: [{ role: "user", content: "hi" }] }),
      })
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [firstProxy, secondProxy] = fetchSpy.mock.calls.map((call) => (call[1] as (RequestInit & { proxy?: string }) | undefined)?.proxy);
    expect(firstProxy).toBeOneOf(["http://proxy-a.example.com:8080", "http://proxy-b.example.com:8080"]);
    expect(secondProxy).toBeOneOf(["http://proxy-a.example.com:8080", "http://proxy-b.example.com:8080"]);
    expect(secondProxy).not.toBe(firstProxy);
  });

  test("still fails once every pool entry has been tried and all return the same non-retryable status", async () => {
    const cookie = await loginAndGetCookie();
    const { poolId } = await setup(cookie);
    const routingRes = await app.handle(postJson(`/console/api/providers/${PROVIDER}/routing`, { proxyMode: "proxy-pool", proxyPoolId: poolId }, { cookie }));
    expect(routingRes.status).toBe(200);

    fetchSpy.mockResolvedValue(new Response("Bad request\n\nBAD_REQUEST", { status: 400 }));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${PROVIDER}/mistral-large-latest`, messages: [{ role: "user", content: "hi" }] }),
      })
    );

    expect(res.status).toBe(400);
    // Exactly the pool's two entries - not zero (fail-fast bug) and not an
    // unbounded loop once every candidate has genuinely failed.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("dispatchProvider \u2014 direct mode", () => {
  test("never attaches a proxy even when a pool is configured", async () => {
    const cookie = await loginAndGetCookie();
    const { poolId } = await setup(cookie);
    const routingRes = await app.handle(postJson(`/console/api/providers/${PROVIDER}/routing`, { proxyMode: "direct", proxyPoolId: poolId }, { cookie }));
    expect(routingRes.status).toBe(200);

    expect(await sendChat()).toBeUndefined();
  });
});
