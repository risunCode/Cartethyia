import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clineProvider } from "../../../src/upstream/providers/cline";

const target = clineProvider.resolveTarget("deepseek/deepseek-v4-flash");

if (!target) throw new Error("Cline model did not resolve");

describe("Cline provider", () => {
  const originalFetch = globalThis.fetch;
  let lastBody: Record<string, unknown> | undefined;
  let attempts = 0;

  beforeEach(() => {
    lastBody = undefined;
    attempts = 0;
    globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      lastBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (attempts === 1) return Response.json({ error: "empty response content" }, { status: 500 });
      return Response.json({
      data: {
        id: "gen-test",
        object: "chat.completion",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      },
      success: true,
    });
    }, { preconnect: originalFetch.preconnect });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("unwraps Cline's data envelope for non-streaming chat responses", async () => {
    const result = await clineProvider.call(target, {
      surface: "openai-chat",
      body: { model: target.modelId, messages: [{ role: "user", content: "Reply OK." }], stream: false },
    }, {
      kind: "oauth",
      value: "test-access-token",
    }, AbortSignal.timeout(1_000));

    expect(attempts).toBe(2);
    expect(lastBody?.stream).toBe(false);
    expect(lastBody?.messages).toEqual([
      { role: "system", content: "Answer directly in 2-4 sentences. Do not explain your reasoning." },
      { role: "user", content: "Reply OK." },
    ]);
    expect(result).toEqual({
      type: "json",
      body: expect.objectContaining({
        id: "gen-test",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      }),
    });
  });
});
