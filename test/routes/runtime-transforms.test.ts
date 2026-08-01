/**
 * Regression tests for the console-configured system prompt reaching the
 * live dispatch hot path. Prior to the fix, the console Settings API wrote
 * to `settings_json` (DB) but `dispatchQualifiedRoute`/`runEmulatedCompact`
 * read the boot-frozen `config.transforms` object, so toggling the setting
 * in the UI had no effect on outbound requests.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// Regression: chat.ts/messages.ts/responses.ts all `await
// dispatchQualifiedRoute(...)` in full - retries included - before sending
// the client anything, not even response headers. The dispatch retry
// backoff used to be 2000ms base with up to 3 retries, so two transient
// upstream failures (502/503/504, both retryable) burned several seconds of
// total silence before a third attempt even started - long enough for a
// real streaming client (GitHub Copilot Chat's BYOK custom model, reported
// via a live trace: status 499/"aborted", 8.4s duration) to conclude the
// connection was dead and cancel it, wasting the retry outright. This
// proves a request that needs two retries to succeed now recovers in well
// under a second instead of several seconds.
describe("dispatch retry backoff stays fast enough that a client never sees dead silence", () => {
  test("recovers from two transient 503s well under a second, not several seconds", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("upstream busy", { status: 503 }));
    fetchSpy.mockResolvedValueOnce(new Response("upstream busy", { status: 503 }));
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const startedAt = performance.now();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({ model: "kimchi/kimi-k2.7", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
    );
    const elapsedMs = performance.now() - startedAt;

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Old config (2000ms base, exponential) would have taken ~7s for two
    // retries; the new fast backoff keeps this comfortably under 1.5s even
    // with test overhead and jitter.
    expect(elapsedMs).toBeLessThan(1500);
  });
});

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "kimchi-1",
      object: "chat.completion",
      created: 1234,
      model: "kimi-k2.7",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function postChat(body: unknown) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
      body: JSON.stringify(body),
    })
  );
}

interface SentMessage {
  role: string;
  content: string;
  tool_call_id?: string;
}

function sentMessages(chatInit: RequestInit | undefined): SentMessage[] {
  return (JSON.parse(String(chatInit?.body)) as { messages: SentMessage[] }).messages;
}

describe("console runtime settings reach the live dispatch path", () => {
  test("setting a system-prompt override via the settings API injects it into the next dispatch", async () => {
    const cookie = await loginAndGetCookie();
    const patchRes = await app.handle(postJson("/console/api/settings", { systemPrompt: "ALWAYS SIGN OFF WITH A FLOWER" }, { cookie }));
    expect(patchRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({
      model: "kimchi/kimi-k2.7",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const systemMessage = sentMessages(chatInit).find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("ALWAYS SIGN OFF WITH A FLOWER");
  });

  test("injects the built-in system prompt on a fresh install without console override", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({
      model: "kimchi/kimi-k2.7",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const systemMessage = sentMessages(chatInit).find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Before acting");
    expect(systemMessage?.content).toContain("never assume a past year is current");
  });

  test("clearing the system-prompt override via the settings API removes injection on the next dispatch", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(postJson("/console/api/settings", { systemPrompt: "temporary" }, { cookie }));
    const clearRes = await app.handle(postJson("/console/api/settings", { systemPrompt: "" }, { cookie }));
    expect(clearRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({
      model: "kimchi/kimi-k2.7",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const systemMessage = sentMessages(chatInit).find((m) => m.role === "system");
    expect(systemMessage).toBeUndefined();
  });
});
