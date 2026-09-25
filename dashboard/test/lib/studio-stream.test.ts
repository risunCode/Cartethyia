import { describe, expect, test } from "bun:test";
import {
  applyChatFrame,
  createChatStreamAccumulator,
  formatStudioMs,
  splitSseFrames,
} from "../../src/lib/studio-stream";

describe("studio SSE parsing", () => {
  test("formats durations like the meta chips", () => {
    expect(formatStudioMs(6479)).toBe("6.5s");
    expect(formatStudioMs(129)).toBe("129ms");
    expect(formatStudioMs(Number.NaN)).toBe("—");
  });
  test("splits frames and keeps the partial tail", () => {
    const { frames, rest } = splitSseFrames(
      'data: {"a":1}\n\ndata: {"b":2',
    );
    expect(frames).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b":2');
  });

  test("accumulates text, reasoning, finish reason, and usage", () => {
    const acc = createChatStreamAccumulator();
    applyChatFrame(acc, '{"choices":[{"delta":{"content":"Hello"}}]}');
    applyChatFrame(acc, '{"choices":[{"delta":{"reasoning_content":"thinking"}}]}');
    applyChatFrame(
      acc,
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":2},"total_tokens":15}}',
    );
    applyChatFrame(acc, "[DONE]");
    expect(acc.text).toBe("Hello");
    expect(acc.reasoning).toBe("thinking");
    expect(acc.finishReason).toBe("stop");
    expect(acc.usage).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      total: 15,
    });
  });

  test("ignores malformed frames without throwing", () => {
    const acc = createChatStreamAccumulator();
    applyChatFrame(acc, "not json");
    applyChatFrame(acc, "");
    expect(acc.text).toBe("");
  });

  test("surfaces gateway stream error envelopes instead of swallowing them", () => {
    const acc = createChatStreamAccumulator();
    expect(() =>
      applyChatFrame(
        acc,
        '{"error":{"origin":"cartethyia","code":"transport_unavailable","message":"Cartethyia Error: upstream request failed"}}',
      ),
    ).toThrow("upstream request failed");
  });

  test("merges id-less tool fragments by wire index", () => {
    const acc = createChatStreamAccumulator();
    applyChatFrame(
      acc,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"printf","arguments":""}}]}}]}',
    );
    applyChatFrame(
      acc,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"text\\""}}]}}]}',
    );
    applyChatFrame(
      acc,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}',
    );
    expect(acc.toolCalls).toHaveLength(1);
    expect(acc.toolCalls[0]).toMatchObject({ id: "call-a", name: "printf" });
    expect(acc.toolCalls[0]?.args).toBe('{"text":"hi"}');
    expect(acc.finishReason).toBe("tool_calls");
  });

  test("keeps parallel calls on different indexes separate", () => {
    const acc = createChatStreamAccumulator();
    applyChatFrame(
      acc,
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"f","arguments":"1"}},{"index":1,"id":"b","function":{"name":"g","arguments":"2"}}]}}]}',
    );
    expect(acc.toolCalls.map((c) => [c.id, c.args])).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });
});
