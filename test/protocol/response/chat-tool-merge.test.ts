import { describe, expect, test } from "bun:test";
import { decodeChatSseStream } from "../../../src/protocol/response/chat";
import { chatAdapter } from "../../../src/transport/surface/chat/adapter";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import { collect, streamOf } from "../../helpers/sse-fixtures";



interface DecodedToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface DecodedCompletion {
  choices: Array<{
    message: { tool_calls?: DecodedToolCall[] };
    finish_reason: string;
  }>;
}

function decodeCompletion(outputBytes: Uint8Array): DecodedCompletion {
  return JSON.parse(new TextDecoder().decode(outputBytes)) as DecodedCompletion;
}

function fakeRequest(): CanonicalRequest {
  return { model: "test-model" } as CanonicalRequest;
}


// Mirrors the live Cline/DeepSeek shape: only the first fragment of a call
// carries id+name; continuations carry bare `function.arguments` at the same
// index. Frames are built with JSON.stringify to avoid nested-escape bugs.
function toolFrame(
  calls: Array<{ index: number; id?: string; name?: string; args: string }>,
  finish: string | null = null,
): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: calls.map((c) => ({
              index: c.index,
              ...(c.id === undefined ? {} : { id: c.id }),
              type: "function",
              function: {
                ...(c.name === undefined ? {} : { name: c.name }),
                arguments: c.args,
              },
            })),
          },
          finish_reason: finish,
        },
      ],
    }) +
    "\n\n"
  );
}

const TOOL_STREAM =
  toolFrame([{ index: 0, id: "call-abc", name: "get_weather", args: "" }]) +
  toolFrame([{ index: 0, args: '{"city": ' }]) +
  toolFrame([{ index: 0, args: '"Tokyo' }]) +
  toolFrame([{ index: 0, args: '"}' }]) +
  "data: " +
  JSON.stringify({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }) +
  "\n\n" +
  "data: [DONE]\n\n";

