import { describe, expect, test } from "bun:test";
import {
  blockFromPart,
  groupedBlocks,
  mapStopReason,
  parseArgs,
  requireMessagesToolName,
  startModel,
  stopData,
} from "../../../src/transport/surface/messages/encode";
import type { CanonicalEvent } from "../../../src/transport/canonical-model";

/**
 * Messages wire encoding.
 *
 * These functions turn canonical content into Anthropic-shaped blocks. The
 * decisions worth pinning are the ones that are lossy or asymmetric: a tool
 * call with no name must fail rather than be renamed, a zero-argument call's
 * empty string must become `{}` and not a bare string, and a block from a
 * foreign surface must degrade away rather than be emitted as a type a strict
 * client would reject.
 */

describe("requireMessagesToolName", () => {
  test("returns a real name unchanged", () => {
    expect(requireMessagesToolName("lookup", "call-1")).toBe("lookup");
  });

  test("rejects a missing, empty, or whitespace name", () => {
    for (const name of [undefined, "", "   "]) {
      expect(() => requireMessagesToolName(name, "call-1")).toThrow(/missing a tool name/);
    }
  });

  test("the failure is an upstream transport fault carrying the call id", () => {
    try {
      requireMessagesToolName(undefined, "call-42");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "transport_unavailable",
        status: 502,
        details: { callId: "call-42", reason: "missing_tool_name" },
      });
    }
  });
});

describe("parseArgs", () => {
  test("a non-string value passes through, with undefined becoming an empty object", () => {
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs(undefined)).toEqual({});
    expect(parseArgs(null)).toEqual({});
  });

  test("an empty or whitespace string becomes an empty object", () => {
    // Anthropic requires `input` to be an object; a zero-arg call must not
    // forward "" as a bare string.
    expect(parseArgs("")).toEqual({});
    expect(parseArgs("   ")).toEqual({});
  });

  test("valid JSON is decoded and invalid JSON is preserved as-is", () => {
    expect(parseArgs('{"key":"value"}')).toEqual({ key: "value" });
    expect(parseArgs("[1,2]")).toEqual([1, 2]);
    // Unparseable arguments are kept verbatim rather than dropped.
    expect(parseArgs("{not json")).toBe("{not json");
  });
});

