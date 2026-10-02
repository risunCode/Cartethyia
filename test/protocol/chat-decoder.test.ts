/**
 * The Chat Completions response decoder: upstream wire → canonical events.
 *
 * This is where an upstream's answer becomes the gateway's answer, and it is
 * the layer that decides what an operator later reads in telemetry and what the
 * client actually receives. Four properties are worth pinning, and each is a
 * way a real answer gets corrupted:
 *
 * 1. **A stream that ends without a finish reason is truncated, not successful.**
 *    The decoder's own comment is explicit: a TCP cut must never bill as a
 *    success, or telemetry, usage, and health all record a failure as a win.
 * 2. **Tool-call fragments must be joined by identity, not by position.** OpenAI
 *    sends the id and name only on the first fragment of each call; a decoder
 *    that starts a new call per fragment turns one tool call into several
 *    phantom ones.
 * 3. **An error envelope inside a `200 OK` is an upstream failure.** Recording
 *    it only as a `failed` terminal left the client with no code at all.
 * 4. **Usage is merged, not overwritten.** Split-usage bridges send prompt
 *    tokens early and totals late; an overwrite loses the prompt count and the
 *    tenant's spend is under-reported.
 *
 * The SSE stream is fed from an in-memory `ReadableStream`, so nothing here
 * touches the network and the whole file runs in milliseconds.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeChatSseStream,
  mapChatStopReason,
  parseChatResponseToEvents,
} from "../../src/protocol/response/chat";
import { GatewayError } from "../../src/transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest, UsageRecord } from "../../src/transport/canonical-model";

/** A canonical request; the decoder reads only `model`. */
function request(overrides: { model?: string } = {}): CanonicalRequest {
  return {
    model: overrides.model ?? "gpt-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: true,
    source_surface: "chat",
  };
}

/** Wraps raw SSE text in a `ReadableStream`, optionally split across chunks. */
function sseStream(text: string, chunkSize?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = chunkSize ?? bytes.length;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** One SSE frame carrying `payload` as its `data:` line. */
function frame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of decodeChatSseStream(stream, request(), signal)) {
    events.push(event);
  }
  return events;
}

/** The single terminal event of a decoded stream. */
function terminal(events: readonly CanonicalEvent[]) {
  const found = events.filter((event) => event.type === "terminal");
  expect(found).toHaveLength(1);
  const last = found[0];
  if (last?.type !== "terminal") throw new Error("no terminal event");
  return last;
}

function usageOf(events: readonly CanonicalEvent[]): UsageRecord | undefined {
  return terminal(events).usage;
}

describe("mapChatStopReason", () => {
  test("maps the documented wire reasons", () => {
    expect(mapChatStopReason("stop")).toBe("stop");
    expect(mapChatStopReason("length")).toBe("length");
    expect(mapChatStopReason("tool_calls")).toBe("tool_use");
    expect(mapChatStopReason("content_filter")).toBe("content_filter");
  });

  test("an unrecognised reason reports undefined rather than inventing one", () => {
    // The caller keeps the raw string as `provider_stop_reason`, so a value the
    // gateway does not model is still visible in telemetry. Guessing here would
    // hide it behind a wrong canonical name.
    expect(mapChatStopReason("some_new_reason")).toBeUndefined();
    expect(mapChatStopReason("")).toBeUndefined();
    expect(mapChatStopReason(null)).toBeUndefined();
    expect(mapChatStopReason(undefined)).toBeUndefined();
    expect(mapChatStopReason(42)).toBeUndefined();
    expect(mapChatStopReason({})).toBeUndefined();
  });

  test("the mapping is case-sensitive, matching the wire spec", () => {
    // The wire values are lowercase literals; a case-insensitive match would
    // accept a malformed upstream value as if it were valid.
    expect(mapChatStopReason("STOP")).toBeUndefined();
    expect(mapChatStopReason("Stop")).toBeUndefined();
  });
});

