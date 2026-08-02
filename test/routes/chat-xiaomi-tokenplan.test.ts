/**
 * Xiaomi MiMo Token Plan dispatch — generic OpenAI-compatible provider
 * pointed at the Singapore cluster (region-specific keys; SGP is the
 * reference registry's default region).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { useIsolatedDataDir } from "../console/helpers";

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
      id: "tp-1",
      object: "chat.completion",
      created: 1234,
      model: "mimo-v2.5-pro",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with xiaomitp (tpxiaomi) namespace", () => {
  test("routes to the Singapore token-plan cluster with the caller's bearer credential", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("hello from token plan"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tp-secret-key" },
        body: JSON.stringify({ model: "xiaomitp/mimo-v2.5-pro", messages: [{ role: "user", content: "hi" }] }),
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from token plan");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://token-plan-sgp.xiaomimimo.com/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tp-secret-key");
  });
});
