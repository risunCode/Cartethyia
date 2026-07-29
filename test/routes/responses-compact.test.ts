/** Responses compact tests — POST /v1/responses/compact (REQ-22.7, §10.2). */

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

function compactResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-compact-1",
      object: "chat.completion",
      created: 1234,
      model: "kimi-k2.7",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function postCompact(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/responses/compact", () => {
  test("resolves a qualified model and dispatches to the provider", async () => {
    fetchSpy.mockResolvedValue(compactResponse("This is the compacted summary of the conversation."));

    const res = await postCompact(
      { model: "kimchi/kimi-k2.7", input: "Summarize this conversation." },
      { authorization: "Bearer test_key" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; output: unknown[]; output_text: string };
    expect(body.status).toBe("completed");
    expect(body.output_text).toContain("compacted summary");
  });

  test("injects the compaction instruction as a system message", async () => {
    fetchSpy.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse((init as RequestInit).body as string) as { messages: Array<{ role: string; content: string }> };
      expect(sent.messages[0]!.role).toBe("system");
      expect(sent.messages[0]!.content).toContain("Condense");
      expect(sent.messages[0]!.content).toContain("faithful summary");
      expect(sent.messages.length).toBeGreaterThanOrEqual(2);
      return compactResponse("summary result");
    }) as unknown as typeof fetch);

    const res = await postCompact(
      { model: "kimchi/kimi-k2.7", input: "Please compact." },
      { authorization: "Bearer test_key" },
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("forces stream=false in the upstream request", async () => {
    fetchSpy.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse((init as RequestInit).body as string) as { stream?: boolean };
      expect(sent.stream).toBe(false);
      return compactResponse("compacted");
    }) as unknown as typeof fetch);

    const res = await postCompact(
      { model: "kimchi/kimi-k2.7", input: "Compact this." },
      { authorization: "Bearer test_key" },
    );

    expect(res.status).toBe(200);
  });

  test("returns Responses-shaped output (not raw Chat)", async () => {
    fetchSpy.mockResolvedValue(compactResponse("The summary."));

    const res = await postCompact(
      { model: "kimchi/kimi-k2.7", input: "Compact." },
      { authorization: "Bearer test_key" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Responses shape has object, status, output, output_text
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(Array.isArray(body.output)).toBe(true);
    expect(typeof body.output_text).toBe("string");
  });

  test("rejects bare model name with 400", async () => {
    // "not-a-model" has no provider prefix → rejected as bare model name
    const res = await postCompact(
      { model: "not-a-model", input: "Compact." },
      { authorization: "Bearer test_key" },
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
