/**
 * End-to-end regression: seeded default Filter Rules sanitize the outbound
 * system prompt before it reaches the upstream provider (REQ-9).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";
import { invalidateRuntimeSettings } from "../../src/console/runtime";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  invalidateRuntimeSettings();
  fetchSpy = spyOn(globalThis, "fetch");
});

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

  test("console can deactivate a seeded rule and the next dispatch stops sanitizing", async () => {
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