describe("parseChatResponseToEvents — a complete JSON response", () => {
  test("emits a start, the content, and one terminal, in sequence", () => {
    const events = parseChatResponseToEvents(
      {
        id: "chatcmpl-1",
        model: "gpt-5",
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      },
      request(),
    );
    expect(events[0]?.type).toBe("response_start");
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_event, index) => index + 1),
    );
    const texts = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "text" ? [event.content.text] : [],
    );
    expect(texts).toEqual(["hello"]);
    expect(terminal(events).state).toBe("complete");
    expect(terminal(events).stop_reason).toBe("stop");
    expect(terminal(events).provider_stop_reason).toBe("stop");
  });

  test("falls back to the request model and a synthetic id when the wire omits them", () => {
    // The client must still receive a coherent response envelope; an absent id
    // would propagate as `undefined` into every downstream event.
    const events = parseChatResponseToEvents(
      { choices: [{ message: { content: "x" }, finish_reason: "stop" }] },
      request({ model: "custom-model" }),
    );
    const start = events[0];
    expect(start?.type).toBe("response_start");
    if (start?.type !== "response_start") throw new Error("no start");
    expect(start.event_id).toBe("resp_chat");
    expect(start.model).toBe("custom-model");
  });

  test("carries the system fingerprint when the upstream sends one", () => {
    const events = parseChatResponseToEvents(
      {
        id: "c1",
        model: "gpt-5",
        system_fingerprint: "fp_abc",
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
      },
      request(),
    );
    const start = events[0];
    if (start?.type !== "response_start") throw new Error("no start");
    expect(start.system_fingerprint).toBe("fp_abc");
  });

  test("a response with no choices still terminates cleanly", () => {
    // A malformed or empty upstream body must not leave the client without a
    // terminal event, which would hang the stream bridge.
    const events = parseChatResponseToEvents({ id: "c1", model: "gpt-5" }, request());
    expect(terminal(events).state).toBe("complete");
    expect(terminal(events).stop_reason).toBeUndefined();
  });

  test("a null or empty content is not emitted as an empty text delta", () => {
    // An empty text delta opens a content block downstream, fragmenting one
    // answer into alternating blocks.
    const events = parseChatResponseToEvents(
      { choices: [{ message: { content: null }, finish_reason: "stop" }] },
      request(),
    );
    const deltas = events.filter((event) => event.type === "content_delta");
    expect(deltas).toEqual([]);
  });

  test("a refusal is carried as its own part, not folded into the text", () => {
    // The surface encoder needs to distinguish a refusal from an answer; the
    // client renders them differently.
    const events = parseChatResponseToEvents(
      {
        choices: [
          { message: { content: "partial", refusal: "I cannot help with that" }, finish_reason: "stop" },
        ],
      },
      request(),
    );
    const refusals = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "refusal" ? [event.content.text] : [],
    );
    expect(refusals).toEqual(["I cannot help with that"]);
  });

  test("an audio payload rides as an extension part", () => {
    // `modalities: ["audio"]` returns audio beside the text; the Chat encoder
    // re-emits the same object, so it has to survive as a part.
    const audio = { id: "audio_1", data: "AAAA", transcript: "hi" };
    const events = parseChatResponseToEvents(
      { choices: [{ message: { content: "x", audio }, finish_reason: "stop" }] },
      request(),
    );
    const extensions = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "extension"
        ? [event.content.name]
        : [],
    );
    expect(extensions).toEqual(["audio"]);
  });

  test("readable reasoning is carried as reasoning, not as a summary", () => {
    // The decoder's comment is explicit: `reasoning_content` is the readable
    // stream (Responses `reasoning_text`), not a summary, so it belongs in
    // `payload` only. Conflating the two makes a client render thinking as
    // visible answer text.
    const events = parseChatResponseToEvents(
      {
        choices: [
          { message: { content: "x", reasoning_content: "let me think" }, finish_reason: "stop" },
        ],
      },
      request(),
    );
    const reasoning = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "reasoning" ? [event.content] : [],
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.payload).toBe("let me think");
    expect(reasoning[0]?.summary).toBeUndefined();
  });

  test("an empty reasoning string produces no reasoning part", () => {
    const events = parseChatResponseToEvents(
      { choices: [{ message: { content: "x", reasoning_content: "" }, finish_reason: "stop" }] },
      request(),
    );
    expect(events.filter((event) => event.type === "content_delta")).toHaveLength(1);
  });
});

