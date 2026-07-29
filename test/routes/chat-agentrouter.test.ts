/**
 * AgentRouter dispatch (free $200-credit gateway, native Anthropic Messages
 * with full Claude CLI header spoofing) — the upstream gates on client
 * identity, so this proves the spoofed headers actually go out, not just
 * that a request reaches the right URL.
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

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

function anthropicResponse(text: string) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with agentrouter namespace", () => {
  test("hits agentrouter.org with x-api-key and the full Claude CLI spoof headers", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicResponse("hello from agentrouter"));

    const res = await postChat(
      { model: "agentrouter/claude-opus-4-6", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer ar-secret-key" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from agentrouter");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://agentrouter.org/v1/messages?beta=true");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ar-secret-key");
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(headers["user-agent"]).toContain("claude-cli");
    expect(headers["x-claude-code-session-id"]).toBeTruthy();
  });

  test("reorders the outbound body to the claude-code-compatible field order", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicResponse("ok"));

    await postChat({ model: "agentrouter/claude-opus-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer x" });

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const keys = Object.keys(sentBody);
    // "model" and "messages" must precede "max_tokens" per AgentRouter's expected order.
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("max_tokens"));
    expect(keys.indexOf("messages")).toBeLessThan(keys.indexOf("max_tokens"));
  });

  test("rejects a request with no credential", async () => {
    const res = await postChat({ model: "agentrouter/claude-opus-4-6", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
