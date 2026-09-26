import { describe, expect, test } from "bun:test";
import {
  mapResponsesStopReason,
  mergeResponsesUsage,
  parseResponsesResponseToEvents,
} from "../../../src/protocol/response/responses";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

/**
 * The non-streaming Responses path.
 *
 * `mapResponsesStopReason` and `mergeResponsesUsage` are the two decisions the
 * streaming and non-streaming decoders share. Both are pure and both have a
 * documented non-obvious rule: a stop reason must reflect whether a tool call
 * was actually emitted (not just the status), and merged usage must never let a
 * later frame's truncated cached-token count wipe a larger earlier one — a real
 * upstream shape, not a hypothetical.
 */

function fakeRequest(): CanonicalRequest {
  return { model: "grok-4.6" } as CanonicalRequest;
}

describe("mapResponsesStopReason", () => {
  test("a completed response is a stop, or a tool use when a call was emitted", () => {
    expect(mapResponsesStopReason("completed", false)).toBe("stop");
    // The status alone is not enough: a completed turn that emitted a tool call
    // must be reported as `tool_use`, or the caller never runs the tool.
    expect(mapResponsesStopReason("completed", true)).toBe("tool_use");
  });

  test("an incomplete response is a length stop", () => {
    expect(mapResponsesStopReason("incomplete", false)).toBe("length");
    expect(mapResponsesStopReason("incomplete", true)).toBe("length");
  });

  test("failed and cancelled responses are errors", () => {
    expect(mapResponsesStopReason("failed", false)).toBe("error");
    expect(mapResponsesStopReason("cancelled", false)).toBe("error");
  });

  test("an unknown or absent status yields no reason rather than a guess", () => {
    expect(mapResponsesStopReason("in_progress", false)).toBeUndefined();
    expect(mapResponsesStopReason(undefined, false)).toBeUndefined();
    expect(mapResponsesStopReason(42, false)).toBeUndefined();
  });
});

describe("mergeResponsesUsage", () => {
  test("a null or absent update leaves the current usage untouched", () => {
    const current = { input_tokens: 10 };
    expect(mergeResponsesUsage(current, undefined)).toBe(current);
    expect(mergeResponsesUsage(current, null)).toBe(current);
  });

  test("a first update with no current usage is copied", () => {
    expect(mergeResponsesUsage(undefined, { input_tokens: 5 })).toEqual({ input_tokens: 5 });
    expect(mergeResponsesUsage(null, { input_tokens: 5 })).toEqual({ input_tokens: 5 });
  });

  test("later totals win but a truncated cached count never replaces a larger one", () => {
    // The recorded upstream shape: lifecycle frames carry the real cached count,
    // the terminal frame repeats the totals with a much smaller one.
    const current = { input_tokens: 145592, input_tokens_details: { cached_tokens: 145592 } };
    const merged = mergeResponsesUsage(current, {
      input_tokens: 145600,
      input_tokens_details: { cached_tokens: 128 },
    });
    expect(merged?.["input_tokens"]).toBe(145600);
    expect((merged?.["input_tokens_details"] as { cached_tokens: number }).cached_tokens).toBe(145592);
  });

  test("a larger later cached count does win", () => {
    const merged = mergeResponsesUsage(
      { input_tokens_details: { cached_tokens: 10 } },
      { input_tokens_details: { cached_tokens: 40 } },
    );
    expect((merged?.["input_tokens_details"] as { cached_tokens: number }).cached_tokens).toBe(40);
  });

  test("a zero cached count in a later frame does not wipe an earlier hit", () => {
    const merged = mergeResponsesUsage(
      { input_tokens_details: { cached_tokens: 99 } },
      { input_tokens_details: { cached_tokens: 0 } },
    );
    expect((merged?.["input_tokens_details"] as { cached_tokens: number }).cached_tokens).toBe(99);
  });

  test("detail objects are merged rather than replaced", () => {
    const merged = mergeResponsesUsage(
      { input_tokens_details: { cached_tokens: 5, extra: "keep" } },
      { input_tokens_details: { cached_tokens: 7, other: "new" } },
    );
    expect(merged?.["input_tokens_details"]).toEqual({
      cached_tokens: 7,
      extra: "keep",
      other: "new",
    });
  });

  test("output token details merge the same way", () => {
    const merged = mergeResponsesUsage(
      { output_tokens_details: { reasoning_tokens: 3 } },
      { output_tokens_details: { reasoning_tokens: 8, extra: "x" } },
    );
    expect(merged?.["output_tokens_details"]).toEqual({ reasoning_tokens: 8, extra: "x" });
  });

  test("a plain count is carried through and undefined values are ignored", () => {
    const merged = mergeResponsesUsage(
      { output_tokens: 1 },
      { output_tokens: 2, ignored: undefined },
    );
    expect(merged?.["output_tokens"]).toBe(2);
    expect("ignored" in (merged ?? {})).toBe(false);
  });
});

