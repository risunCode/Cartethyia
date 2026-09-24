import { describe, expect, test } from "bun:test";

import {
  ResponsesAdapter,
} from "../../../src/transport/surface/responses/adapter";
import { ResponsesEventEncoder } from "../../../src/transport/surface/responses/encode";
import { ResponsesSequenceError } from "../../../src/transport/surface/responses/errors";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

const adapter = new ResponsesAdapter();

function usage(reasoning_tokens: number | "unavailable" = 0) {
  return {
    input_tokens: 12,
    cached_input_tokens: 4,
    cache_write_tokens: "unavailable" as const,
    uncached_input_tokens: 8,
    output_tokens: 6,
    reasoning_tokens,
    estimated_cost: 0.01,
  };
}

describe("Responses request parsing", () => {
  test("preserves typed item order, developer blocks, and tool-result IDs", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: [
        {
          type: "message",
          id: "msg-1",
          role: "developer",
          content: [{ type: "input_text", text: "developer" }],
        },
        {
          type: "function_call",
          id: "item-call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"key":"a"}',
        },
        { type: "function_call_output", id: "item-result", call_id: "call-1", output: "value" },
        {
          type: "message",
          id: "msg-2",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
      ],
    });

    expect(request.source_surface).toBe("responses");
    // Developer turns are hoisted to canonical `instructions` (Anthropic has no
    // `developer` role, and no surface should emit one upstream).
    expect(request.instructions).toEqual([{ kind: "text", text: "developer" }]);
    expect(request.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
    expect(request.messages[0]?.content[0]).toMatchObject({
      kind: "toolCall",
      call_id: "call-1",
      name: "lookup",
    });
    expect(request.messages[1]?.content[0]).toMatchObject({
      kind: "toolResult",
      call_id: "call-1",
    });

    const roundTrip = adapter.encodeRequest(request);
    expect(roundTrip.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer" }],
      },
      {
        type: "function_call",
        id: "item-call",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"key":"a"}',
      },
      { type: "function_call_output", id: "item-result", call_id: "call-1", output: "value" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "next" }],
      },
    ]);
  });

  test("normalizes reasoning, text controls, limits, tools, cache, and state fields", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: [],
      instructions: "Do not reveal hidden reasoning.",
      max_output_tokens: 256,
      max_tool_calls: 2,
      truncation: "auto",
      parallel_tool_calls: false,
      tool_choice: { type: "function", name: "lookup" },
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Find a value",
          parameters: { type: "object" },
          strict: true,
        },
      ],
      reasoning: { effort: "high", mode: "pro", summary: "concise", context: "all_turns" },
      text: {
        format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true },
        verbosity: "low",
      },
      previous_response_id: "resp-1",
      conversation: "conv-1",
      store: false,
      prompt_cache_key: "stable-key",
      prompt_cache_retention: "24h",
      include: [],
      background: true,
      stream: false,
      service_tier: "priority",
      stream_options: { include_usage: true },
      top_logprobs: 3,
      moderation: "auto",
      safety_identifier: "safe-1",
    });

    expect(request.instructions).toEqual([
      { kind: "text", text: "Do not reveal hidden reasoning." },
    ]);
    expect(request.reasoning).toMatchObject({
      effort: "high",
      mode: "pro",
      summary_mode: "concise",
      context: "all_turns",
    });
    expect(request.response_format).toMatchObject({ type: "json_schema", strict: true });
    expect(request.generation_controls).toMatchObject({
      max_output_tokens: 256,
      parallel_tool_calls: false,
      service_tier: "priority",
      "extension:responses.max_tool_calls": 2,
      "extension:responses.truncation": "auto",
      "extension:responses.include": [],
      "extension:responses.store": false,
      "extension:responses.background": true,
      "extension:responses.verbosity": "low",
      "extension:responses.stream_options": { include_usage: true },
      "extension:responses.top_logprobs": 3,
      "extension:responses.moderation": "auto",
      "extension:responses.safety_identifier": "safe-1",
    });
    expect(request.tool_choice).toEqual({ type: "tool", name: "lookup" });
    expect(request.cache_hint).toBe("stable_prefix");
  });

  test("forwards store/background/cache/moderation/stream options on the Responses wire", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: [{ type: "message", role: "user", content: "hi" }],
      store: false,
      background: true,
      truncation: "auto",
      max_tool_calls: 2,
      include: [],
      prompt_cache_retention: "24h",
      stream_options: { include_usage: true },
      top_logprobs: 3,
      moderation: "auto",
      safety_identifier: "safe-1",
      user: "user-1",
    });
    const payload = canonicalToResponsesPayload(request);
    expect(payload["store"]).toBe(false);
    expect(payload["background"]).toBe(true);
    expect(payload["truncation"]).toBe("auto");
    expect(payload["max_tool_calls"]).toBe(2);
    expect(payload["include"]).toEqual([]);
    expect(payload["prompt_cache_retention"]).toBe("24h");
    expect(payload["stream_options"]).toEqual({ include_usage: true });
    expect(payload["top_logprobs"]).toBe(3);
    expect(payload["moderation"]).toBe("auto");
    expect(payload["safety_identifier"]).toBe("safe-1");
    expect(payload["user"]).toBe("user-1");
  });

  test("forwards prompt templates, context management, and nested text config", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: "hi",
      prompt: { id: "pt-1", version: "v1", variables: { topic: "cats" } },
      context_management: [{ type: "compaction", compact_threshold: 500 }],
      text: { verbosity: "low", format: { type: "json_object" } },
    });
    const payload = canonicalToResponsesPayload(request);
    expect(payload["prompt"]).toEqual({
      id: "pt-1",
      version: "v1",
      variables: { topic: "cats" },
    });
    expect(payload["context_management"]).toEqual([
      { type: "compaction", compact_threshold: 500 },
    ]);
    expect(payload["text"]).toEqual({ verbosity: "low", format: { type: "json_object" } });
  });

  test("preserves native tool declarations as opaque provider tools", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: [],
      tools: [
        { type: "web_search_preview", user_location: { type: "approximate", country: "ID" } },
        { type: "code_interpreter", container: { type: "auto" } },
        { type: "mcp", server_label: "docs", server_url: "https://example.test/mcp" },
      ],
    });
    expect(request.tools).toEqual([
      {
        name: "web_search_preview",
        jsonSchema: { type: "web_search_preview", user_location: { type: "approximate", country: "ID" } },
        tool_type: "web_search",
      },
      { name: "code_interpreter", jsonSchema: { type: "code_interpreter", container: { type: "auto" } }, tool_type: "code_execution" },
      { name: "mcp", jsonSchema: { type: "mcp", server_label: "docs", server_url: "https://example.test/mcp" }, tool_type: "mcp" },
    ]);
  });

  test("distinguishes omitted, false, and empty options", () => {
    const omitted = adapter.parse({ model: "m", input: [] });
    const explicit = adapter.parse({
      model: "m",
      input: [],
      stream: false,
      include: [],
      store: false,
    });
    // `stream` is a canonical transport field, so an omitted value and an
    // explicit `false` both parse to a non-streaming request; only the
    // passthrough options keep the omitted/explicit distinction.
    expect(omitted.stream).toBe(false);
    expect(explicit.stream).toBe(false);
    expect(explicit.generation_controls["extension:responses.include"]).toEqual([]);
    expect(explicit.generation_controls["extension:responses.store"]).toBe(false);
  });
});