describe("parseChatResponseToEvents — tool calls", () => {
  test("a well-formed tool call becomes one tool_call_delta", () => {
    const events = parseChatResponseToEvents(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      request(),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call_id).toBe("call_1");
    expect(calls[0]?.name).toBe("get_weather");
    expect(calls[0]?.arguments_delta).toBe('{"city":"Paris"}');
    expect(terminal(events).stop_reason).toBe("tool_use");
  });

  test("a malformed call is dropped, not emitted with an undefined identity", () => {
    // The decoder's comment: an undefined id or name downstream breaks pairing
    // and surfaces as a confusing unknown-tool error instead of a clean skip.
    const events = parseChatResponseToEvents(
      {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "no_id", arguments: "{}" } },
                { id: "call_2", function: { arguments: "{}" } },
                { id: "", function: { name: "empty_id", arguments: "{}" } },
                { id: "call_4", function: { name: "", arguments: "{}" } },
                { id: "call_5", function: { name: "ok", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      request(),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["call_5"]);
  });

  test("absent arguments become an empty object, not undefined", () => {
    // The downstream materializer parses `arguments_delta` as JSON; an
    // undefined value would fail the parse and lose the call.
    const events = parseChatResponseToEvents(
      {
        choices: [
          { message: { tool_calls: [{ id: "call_1", function: { name: "no_args" } }] }, finish_reason: "tool_calls" },
        ],
      },
      request(),
    );
    const call = events.find((event) => event.type === "tool_call_delta");
    expect(call?.arguments_delta).toBe("{}");
  });

  test("a non-object entry in tool_calls is skipped rather than throwing", () => {
    const events = parseChatResponseToEvents(
      {
        choices: [
          { message: { tool_calls: [null, "nope", 42, { id: "call_1", function: { name: "ok" } }] }, finish_reason: "tool_calls" },
        ],
      },
      request(),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls).toHaveLength(1);
  });
});

describe("parseChatResponseToEvents — usage", () => {
  test("prompt and completion tokens map onto input and output", () => {
    const events = parseChatResponseToEvents(
      {
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      },
      request(),
    );
    const usage = usageOf(events);
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.output_tokens).toBe(40);
  });

  test("an already-canonical usage block is not double-mapped", () => {
    // The decoder accepts both spellings; a bridge that already sends
    // `input_tokens` must not be read as `prompt_tokens` and lost.
    const events = parseChatResponseToEvents(
      {
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      request(),
    );
    expect(usageOf(events)?.input_tokens).toBe(7);
    expect(usageOf(events)?.output_tokens).toBe(3);
  });

  test("an absent usage block yields no usage at all", () => {
    // `undefined` means "the provider reported nothing", which the analytics
    // `partial` flag depends on. Zero would claim a measured free request.
    const events = parseChatResponseToEvents(
      { choices: [{ message: { content: "x" }, finish_reason: "stop" }] },
      request(),
    );
    expect(usageOf(events)).toBeUndefined();
  });

  test("a usage block reporting nothing yields no usage", () => {
    // `hasReportedUsage` is the gate: an empty object is not a measurement.
    const events = parseChatResponseToEvents(
      {
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: {},
      },
      request(),
    );
    expect(usageOf(events)).toBeUndefined();
  });
});

describe("decodeChatSseStream — the happy path", () => {
  test("yields a start, the deltas, and a terminal in sequence", async () => {
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "Hel" } }] }) +
          frame({ choices: [{ delta: { content: "lo" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    expect(events[0]?.type).toBe("response_start");
    const texts = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "text" ? [event.content.text] : [],
    );
    expect(texts).toEqual(["Hel", "lo"]);
    expect(terminal(events).state).toBe("complete");
    expect(terminal(events).stop_reason).toBe("stop");
    // Sequence numbers are dense and monotonic, which every downstream consumer
    // relies on for ordering.
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_event, index) => index + 1),
    );
  });

  test("a chunk split mid-frame still decodes as one event", async () => {
    // TCP delivers bytes, not frames. A decoder that assumes one chunk is one
    // frame corrupts every answer that arrives split.
    const text =
      frame({ choices: [{ delta: { content: "hello" } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      frame("[DONE]");
    // A chunk size that lands inside the JSON of the first frame.
    const events = await collect(sseStream(text, 7));
    const texts = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "text" ? [event.content.text] : [],
    );
    expect(texts).toEqual(["hello"]);
    expect(terminal(events).state).toBe("complete");
  });

  test("empty content deltas are not forwarded", async () => {
    // Keepalive frames. Forwarding them is not cosmetic: a run of empty text
    // deltas interleaved with empty reasoning deltas fragments one answer into
    // alternating text/thinking blocks.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "" } }] }) +
          frame({ choices: [{ delta: { content: "", reasoning_content: "" } }] }) +
          frame({ choices: [{ delta: { content: "real" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    const deltas = events.filter((event) => event.type === "content_delta");
    expect(deltas).toHaveLength(1);
  });

  test("[DONE] ends the stream without waiting for the body to close", async () => {
    // The comment on the check explains why: waiting deadlocks gated bridges
    // whose close depends on our terminal event. A frame after [DONE] is
    // malformed and must be ignored.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "x" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]") +
          frame({ choices: [{ delta: { content: "IGNORED" } }] }),
      ),
    );
    const texts = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "text" ? [event.content.text] : [],
    );
    expect(texts).toEqual(["x"]);
  });

  test("a blank data line and a comment line are skipped", async () => {
    const events = await collect(
      sseStream(
        ": this is a comment\n\n" +
          "data:\n\n" +
          frame({ choices: [{ delta: { content: "x" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    expect(terminal(events).state).toBe("complete");
  });
});

describe("decodeChatSseStream — truncation and failure", () => {
  test("a stream that ends with no finish reason is failed, never complete", async () => {
    // The decoder's comment: a TCP cut or an upstream that died mid-body must
    // never bill as a success, because telemetry, usage, and health would all
    // record the failure as a win.
    const events = await collect(
      sseStream(frame({ choices: [{ delta: { content: "half an ans" } }] })),
    );
    expect(terminal(events).state).toBe("failed");
    expect(terminal(events).stop_reason).toBeUndefined();
  });

  test("an explicit finish_reason of error or failed is a failed terminal", async () => {
    for (const reason of ["error", "failed"]) {
      const events = await collect(
        sseStream(
          frame({ choices: [{ delta: { content: "x" } }] }) +
            frame({ choices: [{ delta: {}, finish_reason: reason }] }),
        ),
      );
      expect(terminal(events).state).toBe("failed");
      expect(terminal(events).provider_stop_reason).toBe(reason);
    }
  });

  test("a [DONE] with no finish reason is still a truncated stream", async () => {
    // [DONE] is a transport marker, not an outcome: a bridge that closes with
    // [DONE] but never sent a finish_reason did not report success.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "x" } }] }) + frame("[DONE]"),
      ),
    );
    expect(terminal(events).state).toBe("failed");
  });

  test("an abort signal marks the terminal aborted", async () => {
    // A client that walked away is not a server failure; 499 is a different
    // outcome from 500 and the operator must be able to tell them apart.
    const controller = new AbortController();
    const text =
      frame({ choices: [{ delta: { content: "x" } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      frame("[DONE]");
    controller.abort();
    const events = await collect(sseStream(text), controller.signal);
    // An already-aborted signal returns without yielding anything, so the
    // assertion is that it does not hang or throw.
    expect(Array.isArray(events)).toBe(true);
  });

  test("malformed JSON is an upstream 502, not a client 400", async () => {
    // The comment is explicit: `invalid_request` made the client retry an
    // identical request against the same broken stream. Corrupt upstream bytes
    // are the upstream's fault.
    const failure = await collect(
      sseStream("data: {not json at all\n\ndata: [DONE]\n\n"),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(502);
    expect((failure as GatewayError).code).toBe("platform_unavailable");
    expect((failure as GatewayError).origin).toBe("upstream");
  });

  test("an error envelope inside a 200 is raised as a typed error", async () => {
    // The comment explains why: recording it only as a `failed` terminal left
    // the client with no code and telemetry with `unknown_error`.
    const failure = await collect(
      sseStream(
        frame({ error: { type: "rate_limit_error", message: "slow down" } }) + frame("[DONE]"),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
  });

  test("a top-level type:error frame is raised too", async () => {
    // The second documented shape: the frame carries the error object itself.
    const failure = await collect(
      sseStream(frame({ type: "error", message: "upstream exploded" }) + frame("[DONE]")),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
  });

  test("an error frame after real content still raises", async () => {
    // A mid-stream failure is the common case: the upstream answered, then
    // died. The partial content is not a reason to report success.
    const failure = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "partial" } }] }) +
          frame({ error: { type: "overloaded_error", message: "busy" } }),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
  });
});

describe("decodeChatSseStream — tool-call fragment joining", () => {
  test("an id-less continuation fragment joins the call at its index", async () => {
    // OpenAI streams the id and name only on the first fragment. A decoder that
    // starts a new call per fragment turns one tool call into several phantom
    // ones, which downstream surfaces render as parallel bogus calls.
    const events = await collect(
      sseStream(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } },
                ],
              },
            },
          ],
        }) +
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"' } }] } }] }) +
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }] } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    // One call id, three argument fragments.
    expect(new Set(calls.map((call) => call.call_id)).size).toBe(1);
    expect(calls.map((call) => call.arguments_delta).join("")).toBe('{"city":"Paris"}');
    // Only the establishing fragment names the call.
    expect(calls.filter((call) => call.name !== undefined)).toHaveLength(1);
  });

  test("two concurrent calls are kept apart by their wire index", async () => {
    const events = await collect(
      sseStream(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_a", function: { name: "a", arguments: "{}" } },
                  { index: 1, id: "call_b", function: { name: "b", arguments: "{}" } },
                ],
              },
            },
          ],
        }) +
          frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "more" } }] } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["call_a", "call_b", "call_b"]);
  });

  test("an omitted index falls back to the most recent call", async () => {
    // The comment: bridges that omit `index` on every fragment still have one
    // signal left — the most recent call — so that is the fallback before
    // declaring a fragment orphaned.
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "t", arguments: "{" } }] } }],
        }) +
          frame({ choices: [{ delta: { tool_calls: [{ function: { arguments: "}" } }] } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["call_1", "call_1"]);
    expect(calls.map((call) => call.arguments_delta).join("")).toBe("{}");
  });

  test("a different name at the same index starts a new call", async () => {
    // Sequential index reuse. Concatenating the two would produce one call with
    // two JSON objects glued together, which the materializer cannot parse.
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "first", arguments: "{}" } }] } }],
        }) +
          frame({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "second", arguments: "{}" } }] } }],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["call_1", "call_2"]);
    expect(calls.map((call) => call.name)).toEqual(["first", "second"]);
  });

  test("a non-integer or negative index is not used for joining", async () => {
    // The comment: only a validated integer may join fragments, otherwise
    // fragments would collapse onto call 0.
    const events = await collect(
      sseStream(
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "a", arguments: "{}" } },
                  { index: 1.5, id: "call_2", function: { name: "b", arguments: "{}" } },
                  { index: -1, id: "call_3", function: { name: "c", arguments: "{}" } },
                ],
              },
            },
          ],
        }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    // All three establish, and the two invalid indexes are not emitted.
    expect(calls.map((call) => call.call_id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(calls[1]?.index).toBeUndefined();
    expect(calls[2]?.index).toBeUndefined();
  });

  test("a restated definition under a second unknown-prefix id is suppressed", async () => {
    // The duplicate rule is narrow and worth pinning precisely, because it
    // exists for one failure: a backend delivering the *same* logical call under
    // two ids. `isDuplicateDefinition` only applies it to ids whose provider
    // prefix it does not recognise, so an id like `xyz_1` is the case that
    // actually exercises it — a `call_*` id is explicitly exempt (see the
    // sibling test) because for OpenAI-shaped ids the same name plus arguments
    // is how two legitimate parallel calls look.
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "xyz_1", function: { name: "t", arguments: '{"a":1}' } }] } }],
        }) +
          frame({
            choices: [{ delta: { tool_calls: [{ index: 1, id: "xyz_2", function: { name: "t", arguments: '{"a":1}' } }] } }],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call_id).toBe("xyz_1");
  });

  test("an empty argument list is never treated as a duplicate", async () => {
    // The comment on the `args.trim().length === 0` guard: two parallel calls to
    // the same tool both start at `arguments: ""`, and treating that as a
    // duplicate drops the second call's *name*. The client then stores
    // `function.name: ""` in its transcript and every later request is rejected
    // upstream with "`name` must be non-empty".
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "xyz_1", function: { name: "same_tool", arguments: "" } }] } }],
        }) +
          frame({
            choices: [{ delta: { tool_calls: [{ index: 1, id: "xyz_2", function: { name: "same_tool", arguments: "" } }] } }],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["xyz_1", "xyz_2"]);
    expect(calls.map((call) => call.name)).toEqual(["same_tool", "same_tool"]);
  });

  test("a second OpenAI-shaped id with the same name and arguments is NOT suppressed", async () => {
    // MEASURED: `call_*` and `fc_*` ids are explicitly exempt from the
    // name+arguments fallback, because for OpenAI-shaped ids two identical
    // parallel calls are legitimate and suppressing the second loses it. The
    // ledger's own comment names this as the Muse `name must be non-empty`
    // failure.
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "t", arguments: '{"a":1}' } }] } }],
        }) +
          frame({
            choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "t", arguments: '{"a":1}' } }] } }],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls.map((call) => call.call_id)).toEqual(["call_1", "call_2"]);
  });

  test("a repeat of the same id is a continuation, never a duplicate", async () => {
    // The comment: a repeat of the same id must always yield its delta, because
    // that is how argument fragments arrive.
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "t", arguments: '{"a"' } }] } }],
        }) +
          frame({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: ":1}" } }] } }],
          }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.arguments_delta).join("")).toBe('{"a":1}');
  });

  test("a fragment with no identity at all becomes an orphan, not a silent drop", async () => {
    // Dropping it would lose tool arguments the client is waiting for; the
    // ledger hands out a fresh id so the call still completes.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { tool_calls: [{ function: { name: "orphan", arguments: "{}" } }] } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const calls = events.flatMap((event) => (event.type === "tool_call_delta" ? [event] : []));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("orphan");
    expect(typeof calls[0]?.call_id).toBe("string");
  });

  test("a tool call with no arguments emits an empty delta", async () => {
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "t" } }] } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
          frame("[DONE]"),
      ),
    );
    const call = events.find((event) => event.type === "tool_call_delta");
    expect(call?.arguments_delta).toBe("");
  });
});

