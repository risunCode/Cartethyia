/**
 * The console log tail must make a completed request's shape "ketauan"
 * (obvious) at a glance: success/fail, which proxy (or "direct") carried it,
 * a short preview of what was actually asked, and which tools ran \u2014 not
 * just the bare status/duration line it used to be.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { getConsoleLogSnapshot, resetConsoleLogsForTests } from "../../src/console/logs/ring";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  resetConsoleLogsForTests();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

async function lastRequestLogLine(): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    const line = [...getConsoleLogSnapshot()].reverse().find((l) => l.scope === "request");
    if (line) return line.msg;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

describe("console log enrichment", () => {
  test("shows success glyph, direct/proxy status, a message preview, and tool names", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "kimchi-1",
          object: "chat.completion",
          created: 1234,
          model: "kimi-k2.7",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "What is the weather in Tokyo right now?" }], tools: [{ type: "function", function: { name: "get_weather" } }] },
      { authorization: "Bearer kimchi_test_key" }
    );
    expect(res.status).toBe(200);

    const line = await lastRequestLogLine();
    expect(line).toBeDefined();
    expect(line).toContain("\u2713"); // success glyph
    expect(line).toContain("kimchi/kimi-k2.7");
    expect(line).toContain("\u2192 200");
    expect(line).toContain("direct"); // no proxy pool configured for this test
    expect(line).toContain("in:2 out:3");
    expect(line).toContain("tools:get_weather");
    expect(line).toContain('msg:"What is the weather in Tokyo right now?"');
  });

  test("uses a failure glyph for an error response", async () => {
    // 400 (not 5xx/429) so the dispatch retry wrapper doesn't add real
    // exponential-backoff wall-clock delay to this test.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400, headers: { "content-type": "application/json" } }));

    await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer kimchi_test_key" });

    const line = await lastRequestLogLine();
    expect(line).toContain("\u2717");
    expect(line).toContain("\u2192 400");
  });

  test("shows the pool name instead of \"direct\" when routed through a proxy pool", async () => {
    const cookie = await loginAndGetCookie();
    const poolRes = await app.handle(
      postJson("/console/api/proxy-pools", { name: "log-pool", entries: [{ url: "http://proxy-a.example.com:8080", scheme: "http" }], noProxy: "", strictProxy: false, platform: "custom" }, { cookie })
    );
    expect(poolRes.status).toBe(201);
    const pool = (await poolRes.json()) as { id: string };
    const dnsSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4, ttl: 0 }]);
    const routingRes = await app.handle(postJson("/console/api/providers/kimchi/routing", { proxyMode: "proxy-pool", proxyPoolId: pool.id }, { cookie }));
    expect(routingRes.status).toBe(200);

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "kimi-k2.7", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer kimchi_test_key" });

    const line = await lastRequestLogLine();
    expect(line).toContain("proxy:log-pool");
    dnsSpy.mockRestore();
  });
});