describe("Responses event lifecycle", () => {
  test("emits ordered item/content lifecycles, repeated deltas, usage, and one terminal", () => {
    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "hel" } },
      { type: "content_delta", sequence_number: 3, content: { kind: "text", text: "lo" } },
      {
        type: "tool_call_delta",
        sequence_number: 4,
        call_id: "call-1",
        name: "lookup",
        arguments_delta: '{"key":',
      },
      { type: "tool_call_delta", sequence_number: 5, call_id: "call-1", arguments_delta: '"a"}' },
      { type: "usage", sequence_number: 6, usage: usage(4) },
      { type: "terminal", sequence_number: 7, state: "complete" },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      // Done events fire at finalization (tool result / terminal), never on
      // a switch: interleaved parallel streams resume parked items instead
      // of forking duplicates.
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events.at(-1)?.response).toMatchObject({
      usage: { input_tokens: 12, reasoning_tokens: 4 },
    });
    const messageDone = events.find(
      (event) =>
        event.type === "response.output_item.done" &&
        (event.item as Record<string, unknown>)?.["type"] === "message",
    );
    expect(messageDone?.item).toMatchObject({ type: "message", content: [{ text: "hello" }] });
  });

  test("keeps interleaved parallel tool calls on separate items", () => {
    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      { type: "tool_call_delta", sequence_number: 2, call_id: "call-a", name: "alpha", arguments_delta: '{"x":' },
      { type: "tool_call_delta", sequence_number: 3, call_id: "call-b", name: "beta", arguments_delta: '{"y":' },
      { type: "tool_call_delta", sequence_number: 4, call_id: "call-a", arguments_delta: "1}" },
      { type: "tool_call_delta", sequence_number: 5, call_id: "call-b", arguments_delta: "2}" },
      { type: "terminal", sequence_number: 6, state: "complete" },
    ]);

    const added = events.filter((event) => event.type === "response.output_item.added");
    // Exactly one item per call: no duplicates from switching back and forth.
    expect(added).toHaveLength(2);
    const done = events.filter((event) => event.type === "response.output_item.done");
    expect(done).toHaveLength(2);
    const byCall = new Map(
      done.map((event) => [(event.item as Record<string, unknown>)["call_id"], event.item]),
    );
    expect(byCall.get("call-a")).toMatchObject({ arguments: '{"x":1}' });
    expect(byCall.get("call-b")).toMatchObject({ arguments: '{"y":2}' });
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
  });

  test("supports visible reasoning summaries and incomplete/failed terminal states", () => {
    const encoder = new ResponsesEventEncoder({ model: "m" });
    const reasoningEvents = encoder.push({
      type: "content_delta",
      sequence_number: 1,
      content: { kind: "reasoning", payload: null, summary: "brief" },
    });
    const incomplete = encoder.push({
      type: "terminal",
      sequence_number: 2,
      state: "aborted",
      stop_reason: "cancelled",
    });
    expect(incomplete.at(-1)?.type).toBe("response.incomplete");
    const reasoningTypes = reasoningEvents.map((event) => event.type);
    // The summary part opens before its first delta, per the Responses wire.
    expect(reasoningTypes.indexOf("response.reasoning_summary_part.added")).toBeLessThan(
      reasoningTypes.indexOf("response.reasoning_summary_text.delta"),
    );
    expect(
      reasoningEvents.find((event) => event.type === "response.reasoning_summary_text.delta")
        ?.delta,
    ).toBe("brief");

    const failed = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      { type: "terminal", sequence_number: 2, state: "failed", stop_reason: "error" },
    ]);
    expect(failed.at(-1)?.type).toBe("response.failed");
  });

  test("surfaces readable reasoning payload as reasoning_text content", () => {
    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "reasoning", payload: "Step 1: think\n\nStep 2: verify" },
      },
      { type: "terminal", sequence_number: 3, state: "complete" },
    ]);
    expect(
      events.find((event) => event.type === "response.reasoning_text.delta")?.delta,
    ).toBe("Step 1: think\n\nStep 2: verify");
    const response = events.at(-1)?.response as Record<string, unknown> | undefined;
    const output = response?.["output"] as Array<Record<string, unknown>> | undefined;
    const reasoningItem = output?.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "Step 1: think\n\nStep 2: verify" }],
    });
  });

  test("round-trips computer calls and outputs with types and ids", () => {
    const request = adapter.parse({
      model: "responses-model",
      input: [
        {
          type: "computer_call",
          id: "cc-1",
          call_id: "call-cc-1",
          action: { type: "screenshot" },
        },
        {
          type: "computer_call_output",
          id: "cco-1",
          call_id: "call-cc-1",
          output: { type: "computer_screenshot", image_url: "https://img.test/s.png" },
        },
      ],
    });
    const input = canonicalToResponsesPayload(request)["input"] as Array<Record<string, unknown>>;
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "computer_call",
        id: "cc-1",
        call_id: "call-cc-1",
        actions: [{ type: "screenshot" }],
      }),
    );
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "computer_call_output",
        id: "cco-1",
        call_id: "call-cc-1",
        output: { type: "computer_screenshot", image_url: "https://img.test/s.png" },
      }),
    );
  });

  test("maps incomplete and completed terminal reasons to Responses fields", () => {
    const incomplete = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      { type: "terminal", sequence_number: 2, state: "aborted", stop_reason: "length" },
    ]);
    expect(incomplete.at(-1)?.response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });

    const complete = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      { type: "terminal", sequence_number: 2, state: "complete", stop_reason: "length" },
    ]);
    expect(complete.at(-1)?.response).toMatchObject({ status: "completed" });
    expect(complete.at(-1)?.response).not.toHaveProperty("incomplete_details");
  });

  test("retains streamed output images in the completed output item", () => {
    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "content_delta",
        sequence_number: 2,
        content: { kind: "image", payload: { source: "image-data" } },
      },
      { type: "terminal", sequence_number: 3, state: "complete" },
    ]);
    const done = events.find((event) => event.type === "response.output_item.done");
    expect(done?.item).toMatchObject({
      type: "message",
      content: [{ type: "output_image", image: { source: "image-data" } }],
    });
  });

  test("rejects non-monotonic input and terminal duplication", () => {
    const encoder = new ResponsesEventEncoder();
    encoder.push({ type: "response_start", sequence_number: 2, model: "m" });
    expect(() => encoder.push({ type: "keepalive", sequence_number: 2 })).toThrow(
      ResponsesSequenceError,
    );

    const terminal = new ResponsesEventEncoder();
    terminal.push({ type: "response_start", sequence_number: 1, model: "m" });
    terminal.push({ type: "terminal", sequence_number: 2, state: "complete" });
    expect(() =>
      terminal.push({ type: "terminal", sequence_number: 3, state: "failed" }),
    ).toThrow();
  });
});