describe("blockFromPart", () => {
  test("maps a text part", () => {
    expect(blockFromPart({ kind: "text", text: "hello" })).toEqual({ type: "text", text: "hello" });
  });

  test("maps an image part, passing a record payload through", () => {
    const payload = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
    expect(blockFromPart({ kind: "image", payload })).toBe(payload);
  });

  test("wraps a non-record image payload in a source envelope", () => {
    expect(blockFromPart({ kind: "image", payload: "opaque" })).toEqual({
      type: "image",
      source: "opaque",
    });
  });

  test("a file with a file_id becomes a file-source document", () => {
    expect(
      blockFromPart({
        kind: "file",
        file_id: "file-1",
        data: "ignored",
        media_type: "text/plain",
        filename: "a.txt",
      }),
    ).toEqual({
      type: "document",
      source: { type: "file", file_id: "file-1" },
      title: "a.txt",
    });
  });

  test("a file without a file_id becomes a base64 document", () => {
    expect(
      blockFromPart({ kind: "file", data: "AAA", media_type: "application/pdf" }),
    ).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "AAA" },
    });
  });

  test("a document carries its title and citations when present", () => {
    expect(
      blockFromPart({
        kind: "document",
        data: "AAA",
        media_type: "text/plain",
        title: "t.txt",
        citations: true,
      }),
    ).toEqual({
      type: "document",
      source: { type: "base64", media_type: "text/plain", data: "AAA" },
      title: "t.txt",
      citations: { enabled: true },
    });
  });

  test("maps audio and refusal parts", () => {
    expect(blockFromPart({ kind: "audio", data: "AAA", media_type: "audio/wav" })).toEqual({
      type: "audio",
      source: { type: "base64", media_type: "audio/wav", data: "AAA" },
    });
    expect(blockFromPart({ kind: "refusal", text: "no" })).toEqual({ type: "text", text: "no" });
  });

  test("a tool call decodes its arguments and carries the index", () => {
    expect(
      blockFromPart({
        kind: "toolCall",
        call_id: "c1",
        name: "lookup",
        arguments: '{"k":1}',
        index: 3,
      }),
    ).toEqual({ type: "tool_use", id: "c1", name: "lookup", input: { k: 1 }, index: 3 });
  });

  test("a tool result keeps string content and recurses into part content", () => {
    expect(
      blockFromPart({ kind: "toolResult", call_id: "c1", content: "plain" }),
    ).toEqual({ type: "tool_result", tool_use_id: "c1", content: "plain" });

    expect(
      blockFromPart({
        kind: "toolResult",
        call_id: "c1",
        content: [{ kind: "text", text: "nested" }],
        is_error: true,
      }),
    ).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: [{ type: "text", text: "nested" }],
      is_error: true,
    });
  });

  test("an opaque reasoning part becomes redacted_thinking", () => {
    expect(blockFromPart({ kind: "reasoning", payload: "sealed", opaque: true })).toEqual({
      type: "redacted_thinking",
      data: "sealed",
    });
    const payload = { type: "redacted_thinking", data: "x" };
    expect(blockFromPart({ kind: "reasoning", payload, opaque: true })).toBe(payload);
  });

  test("a visible reasoning part becomes thinking with its summary and signature", () => {
    expect(
      blockFromPart({ kind: "reasoning", payload: "raw", summary: "summary", signature: "sig" }),
    ).toEqual({ type: "thinking", thinking: "summary", signature: "sig" });
    // Without a summary the raw payload is the thinking text.
    expect(blockFromPart({ kind: "reasoning", payload: "raw" })).toEqual({
      type: "thinking",
      thinking: "raw",
    });
  });

  test("messages-native extension blocks round-trip under their native type", () => {
    const payload = { type: "server_tool_use", id: "s1" };
    expect(blockFromPart({ kind: "extension", name: "server_tool_use", payload })).toBe(payload);

    const search = { type: "search_result", content: [] };
    expect(blockFromPart({ kind: "extension", name: "search_result", payload: search })).toBe(search);

    const doc = { type: "document", source: {} };
    expect(blockFromPart({ kind: "extension", name: "document", payload: doc })).toBe(doc);

    // A newer native block type round-trips under its own name, with the
    // `messages:` prefix stripped.
    expect(
      blockFromPart({ kind: "extension", name: "messages:new_block", payload: { a: 1 } }),
    ).toEqual({ type: "new_block", a: 1 });
  });

  test("a foreign-surface extension degrades away instead of emitting an unknown type", () => {
    // A strict Anthropic client rejects a block type it does not know, so a
    // `responses:*` annotation has no Messages representation.
    expect(
      blockFromPart({ kind: "extension", name: "responses:something", payload: { a: 1 } }),
    ).toBeUndefined();
    expect(
      blockFromPart({ kind: "extension", name: "messages:unknown", payload: { a: 1 } }),
    ).toBeUndefined();
    expect(blockFromPart({ kind: "extension", name: "unknown", payload: { a: 1 } })).toBeUndefined();
  });
});

describe("mapStopReason", () => {
  test("maps each canonical stop reason to its Messages value", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_tokens");
    expect(mapStopReason("tool_use")).toBe("tool_use");
    expect(mapStopReason("content_filter")).toBe("refusal");
    expect(mapStopReason("refusal")).toBe("refusal");
    expect(mapStopReason("pause_turn")).toBe("pause_turn");
  });

  test("an error or cancellation closes the turn rather than reporting a reason", () => {
    expect(mapStopReason("error")).toBe("end_turn");
    expect(mapStopReason("cancelled")).toBe("end_turn");
  });

  test("an absent reason yields null rather than a guess", () => {
    expect(mapStopReason(undefined)).toBeNull();
  });
});