describe("parseResponsesResponseToEvents", () => {
  test("parses a completed text response into start, deltas, and a terminal", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_1",
        model: "grok-4.6",
        status: "completed",
        output: [
          { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hello" }] },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      fakeRequest(),
    );
    expect(events[0]).toMatchObject({ type: "response_start", event_id: "resp_1" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "content_delta", content: { kind: "text", text: "hello" } }),
    );
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("a cancelled response terminates as aborted", () => {
    const events = parseResponsesResponseToEvents(
      { id: "resp_2", status: "cancelled", output: [] },
      fakeRequest(),
    );
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "aborted" });
  });

  test("a failed response terminates as failed", () => {
    const events = parseResponsesResponseToEvents(
      { id: "resp_3", status: "failed", output: [] },
      fakeRequest(),
    );
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "failed" });
  });

  test("a refusal part is surfaced as a refusal delta", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_4",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "cannot help" }] },
        ],
      },
      fakeRequest(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "content_delta", content: { kind: "refusal", text: "cannot help" } }),
    );
  });

  test("a function_call item is emitted as a tool call and marks the stop reason", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_5",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"k":1}',
          },
        ],
      },
      fakeRequest(),
    );
    expect(events.at(-1)).toMatchObject({ type: "terminal", stop_reason: "tool_use" });
  });

  test("an unrecognized output item is preserved as an extension", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_6",
        status: "completed",
        output: [{ type: "brand_new_item", data: 1 }],
      },
      fakeRequest(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "content_delta",
        content: expect.objectContaining({ kind: "extension", name: "responses:brand_new_item" }),
      }),
    );
  });

  test("a computer call output with an image url becomes an image part", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_7",
        status: "completed",
        output: [
          {
            type: "computer_call_output",
            call_id: "cc_1",
            output: { image_url: "https://example.test/shot.png" },
          },
        ],
      },
      fakeRequest(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        content: [{ kind: "image", payload: { type: "output_image", image_url: "https://example.test/shot.png" } }],
      }),
    );
  });

  test("a computer call output that is a plain string becomes text", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_8",
        status: "completed",
        output: [{ type: "computer_call_output", call_id: "cc_2", output: "typed answer" }],
      },
      fakeRequest(),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        content: [{ kind: "text", text: "typed answer" }],
      }),
    );
  });

  test("a reasoning item with encrypted content keeps the blob and no readable text", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_9",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "enc-blob",
          },
        ],
      },
      fakeRequest(),
    );
    // xAI never emits readable thinking text: the summary is empty, so the
    // payload is null and the encrypted blob is carried verbatim so a replaying
    // client can send it back.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "content_delta",
        item_id: "rs_1",
        content: expect.objectContaining({
          kind: "reasoning",
          payload: null,
          encrypted_content: "enc-blob",
        }),
      }),
    );
  });
});
