/** Messages compact tests — context_management compact edits (REQ-23.8, §10.3). */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234,
      model: "kimi-k2.7",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function postMessages(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/messages with context_management compact", () => {
  test("detects compact edits and runs compaction when no trigger specified", async () => {
    fetchSpy.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse((init as RequestInit).body as string) as { messages: Array<{ role: string; content: string }> };
      expect(sent.messages[0]!.role).toBe("system");
      expect(sent.messages[0]!.content).toContain("Condense");
      return chatResponse("This is the compacted summary.");
    }) as unknown as typeof fetch);

    const res = await postMessages({
      model: "kimchi/kimi-k2.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Long conversation here..." }],
      context_management: {
        edits: [{ type: "compact_20260112" }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.type).toBe("message");
    expect(body.content[0]!.type).toBe("text");
    expect(body.content[0]!.text).toContain("[Compacted]");
    expect(body.content[0]!.text).toContain("compacted summary");
  });

  test("strips edits and passes through normally when trigger not met", async () => {
    fetchSpy.mockResolvedValue(chatResponse("normal response"));

    // Very short message — estimated tokens (chars/4) well below trigger value
    const res = await postMessages({
      model: "kimchi/kimi-k2.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      context_management: {
        edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 10000 } }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.type).toBe("message");
    expect(body.content[0]!.text).toBe("normal response");
    // Should NOT be wrapped in [Compacted]
    expect(body.content[0]!.text).not.toContain("[Compacted]");
  });

  test("runs compaction when trigger IS met", async () => {
    fetchSpy.mockResolvedValue(chatResponse("trigger-met summary"));

    // Build a message long enough to exceed the trigger (estimated tokens > 10)
    const longMessage = "x".repeat(200); // 200 chars → ~50 estimated tokens
    const res = await postMessages({
      model: "kimchi/kimi-k2.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: longMessage }],
      context_management: {
        edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 10 } }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.content[0]!.text).toContain("[Compacted]");
    expect(body.content[0]!.text).toContain("trigger-met summary");
  });

  test("uses client instructions when provided (overrides default)", async () => {
    fetchSpy.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse((init as RequestInit).body as string) as { messages: Array<{ role: string; content: string }> };
      expect(sent.messages[0]!.content).toContain("Custom instruction from client");
      expect(sent.messages[0]!.content).not.toContain("Condense the conversation");
      return chatResponse("custom summary");
    }) as unknown as typeof fetch);

    const res = await postMessages({
      model: "kimchi/kimi-k2.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Please compact." }],
      context_management: {
        edits: [{ type: "compact_20260112", instructions: "Custom instruction from client: focus on code changes only." }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("returns Anthropic-shaped compaction block (correct content type)", async () => {
    fetchSpy.mockResolvedValue(chatResponse("summary text"));

    const res = await postMessages({
      model: "kimchi/kimi-k2.7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Compact this conversation." }],
      context_management: {
        edits: [{ type: "compact_20260112" }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toHaveLength(1);
    expect(body.content[0]!.type).toBe("text");
    expect(body.stop_reason).toBe("end_turn");
  });

  test("rejects bare model name with 400", async () => {
    const res = await postMessages({
      model: "not-a-real-model",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      context_management: {
        edits: [{ type: "compact_20260112" }],
      },
    }, { authorization: "Bearer test_key" });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
