import { afterEach, describe, expect, test, vi } from "vitest";
import { streamModelStudioChat, studioUsageFromChatUsage } from "./stream";

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model studio stream transport", () => {
  test("normalizes provider usage with cached and reasoning tokens", () => {
    expect(studioUsageFromChatUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 15 },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 15,
      cachedTokens: 25,
      totalTokens: 140,
      source: "provider",
    });
  });

  test("parses chunked SSE text, reasoning, usage, and done frames", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"thinking"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n',
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const onText = vi.fn();
    const onReasoning = vi.fn();
    const onUsage = vi.fn();
    const onFirstToken = vi.fn();

    await streamModelStudioChat(
      { model: "openai/gpt-5", messages: [], maxTokens: 128 },
      { onText, onReasoning, onUsage, onFirstToken },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith("/console/api/model-studio/chat", expect.objectContaining({ method: "POST" }));
    expect(onText).toHaveBeenCalledWith("Hello");
    expect(onReasoning).toHaveBeenCalledWith("thinking");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 2, outputTokens: 3 }));
    expect(onFirstToken).toHaveBeenCalledOnce();
  });

  test("reports a structured server error when streaming cannot start", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "model unavailable" } }), { status: 503 })));

    await expect(streamModelStudioChat(
      { model: "openai/missing", messages: [], maxTokens: 128 },
      { onText: vi.fn(), onReasoning: vi.fn(), onUsage: vi.fn(), onFirstToken: vi.fn() },
      new AbortController().signal,
    )).rejects.toThrow("model unavailable");
  });
});
