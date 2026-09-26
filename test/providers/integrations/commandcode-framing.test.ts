import { describe, expect, test } from "bun:test";
import {
  buildRequest,
  ccMapFinishReason,
  convertMessages,
  transformLine,
} from "../../../src/providers/integrations/commandcode";
import type { CanonicalEvent, CanonicalMessage } from "../../../src/transport/canonical-model";

/**
 * CommandCode request framing and NDJSON stream transform.
 *
 * The provider speaks a bespoke `{threadId, config, params}` envelope with an
 * NDJSON event stream, so both directions are hand-written. The decisions worth
 * pinning are the ones that lose data or mislabel a turn: a tool result that
 * arrives on a `user` turn (the Messages ledger re-homes them) must still become
 * a `tool` message, an assistant turn that is only tool calls must carry
 * `content: null` rather than an empty string, and a stream `error` frame must
 * surface as an upstream failure rather than ending the turn quietly.
 */

function message(role: CanonicalMessage["role"], content: CanonicalMessage["content"]): CanonicalMessage {
  return { role, content } as CanonicalMessage;
}

/** Fresh per-call stream state, matching what `transformNdjson` builds. */
function streamState() {
  return {
    toolIndexById: new Map<string, number>(),
    nextToolIndex: 0,
    finishReason: undefined as string | undefined,
    usage: undefined as Record<string, unknown> | undefined,
  };
}

describe("convertMessages", () => {
  test("folds system and developer turns into one system string", () => {
    const result = convertMessages([
      message("system", [{ kind: "text", text: "be terse" }]),
      message("developer", [{ kind: "text", text: "use tools" }]),
      message("user", [{ kind: "text", text: "hi" }]),
    ]);
    expect(result.system).toBe("be terse\nuse tools");
    // System turns are lifted out of the message list entirely.
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("omits the system field when there is no system turn", () => {
    const result = convertMessages([message("user", [{ kind: "text", text: "hi" }])]);
    expect("system" in result).toBe(false);
  });

  test("an assistant turn with only tool calls carries content null, not an empty string", () => {
    const result = convertMessages([
      message("assistant", [
        { kind: "toolCall", call_id: "c1", name: "lookup", arguments: '{"k":1}' },
      ]),
    ]);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"k":1}' } }],
    });
  });

  test("an assistant turn with text and tool calls carries both", () => {
    const result = convertMessages([
      message("assistant", [
        { kind: "text", text: "checking" },
        { kind: "toolCall", call_id: "c1", name: "lookup", arguments: { k: 1 } },
      ]),
    ]);
    expect(result.messages[0]?.["content"]).toBe("checking");
    // A non-string argument object is serialized for the wire.
    expect(
      (result.messages[0]?.["tool_calls"] as Array<{ function: { arguments: string } }>)[0]?.function
        .arguments,
    ).toBe('{"k":1}');
  });

  test("an assistant turn with neither text nor calls carries an empty string", () => {
    const result = convertMessages([message("assistant", [])]);
    expect(result.messages[0]).toEqual({ role: "assistant", content: "" });
  });

  test("a tool result on a `tool` turn becomes a tool message", () => {
    const result = convertMessages([
      message("tool", [{ kind: "toolResult", call_id: "c1", content: "answer" }]),
    ]);
    expect(result.messages).toEqual([{ role: "tool", tool_call_id: "c1", content: "answer" }]);
  });

  test("a tool result on a `user` turn is still emitted as a tool message", () => {
    // The Messages ledger re-homes results onto `user` turns; checking only
    // `role: "tool"` would leave the assistant's call unanswered.
    const result = convertMessages([
      message("user", [
        { kind: "toolResult", call_id: "c1", content: "answer" },
        { kind: "text", text: "and now?" },
      ]),
    ]);
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "c1", content: "answer" },
      { role: "user", content: "and now?" },
    ]);
  });

  test("a `user` turn that was nothing but results does not emit an empty user turn", () => {
    const result = convertMessages([
      message("user", [{ kind: "toolResult", call_id: "c1", content: "answer" }]),
    ]);
    expect(result.messages).toEqual([{ role: "tool", tool_call_id: "c1", content: "answer" }]);
  });

  test("a non-string tool result content is serialized", () => {
    const result = convertMessages([
      message("tool", [
        { kind: "toolResult", call_id: "c1", content: [{ kind: "text", text: "nested" }] },
      ]),
    ]);
    expect(result.messages[0]?.["content"]).toBe('[{"kind":"text","text":"nested"}]');
  });
});

