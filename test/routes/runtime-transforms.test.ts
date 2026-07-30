/**
 * Regression tests for console-configured RTK / system-prompt reaching the
 * live dispatch hot path. Prior to the fix, the console Settings API wrote
 * to `settings_json` (DB) but `dispatchQualifiedRoute`/`runEmulatedCompact`
 * read the boot-frozen `config.transforms` object, so toggling either
 * setting in the UI had no effect on outbound requests.
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
  test("enabling RTK via the settings API compresses a qualifying tool result on the next dispatch", async () => {
    const cookie = await loginAndGetCookie();
    const rtkRes = await app.handle(
      postJson("/console/api/overview/rtk", { enabled: true, minChars: 10, maxReductionPercent: 90 }, { cookie })
    );
    expect(rtkRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const gitStatusOutput = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const res = await postChat({
      model: "kimchi/kimi-k2.7",
      messages: [{ role: "tool", tool_call_id: "t1", content: gitStatusOutput }],
    });
    expect(res.status).toBe(200);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const toolMessage = sentMessages(chatInit).find((m) => m.role === "tool");
    expect(toolMessage?.content.length).toBeLessThan(gitStatusOutput.length);
    expect(toolMessage?.content).toContain("~ Modified: 80 files");
  });

  test("leaves tool output untouched when RTK is explicitly disabled via the settings API", async () => {
    const cookie = await loginAndGetCookie();
    const rtkRes = await app.handle(
      postJson("/console/api/overview/rtk", { enabled: false }, { cookie })
    );
    expect(rtkRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const gitStatusOutput = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const res = await postChat({
      model: "kimchi/kimi-k2.7",
      messages: [{ role: "tool", tool_call_id: "t1", content: gitStatusOutput }],
    });
    expect(res.status).toBe(200);

    const [, chatInit] = fetchSpy.mock.calls[0]!;
    const toolMessage = sentMessages(chatInit).find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(gitStatusOutput);
  });

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