describe("opaque encrypted reasoning", () => {
  test("relays a sentinel byte-for-byte through the next-turn item", () => {
    const sentinel = "QmFzZTY0LXNlbnNpdGl2ZS0AAf8=";
    const request = adapter.parse({
      model: "m",
      input: [{ type: "reasoning", id: "reason-1", encrypted_content: sentinel }],
      include: ["reasoning.encrypted_content"],
      store: false,
    });
    const nextTurn = adapter.encodeRequest(request);
    const input = nextTurn.input;
    if (!Array.isArray(input)) throw new Error("next turn input must be an array");
    const first = input[0];
    if (first === null || typeof first !== "object")
      throw new Error("next turn reasoning item missing");
    expect(first["encrypted_content"]).toBe(sentinel);
    const reparsed = adapter.parse(nextTurn);
    expect(reparsed.messages[0]?.content[0]).toMatchObject({
      encrypted_content: sentinel,
      payload: sentinel,
      opaque: true,
    });
  });

  test("preserves encrypted reasoning without unrelated include/store requirements", () => {
    const body = {
      model: "m",
      input: [{ type: "reasoning", encrypted_content: "opaque" }],
      store: false,
    };
    expect(adapter.parse(body).messages[0]?.content[0]).toMatchObject({
      encrypted_content: "opaque",
      opaque: true,
    });
  });

  test("retains stateful continuation and scalar request metadata", () => {
    const request = adapter.parse({
      model: "m",
      input: "continue",
      previous_response_id: "resp-1",
      conversation: "conv-1",
      metadata: { tenant: "alpha", attempt: 2, dry_run: false },
    });
    expect(request.conversation).toEqual({
      previous_response_id: "resp-1",
      conversation_id: "conv-1",
    });
    expect(request.metadata).toEqual({ tenant: "alpha", attempt: 2, dry_run: false });
    expect(adapter.parse({ model: "m", input: [], reasoning_level: "low" }).reasoning).toEqual({
      effort: "low",
    });
  });
});