describe("buildRequest", () => {
  test("builds the bespoke envelope with defaults", () => {
    const built = buildRequest(
      "moonshotai/Kimi-K2.6",
      { messages: [message("user", [{ kind: "text", text: "hi" }])], tools: [], maxOutputTokens: null },
      "thread-1",
    );
    expect(built["threadId"]).toBe("thread-1");
    const params = built["params"] as Record<string, unknown>;
    expect(params["model"]).toBe("moonshotai/Kimi-K2.6");
    expect(params["stream"]).toBe(true);
    // The default applies when the caller did not set an output cap.
    expect(params["max_tokens"]).toBe(4096);
    expect(params["temperature"]).toBe(0.3);
    expect("tools" in params).toBe(false);
  });

  test("honors an explicit output cap and includes tools when present", () => {
    const built = buildRequest(
      "m",
      {
        messages: [message("user", [{ kind: "text", text: "hi" }])],
        tools: [{ name: "lookup", description: "looks up", jsonSchema: { type: "object" } }],
        maxOutputTokens: 123,
      },
      "thread-2",
    );
    const params = built["params"] as Record<string, unknown>;
    expect(params["max_tokens"]).toBe(123);
    expect(params["tools"]).toEqual([
      { name: "lookup", description: "looks up", input_schema: { type: "object" } },
    ]);
  });

  test("systemExtra is prepended to a system turn from the messages", () => {
    const built = buildRequest(
      "m",
      {
        messages: [
          message("system", [{ kind: "text", text: "from messages" }]),
          message("user", [{ kind: "text", text: "hi" }]),
        ],
        tools: [],
        maxOutputTokens: null,
      },
      "thread-3",
      "from caller",
    );
    expect((built["params"] as Record<string, unknown>)["system"]).toBe(
      "from caller\nfrom messages",
    );
  });

  test("systemExtra alone becomes the system field", () => {
    const built = buildRequest(
      "m",
      { messages: [message("user", [{ kind: "text", text: "hi" }])], tools: [], maxOutputTokens: null },
      "thread-4",
      "only caller",
    );
    expect((built["params"] as Record<string, unknown>)["system"]).toBe("only caller");
  });

  test("carries an empty config scaffold the provider expects", () => {
    const built = buildRequest(
      "m",
      { messages: [message("user", [{ kind: "text", text: "hi" }])], tools: [], maxOutputTokens: null },
      "thread-5",
    );
    const config = built["config"] as Record<string, unknown>;
    expect(config["isGitRepo"]).toBe(false);
    expect(config["structure"]).toEqual([]);
    expect(typeof config["date"]).toBe("string");
  });
});

describe("ccMapFinishReason", () => {
  test("maps the provider's reasons onto canonical ones", () => {
    expect(ccMapFinishReason("length")).toBe("length");
    expect(ccMapFinishReason("tool_calls")).toBe("tool_use");
    expect(ccMapFinishReason("content_filter")).toBe("content_filter");
  });

  test("any other reason is a plain stop", () => {
    expect(ccMapFinishReason("stop")).toBe("stop");
    expect(ccMapFinishReason("something_new")).toBe("stop");
  });
});