describe("groupedBlocks", () => {
  test("joins fragmented tool arguments once at flush", () => {
    // The name arrives on the deltas; `tool_call_start` is not a block source.
    const events: CanonicalEvent[] = [
      { type: "tool_call_delta", sequence_number: 0, call_id: "c1", name: "lookup", arguments_delta: '{"k":' },
      { type: "tool_call_delta", sequence_number: 1, call_id: "c1", arguments_delta: "1}" },
    ];
    const { blocks, droppedUnnamedToolCalls } = groupedBlocks(events);
    expect(droppedUnnamedToolCalls).toBe(0);
    expect(blocks).toEqual([{ type: "tool_use", id: "c1", name: "lookup", input: { k: 1 } }]);
  });

  test("counts a tool call that never received a name", () => {
    const events: CanonicalEvent[] = [
      { type: "tool_call_delta", sequence_number: 0, call_id: "c1", arguments_delta: "{}" },
    ];
    const { blocks, droppedUnnamedToolCalls } = groupedBlocks(events);
    expect(blocks).toEqual([]);
    expect(droppedUnnamedToolCalls).toBe(1);
  });

  test("merges adjacent text deltas into one block", () => {
    const events: CanonicalEvent[] = [
      { type: "content_delta", sequence_number: 0, content: { kind: "text", text: "Hel" } },
      { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "lo" } },
    ];
    expect(groupedBlocks(events).blocks).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("emits a thinking block for a reasoning delta", () => {
    const events: CanonicalEvent[] = [
      { type: "content_delta", sequence_number: 0, content: { kind: "reasoning", payload: "thinking" } },
      { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "answer" } },
    ];
    expect(groupedBlocks(events).blocks).toEqual([
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "answer" },
    ]);
  });

  test("a foreign-surface content delta degrades away instead of reaching the client", () => {
    const events: CanonicalEvent[] = [
      {
        type: "content_delta",
        sequence_number: 0,
        content: { kind: "extension", name: "responses:annotated", payload: { a: 1 } },
      },
      { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "kept" } },
    ];
    expect(groupedBlocks(events).blocks).toEqual([{ type: "text", text: "kept" }]);
  });
});

describe("startModel and stopData", () => {
  test("startModel reports the model the stream started with", () => {
    const events: CanonicalEvent[] = [
      { type: "response_start", sequence_number: 0, model: "claude-test" },
    ];
    expect(startModel(events)).toBe("claude-test");
  });

  test("startModel is undefined when no start event was seen", () => {
    expect(startModel([])).toBeUndefined();
  });

  test("stopData reports the terminal state and usage", () => {
    const events: CanonicalEvent[] = [
      {
        type: "terminal",
        sequence_number: 0,
        state: "complete",
        stop_reason: "stop",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          uncached_input_tokens: 1,
          reasoning_tokens: 0,
          estimated_cost: 0,
        },
      },
    ];
    const data = stopData(events);
    expect(data.reason).toBe("end_turn");
    expect(data.usage?.output_tokens).toBe(2);
    expect(data.failed).toBe(false);
  });

  test("stopData falls back to a separate usage event", () => {
    const usage = {
      input_tokens: 3,
      output_tokens: 4,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 3,
      reasoning_tokens: 0,
      estimated_cost: 0,
    };
    const events: CanonicalEvent[] = [
      { type: "usage", sequence_number: 0, usage },
      { type: "terminal", sequence_number: 1, state: "complete" },
    ];
    const data = stopData(events);
    expect(data.reason).toBe("end_turn");
    expect(data.usage?.output_tokens).toBe(4);
  });

  test("stopData flags a failed terminal and reports no stop reason for an incomplete one", () => {
    const failed = stopData([
      { type: "terminal", sequence_number: 0, state: "failed" },
    ]);
    expect(failed.failed).toBe(true);
    expect(failed.reason).toBeNull();

    const incomplete = stopData([{ type: "terminal", sequence_number: 0, state: "complete" }]);
    expect(incomplete.failed).toBe(false);
    expect(incomplete.reason).toBe("end_turn");
  });

  test("stopData without a terminal event has no stop reason", () => {
    const data = stopData([]);
    expect(data.reason).toBeNull();
    expect(data.usage).toBeUndefined();
  });
});