describe("cross-surface infected-session degradation", () => {
  test("partitions mixed assistant turns and drops provider-native extensions", () => {
    const request = {
      model: "target-model",
      source_surface: "responses",
      stream: false,
      generation_controls: {},
      messages: [
        {
          role: "assistant",
          content: [
            { kind: "reasoning", payload: "enc", opaque: true, encrypted_content: "enc" },
            { kind: "text", text: "let me look that up" },
            { kind: "toolCall", call_id: "call-1", name: "read_file", arguments: "{}" },
          ],
        },
        {
          role: "tool",
          content: [{ kind: "toolResult", call_id: "call-1", content: "done" }],
        },
        {
          role: "user",
          content: [
            { kind: "text", text: "next" },
            { kind: "extension", name: "server_tool_use", payload: { type: "server_tool_use", id: "srv-1" } },
          ],
        },
      ],
    } as unknown as CanonicalRequest;

    const encoded = adapter.encodeRequest(request);
    const input = encoded.input;
    expect(Array.isArray(input)).toBe(true);
    const items = input as Array<Record<string, unknown>>;
    expect(items.map((item) => item["type"])).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);

    const lastMessage = items.at(-1) as Record<string, unknown>;
    const blocks = lastMessage["content"] as Array<Record<string, unknown>>;
    // The `extension` part has no Responses representation: it degrades away
    // instead of being JSON-stringified into a garbled input_text block.
    expect(blocks).toEqual([{ type: "input_text", text: "next" }]);
  });

  test("never serializes content parts as JSON text", () => {
    const request = {
      model: "target-model",
      source_surface: "responses",
      stream: false,
      generation_controls: {},
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "open this" },
            { kind: "file", data: "raw-bytes", media_type: "text/plain", filename: "a.txt" },
          ],
        },
      ],
    } as unknown as CanonicalRequest;

    const encoded = adapter.encodeRequest(request);
    const input = encoded.input as Array<Record<string, unknown>>;
    const message = input[0] as Record<string, unknown>;
    const blocks = message["content"] as Array<Record<string, unknown>>;
    // The Responses `input_file` block has no `mime_type` field on the wire;
    // `media_type` is intentionally not forwarded (it would be rejected).
    expect(blocks).toEqual([
      { type: "input_text", text: "open this" },
      { type: "input_file", file_data: "raw-bytes", filename: "a.txt" },
    ]);
    for (const block of blocks) {
      if (block["type"] === "input_text" || block["type"] === "output_text") {
        expect(String(block["text"]).startsWith('{"kind"')).toBe(false);
      }
    }
  });
});