describe("transformLine", () => {
  test("a text delta becomes a content delta", () => {
    const events = transformLine('{"type":"text-delta","text":"hello"}', streamState(), 1);
    expect(events).toEqual([
      { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "hello" } },
    ]);
  });

  test("a reasoning delta is carried as text content", () => {
    const events = transformLine('{"type":"reasoning-delta","delta":"thinking"}', streamState(), 1);
    expect(events[0]).toMatchObject({ type: "content_delta", content: { kind: "text", text: "thinking" } });
  });

  test("malformed JSON and unknown frames produce nothing", () => {
    expect(transformLine("not json", streamState(), 1)).toEqual([]);
    expect(transformLine('{"no":"type"}', streamState(), 1)).toEqual([]);
    expect(transformLine('{"type":"unknown-frame"}', streamState(), 1)).toEqual([]);
  });

  test("a tool-input-start registers the call and assigns an index", () => {
    const state = streamState();
    const events = transformLine(
      '{"type":"tool-input-start","id":"c1","toolName":"lookup"}',
      state,
      1,
    );
    expect(events).toEqual([
      { type: "tool_call_delta", sequence_number: 1, call_id: "c1", name: "lookup", arguments_delta: "" },
    ]);
    expect(state.toolIndexById.get("c1")).toBe(0);
    // A repeated start for the same call is ignored, not re-indexed.
    expect(transformLine('{"type":"tool-input-start","id":"c1"}', state, 2)).toEqual([]);
  });

  test("a tool-input-delta appends arguments only for a known call", () => {
    const state = streamState();
    transformLine('{"type":"tool-input-start","id":"c1","toolName":"lookup"}', state, 1);
    expect(transformLine('{"type":"tool-input-delta","id":"c1","delta":"{\\"k\\":"}', state, 2)).toEqual([
      { type: "tool_call_delta", sequence_number: 2, call_id: "c1", arguments_delta: '{"k":' },
    ]);
    // An unknown call id is dropped rather than inventing a call.
    expect(transformLine('{"type":"tool-input-delta","id":"unknown","delta":"x"}', state, 3)).toEqual([]);
  });

  test("a tool-call frame emits the name and the serialized input", () => {
    const state = streamState();
    const events = transformLine(
      '{"type":"tool-call","toolCallId":"c2","toolName":"lookup","input":{"k":1}}',
      state,
      1,
    );
    expect(events).toEqual([
      { type: "tool_call_delta", sequence_number: 1, call_id: "c2", name: "lookup", arguments_delta: "" },
      { type: "tool_call_delta", sequence_number: 2, call_id: "c2", arguments_delta: '{"k":1}' },
    ]);
  });

  test("a tool-call with a string input passes it through unchanged", () => {
    const state = streamState();
    const events = transformLine(
      '{"type":"tool-call","toolCallId":"c3","toolName":"t","input":"{\\"a\\":1}"}',
      state,
      1,
    );
    expect(events[1]).toMatchObject({ arguments_delta: '{"a":1}' });
  });

  test("a finish-step records the reason and usage for the terminal frame", () => {
    const state = streamState();
    expect(
      transformLine(
        '{"type":"finish-step","finishReason":"tool_calls","usage":{"promptTokens":5}}',
        state,
        1,
      ),
    ).toEqual([]);
    expect(state.finishReason).toBe("tool_calls");
    expect(state.usage).toEqual({ promptTokens: 5 });
  });

  test("a finish frame emits a terminal with the recorded stop reason and usage", () => {
    const state = streamState();
    transformLine('{"type":"finish-step","finishReason":"length","usage":{"promptTokens":5,"completionTokens":7}}', state, 1);
    const events = transformLine('{"type":"finish"}', state, 2);
    expect(events).toHaveLength(1);
    const terminal = events[0] as Extract<CanonicalEvent, { type: "terminal" }>;
    expect(terminal).toMatchObject({
      type: "terminal",
      state: "complete",
      stop_reason: "length",
      provider_stop_reason: "length",
    });
    expect(terminal.usage?.input_tokens).toBe(5);
    expect(terminal.usage?.output_tokens).toBe(7);
  });

  test("a finish frame with no recorded reason defaults to a plain stop", () => {
    const events = transformLine('{"type":"finish"}', streamState(), 1);
    expect(events[0]).toMatchObject({ stop_reason: "stop", provider_stop_reason: "stop" });
  });

  test("a finish frame reads a usage total when the provider supplies one", () => {
    const state = streamState();
    transformLine(
      '{"type":"finish-step","finishReason":"stop","usage":{"promptTokens":10,"completionTokens":2,"totalTokens":99,"cachedTokens":4}}',
      state,
      1,
    );
    const terminal = transformLine('{"type":"finish"}', state, 2)[0] as Extract<
      CanonicalEvent,
      { type: "terminal" }
    >;
    expect(terminal.usage?.input_tokens).toBe(10);
    expect(terminal.usage?.output_tokens).toBe(2);
    expect(terminal.usage?.cached_input_tokens).toBe(4);
    // A cache hit cannot exceed the prompt: the usage normalizer clamps it.
    expect(terminal.usage?.uncached_input_tokens).toBe(6);
  });

  test("cached tokens are clamped to the prompt size", () => {
    const state = streamState();
    transformLine(
      '{"type":"finish-step","finishReason":"stop","usage":{"promptTokens":1,"completionTokens":2,"cachedTokens":400}}',
      state,
      1,
    );
    const terminal = transformLine('{"type":"finish"}', state, 2)[0] as Extract<
      CanonicalEvent,
      { type: "terminal" }
    >;
    expect(terminal.usage?.cached_input_tokens).toBe(1);
    expect(terminal.usage?.uncached_input_tokens).toBe(0);
  });

  test("an error frame raises an upstream gateway error", () => {
    expect(() => transformLine('{"type":"error","error":{"message":"boom"}}', streamState(), 1)).toThrow(
      /boom/,
    );
  });

  test("an error frame carrying a plain string message is surfaced verbatim", () => {
    expect(() => transformLine('{"type":"error","message":"plain failure"}', streamState(), 1)).toThrow(
      /plain failure/,
    );
  });
});
