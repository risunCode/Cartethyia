/**
 * End-to-end regression: seeded default Filter Rules sanitize the outbound
 * system prompt before it reaches the upstream provider (REQ-9).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";
import { invalidateRuntimeSettings } from "../../src/console/runtime";
import { ensureSettings, patchRuntimeSettings } from "../../src/console/db/repos/settings";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  invalidateRuntimeSettings();
  fetchSpy = spyOn(globalThis, "fetch");
});

// Filter Rules default to globally OFF; every test below that exercises
// actual sanitization opts in explicitly instead of relying on a default a
// fresh install no longer has.
async function enableFilterRulesGlobally(): Promise<void> {
  await ensureSettings();
  patchRuntimeSettings({ filterRulesEnabled: true });
  invalidateRuntimeSettings();
}

afterEach(() => {
  fetchSpy.mockRestore();
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

describe("seeded Filter Rules sanitize outbound requests", () => {
  test("strips the Claude Code identity string from the system prompt before dispatch", async () => {
    await enableFilterRulesGlobally();
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          messages: [
            { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Help the user." },
            { role: "user", content: "hi" },
          ],
        }),
      })
    );

    expect(res.status).toBe(200);
    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMessage = sentBody.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).not.toContain("You are Claude Code");
    expect(systemMessage?.content).toContain("Help the user.");
  });

  test("leaves the system prompt untouched when the global Filter Rules toggle is off", async () => {
    await ensureSettings();
    patchRuntimeSettings({ filterRulesEnabled: false });
    invalidateRuntimeSettings();
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          messages: [
            { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Help the user." },
            { role: "user", content: "hi" },
          ],
        }),
      })
    );

    expect(res.status).toBe(200);
    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMessage = sentBody.messages.find((m) => m.role === "system");
    // Individual rules are all still "active" in the DB - only the master
    // switch is off - so this proves the global toggle short-circuits
    // sanitization entirely rather than just leaving one rule untouched.
    expect(systemMessage?.content).toContain("You are Claude Code");
  });

  test("a fresh install (no settings row) leaves the system prompt unsanitized by default", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          messages: [
            { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Help the user." },
            { role: "user", content: "hi" },
          ],
        }),
      })
    );

    expect(res.status).toBe(200);
    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMessage = sentBody.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("You are Claude Code");
  });

  test("console can deactivate a seeded rule and the next dispatch stops sanitizing", async () => {
    await enableFilterRulesGlobally();
    const cookie = await loginAndGetCookie();
    const listRes = await app.handle(new Request("http://localhost/console/api/filter.sanitize", { headers: { cookie } }));
    const { items } = (await listRes.json()) as { items: Array<{ id: number; ruleId: string }> };
    const entrypointRule = items.find((r) => r.ruleId === "cc-entrypoint")!;

    const patchRes = await app.handle(postJson(`/console/api/filter.sanitize/${entrypointRule.id}`, { isActive: false }, { cookie }));
    expect(patchRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          messages: [
            { role: "system", content: "cc_entrypoint=cli" },
            { role: "user", content: "hi" },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);

    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(chatInit?.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMessage = sentBody.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("cc_entrypoint=cli");
  });
});