describe("Responses guards and validated fields", () => {
  test("filters include to documented values and rejects non-arrays", () => {
    const request = adapter.parse({
      model: "m",
      input: [],
      include: ["reasoning.encrypted_content", "bogus.include"],
    });
    expect(request.generation_controls["extension:responses.include"]).toEqual([
      "reasoning.encrypted_content",
    ]);
    expect(() =>
      adapter.parse({ model: "m", input: [], include: "reasoning.encrypted_content" }),
    ).toThrow();
  });

  test("rejects explicit prompt-cache fields the route does not support", () => {
    expect(() =>
      adapter.parse({ model: "m", input: [], prompt_cache_options: { mode: "explicit" } }),
    ).toThrow();
    expect(() =>
      adapter.parse({
        model: "m",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "x", prompt_cache_breakpoint: true }],
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps valid service tiers and reasoning efforts, drops invalid ones", () => {
    const valid = adapter.parse({
      model: "m",
      input: [],
      service_tier: "flex",
      reasoning_effort: "minimal",
    });
    expect(valid.generation_controls.service_tier).toBe("flex");
    expect(valid.reasoning).toEqual({ effort: "minimal" });

    const invalid = adapter.parse({
      model: "m",
      input: [],
      service_tier: "turbo",
      reasoning_effort: "ultra",
    });
    expect(invalid.generation_controls.service_tier).toBeUndefined();
    expect(invalid.reasoning).toBeUndefined();
  });
});

describe("Responses computer use", () => {
  test("parses computer actions and screenshots, then round-trips them", () => {
    const request = adapter.parse({
      model: "m",
      input: [
        {
          type: "computer_call",
          id: "cc-item",
          call_id: "cc-1",
          action: { type: "screenshot" },
          pending_safety_checks: [{ id: "s1", code: "malicious" }],
        },
        {
          type: "computer_call_output",
          call_id: "cc-1",
          output: { type: "computer_screenshot", image_url: "data:image/png;base64,BBBB" },
        },
      ],
    });

    expect(request.messages[0]?.content[0]).toMatchObject({
      kind: "toolCall",
      call_id: "cc-1",
      name: "computer",
      call_kind: "computer",
    });
    expect(request.messages[1]?.content[0]).toMatchObject({
      kind: "toolResult",
      call_id: "cc-1",
      call_kind: "computer",
    });

    const items = adapter.encodeRequest(request).input as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      type: "computer_call",
      call_id: "cc-1",
      actions: [{ type: "screenshot" }],
      pending_safety_checks: [{ id: "s1", code: "malicious" }],
    });
    expect(items[1]).toMatchObject({
      type: "computer_call_output",
      call_id: "cc-1",
      output: { type: "computer_screenshot", image_url: "data:image/png;base64,BBBB" },
    });
  });

  test("rejects unknown computer action types", () => {
    expect(() =>
      adapter.parse({
        model: "m",
        input: [{ type: "computer_call", call_id: "cc-1", actions: [{ type: "explode" }] }],
      }),
    ).toThrow();
  });

  test("encodes streamed computer calls as computer_call items without argument deltas", () => {
    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "m" },
      {
        type: "tool_call_delta",
        sequence_number: 2,
        call_id: "call-1",
        name: "computer",
        arguments_delta: JSON.stringify({
          actions: [{ type: "click", button: "left", x: 10, y: 20 }],
        }),
      },
      {
        type: "tool_result",
        sequence_number: 3,
        call_id: "call-1",
        content: [
          { kind: "image", payload: { type: "output_image", image_url: "data:image/png;base64,AAAA" } },
        ],
      },
      { type: "terminal", sequence_number: 4, state: "complete" },
    ]);

    expect(events.map((event) => event.type)).not.toContain(
      "response.function_call_arguments.delta",
    );
    const added = events.find((event) => event.type === "response.output_item.added");
    expect(added?.item).toMatchObject({ type: "computer_call", call_id: "call-1", actions: [] });

    const doneItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item);
    expect(doneItems[0]).toMatchObject({
      type: "computer_call",
      actions: [{ type: "click", button: "left", x: 10, y: 20 }],
    });
    expect(doneItems[1]).toMatchObject({
      type: "computer_call_output",
      output: { type: "computer_screenshot", image_url: "data:image/png;base64,AAAA" },
    });
  });
});

describe("Responses assistant phase signatures", () => {
  test("preserves assistant phase and message identity across a round trip", () => {
    const request = adapter.parse({
      model: "m",
      input: [
        {
          type: "message",
          id: "msg-9",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    });
    expect(request.messages[0]?.phase).toBe("final_answer");

    const item = (adapter.encodeRequest(request).input as Array<Record<string, unknown>>)[0];
    expect(item).toMatchObject({ type: "message", phase: "final_answer" });
  });
});

import { unwrapBody } from "../../../src/transport/surface/responses/parse";

describe("unwrapBody", () => {
  test("unwraps an adapter envelope carrying body+headers", () => {
    expect(unwrapBody({ body: '{"a":1}', headers: {}, path: "/v1/responses" })).toEqual({ a: 1 });
  });

  test("parses a raw JSON string body", () => {
    expect(unwrapBody('{"b":2}')).toEqual({ b: 2 });
  });

  test("decodes a Uint8Array body", () => {
    const bytes = new TextEncoder().encode('{"c":3}');
    expect(unwrapBody(bytes)).toEqual({ c: 3 });
  });

  test("passes a plain object through", () => {
    const body = { d: 4 };
    expect(unwrapBody(body)).toBe(body);
  });
});