describe("chat tool-call fragment merging", () => {
  test("id-less continuation fragments inherit the call id at the same index", async () => {
    const events = await collect(decodeChatSseStream(streamOf(TOOL_STREAM), fakeRequest()));
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBe(4);
    for (const delta of deltas) {
      expect(delta.type === "tool_call_delta" && delta.call_id).toBe("call-abc");
    }
  });

  test("materialized completion emits one merged tool call, not phantom splits", async () => {
    const events = await collect(decodeChatSseStream(streamOf(TOOL_STREAM), fakeRequest()));
    const output = chatAdapter.encode(events, { model: "test-model" });
    const body = decodeCompletion(output.bytes);
    const toolCalls = body.choices[0]?.message.tool_calls ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.function.name).toBe("get_weather");
    expect(toolCalls[0]?.function.arguments).toBe('{"city": "Tokyo"}');
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("parallel calls on different indexes stay separate", async () => {
    const parallel =
      toolFrame([{ index: 0, id: "call-1", name: "a", args: "" }]) +
      toolFrame([{ index: 1, id: "call-2", name: "b", args: "" }]) +
      toolFrame([{ index: 0, args: "1" }]) +
      toolFrame([{ index: 1, args: "2" }]) +
      toolFrame([], "tool_calls") +
      "data: [DONE]\n\n";
    const events = await collect(decodeChatSseStream(streamOf(parallel), fakeRequest()));
    const output = chatAdapter.encode(events, { model: "test-model" });
    const body = decodeCompletion(output.bytes);
    const toolCalls = body.choices[0]?.message.tool_calls ?? [];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ["call-1", "a", "1"],
      ["call-2", "b", "2"],
    ]);
  });

  test("a reused index with a different name starts a new call instead of merging", async () => {
    const stream =
      toolFrame([{ index: 0, id: "call-a", name: "get_weather", args: "" }]) +
      toolFrame([{ index: 0, args: '{"city":"x"}' }]) +
      // Same index, new name, no id: sequential reuse, not a continuation.
      toolFrame([{ index: 0, name: "get_time", args: "" }]) +
      toolFrame([{ index: 0, args: "{}" }]) +
      toolFrame([], "tool_calls") +
      "data: [DONE]\n\n";
    const events = await collect(decodeChatSseStream(streamOf(stream), fakeRequest()));
    const output = chatAdapter.encode(events, { model: "test-model" });
    const body = decodeCompletion(output.bytes);
    const toolCalls = body.choices[0]?.message.tool_calls ?? [];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: "call-a", function: { name: "get_weather" } });
    expect(toolCalls[1]?.function.name).toBe("get_time");
    expect(toolCalls[1]?.function.arguments).toBe("{}");
    expect(toolCalls[1]?.id).not.toBe("call-a");
  });

  test("index-less fragments with ids still merge by id", async () => {
    const stream =
      toolFrame([{ index: 0, id: "call-a", name: "get_weather", args: "" }]) +
      "data: " +
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ id: "call-a", function: { arguments: "1" } }] }, finish_reason: null }],
      }) +
      "\n\n" +
      toolFrame([], "tool_calls") +
      "data: [DONE]\n\n";
    const events = await collect(decodeChatSseStream(streamOf(stream), fakeRequest()));
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBe(2);
    for (const delta of deltas) {
      expect(delta.type === "tool_call_delta" && delta.call_id).toBe("call-a");
    }
  });

  test("two parallel calls sharing a name and empty args keep their own names", async () => {
    // Captured from the live Muse Spark failure: the model emits two parallel
    // `Glob` calls whose definition frames both carry `arguments: ""`. The
    // second one was collapsed onto the first, so its `name` never reached the
    // client — Claude Code stored `name: ""` in the transcript and every
    // later request was rejected upstream with
    // "`name` must be non-empty".
    const stream =
      toolFrame([{ index: 0, id: "chatcmpl-tool-bc366b86674af38d", name: "Glob", args: "" }]) +
      toolFrame([{ index: 0, args: '{"pattern": "app/src/main/java/com/mas' }]) +
      toolFrame([{ index: 0, args: 'digrab/**' }]) +
      toolFrame([{ index: 0, args: '/*.kt"}' }]) +
      toolFrame([{ index: 1, id: "chatcmpl-tool-9d7a7a81224b2c6f", name: "Glob", args: "" }]) +
      toolFrame([{ index: 1, args: '{"pattern": "app' }]) +
      toolFrame([{ index: 1, args: '/src/main/java/com' }]) +
      toolFrame([{ index: 1, args: '/android1500/**' }]) +
      toolFrame([{ index: 1, args: '/*.kt"}' }]) +
      toolFrame([], "tool_calls") +
      "data: [DONE]\n\n";
    const events = await collect(decodeChatSseStream(streamOf(stream), fakeRequest()));
    const output = chatAdapter.encode(events, { model: "test-model" });
    const toolCalls = decodeCompletion(output.bytes).choices[0]?.message.tool_calls ?? [];
    expect(toolCalls).toHaveLength(2);
    // Both calls must be named: an empty name is the bug.
    expect(toolCalls.map((c) => c.function.name)).toEqual(["Glob", "Glob"]);
    expect(toolCalls[0]?.id).toBe("chatcmpl-tool-bc366b86674af38d");
    expect(toolCalls[1]?.id).toBe("chatcmpl-tool-9d7a7a81224b2c6f");
  });

  test("a stream omitting index on every fragment still merges into the in-flight call", async () => {
    const frame = (toolCalls: unknown): string =>
      "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: null }] }) + "\n\n";
    const stream =
      frame([{ id: "call-a", type: "function", function: { name: "get_weather", arguments: "" } }]) +
      frame([{ function: { arguments: '{"city":' } }]) +
      frame([{ function: { arguments: '"x"}' } }]) +
      toolFrame([], "tool_calls") +
      "data: [DONE]\n\n";
    const events = await collect(decodeChatSseStream(streamOf(stream), fakeRequest()));
    const output = chatAdapter.encode(events, { model: "test-model" });
    const toolCalls = decodeCompletion(output.bytes).choices[0]?.message.tool_calls ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toBe("call-a");
    expect(toolCalls[0]?.function.arguments).toBe('{"city":"x"}');
  });
});
