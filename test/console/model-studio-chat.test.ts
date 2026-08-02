/**
 * Model Studio's `/chat` route shares `createRequestTracker` +
 * `finishSurfaceDispatch` with every real `/v1/*` proxy route (console log
 * redesign, REQ-console-log-unify) instead of its own bespoke
 * error-only `pushConsoleLog` call. A successful Model Studio completion
 * must now be just as visible in the console log \u2014 same glyph-first
 * format, same "request" scope, including the account label \u2014 as live
 * proxy traffic through the same stored account.
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

// Matches the identical helper in console-log-enrichment.test.ts: tracker.ts's
// `persist()` is genuinely fire-and-forget (`void persistAsync(...)`), so
// there is no promise/event to await instead \u2014 polling the ring buffer is
// the only signal available without adding a test-only hook to tracker.ts.
async function lastRequestLogLine(): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    const line = [...getConsoleLogSnapshot()].reverse().find((l) => l.scope === "request");
    if (line) return line.msg;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

describe("Model Studio console log unification", () => {
  test("a successful chat call is visible in the console log with the same shape as live proxy traffic", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/kimchi/accounts", { name: "StudioTestAccount", credential: "kimchi-key-abc" }, { cookie })
    );
    expect(created.status).toBe(201);

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "kimchi-1",
          object: "chat.completion",
          created: 1234,
          model: "kimi-k2.7",
          choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await app.handle(
      postJson(
        "/console/api/model-studio/chat",
        { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }], stream: false },
        { cookie }
      )
    );
    expect(res.status).toBe(200);

    const line = await lastRequestLogLine();
    expect(line).toBeDefined();
    expect(line).toContain("\u2705"); // same success glyph real /v1/* traffic gets
    expect(line).toContain("kimchi/kimi-k2.7");
    expect(line).toContain("\u2192 200");
    expect(line).toContain("in:4 out:6");
    expect(line).toContain("ACC:StudioTestAccount"); // account-label threading works end to end
  });

  test("compacts a saved context through the shared dispatch pipeline", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/kimchi/accounts", { name: "StudioCompactAccount", credential: "kimchi-key-compact" }, { cookie })
    );
    expect(created.status).toBe(201);

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "kimchi-compact",
          object: "chat.completion",
          created: 1234,
          model: "kimi-k2.7",
          choices: [{ index: 0, message: { role: "assistant", content: "Summary: preserve the project decisions." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await app.handle(
      postJson(
        "/console/api/model-studio/compact",
        { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }] },
        { cookie },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string; usage: { prompt_tokens: number; completion_tokens: number } };
    expect(body.summary).toContain("preserve the project decisions");
    expect(body.usage.prompt_tokens).toBe(40);
    expect(body.usage.completion_tokens).toBe(9);
  });

  test("a failed chat call is visible in the console log (previously invisible on success, but this path already logged failures)", async () => {
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/providers/kimchi/accounts", { name: "StudioFailAccount", credential: "kimchi-key-abc" }, { cookie })
    );
    expect(created.status).toBe(201);

    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400, headers: { "content-type": "application/json" } }));

    const res = await app.handle(
      postJson(
        "/console/api/model-studio/chat",
        { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }], stream: false },
        { cookie }
      )
    );
    expect(res.status).toBe(400);

    const line = await lastRequestLogLine();
    expect(line).toContain("\u274c");
    expect(line).toContain("[400]");
  });
});