describe("decodeChatSseStream — usage merging", () => {
  test("split usage frames are merged, not overwritten", async () => {
    // The comment: split-usage bridges (xAI pattern: prompt tokens early,
    // totals late) would otherwise lose the prompt and cache counts.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 500 } }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 20, total_tokens: 520 } }) +
          frame("[DONE]"),
      ),
    );
    const usage = usageOf(events);
    expect(usage?.input_tokens).toBe(500);
    expect(usage?.output_tokens).toBe(20);
  });

  test("a usage frame carrying cached tokens keeps them", async () => {
    const events = await collect(
      sseStream(
        frame({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } },
        }) + frame("[DONE]"),
      ),
    );
    expect(usageOf(events)?.cached_input_tokens).toBe(800);
  });

  test("a stream with no usage at all reports none", async () => {
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { content: "x" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    expect(usageOf(events)).toBeUndefined();
  });
});

describe("decodeChatSseStream — reasoning deltas", () => {
  test("streamed reasoning is carried as a summary, not as raw payload", async () => {
    // The stream path is the mirror of the JSON path: a streamed reasoning
    // delta is already a summary, so it rides in `summary` with a null payload.
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { reasoning_content: "thinking..." } }] }) +
          frame({ choices: [{ delta: { content: "answer" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    const reasoning = events.flatMap((event) =>
      event.type === "content_delta" && event.content.kind === "reasoning" ? [event.content] : [],
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.summary).toBe("thinking...");
    expect(reasoning[0]?.payload).toBeNull();
  });

  test("an empty reasoning delta is dropped like an empty text delta", async () => {
    const events = await collect(
      sseStream(
        frame({ choices: [{ delta: { reasoning_content: "" } }] }) +
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          frame("[DONE]"),
      ),
    );
    expect(events.filter((event) => event.type === "content_delta")).toHaveLength(0);
  });
});

describe("decodeChatSseStream — an empty body", () => {
  test("an empty body is a truncated stream", async () => {
    // No bytes at all means no finish reason, which the decoder must classify
    // as failed rather than as an empty success.
    const events = await collect(sseStream(""));
    expect(terminal(events).state).toBe("failed");
  });
});
