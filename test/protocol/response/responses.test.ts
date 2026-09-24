import { describe, expect, test } from "bun:test";
import { decodeResponsesSseStream, parseResponsesResponseToEvents } from "../../../src/protocol/response/responses";
import type { CanonicalEvent, CanonicalRequest, ContentPart } from "../../../src/transport/canonical-model";
import { collect, streamOf } from "../../helpers/sse-fixtures";



function fakeRequest(): CanonicalRequest {
  return { model: "grok-4.6" } as CanonicalRequest;
}


// Recorded xAI shape: reasoning item carries encrypted_content with an
// empty summary array (xAI never emits readable thinking text).
const XAI_STREAM =
  `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc-blob"}}\n\n` +
  `data: {"type":"response.output_text.delta","delta":"done"}\n\n` +
  `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
  `data: [DONE]\n\n`;

describe("decodeResponsesSseStream terminal-envelope tool recovery", () => {
  test("a call reported only in response.completed is surfaced", async () => {
    // Backend emits no incremental frames; the call exists only on the
    // terminal envelope. Before this fallback the turn ended as a plain stop
    // and the tool call was silently lost.
    const body =
      `data: {"type":"response.completed","response":{"status":"completed","usage":{},"output":[{"type":"function_call","id":"fc_1","call_id":"call_a","name":"printf","arguments":"{\\"text\\":\\"407\\"}"}]}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      call_id: "call_a",
      name: "printf",
      arguments_delta: '{"text":"407"}',
    });
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal).toMatchObject({ stop_reason: "tool_use" });
  });

  test("two parallel calls reported only in the terminal envelope both surface", async () => {
    const body =
      `data: {"type":"response.completed","response":{"status":"completed","usage":{},"output":[` +
      `{"type":"function_call","id":"fc_1","call_id":"call_a","name":"printf","arguments":"{\\"text\\":\\"407\\"}"},` +
      `{"type":"function_call","id":"fc_2","call_id":"call_b","name":"printf","arguments":"{\\"text\\":\\"408\\"}"}]}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => (event.type === "tool_call_delta" ? event.call_id : ""))).toEqual([
      "call_a",
      "call_b",
    ]);
  });

  test("a streamed call is not re-emitted when the envelope repeats it", async () => {
    // The incremental frames already delivered call A; the terminal envelope
    // carries A again plus a sibling B that never streamed. A must appear
    // exactly once and B must be recovered.
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_a","name":"printf","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"text\\":\\"407\\"}"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{},"output":[` +
      `{"type":"function_call","id":"fc_1","call_id":"call_a","name":"printf","arguments":"{\\"text\\":\\"407\\"}"},` +
      `{"type":"function_call","id":"fc_2","call_id":"call_b","name":"printf","arguments":"{\\"text\\":\\"408\\"}"}]}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    const ids = deltas.map((event) => (event.type === "tool_call_delta" ? event.call_id : ""));
    expect(ids.filter((id) => id === "call_a")).toHaveLength(1);
    expect(ids).toContain("call_b");
  });

  test("a nameless function_call in the envelope is never emitted", async () => {
    // Emitting it would reproduce the malformed history this fix removes.
    const body =
      `data: {"type":"response.completed","response":{"status":"completed","usage":{},"output":[` +
      `{"type":"function_call","id":"fc_1","call_id":"call_a","name":"","arguments":"{\\"a\\":1}"}]}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(0);
  });

  test("an envelope without an output array is a no-op", async () => {
    const body =
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(0);
    expect(events.find((event) => event.type === "terminal")).toMatchObject({ stop_reason: "stop" });
  });
});

describe("decodeResponsesSseStream reasoning items", () => {
  test("yields encrypted reasoning parts from provider reasoning items", async () => {
    const events = await collect(decodeResponsesSseStream(streamOf(XAI_STREAM), fakeRequest()));
    const reasoning = events.filter(
      (event): event is Extract<CanonicalEvent, { type: "content_delta" }> & {
        content: { kind: "reasoning" };
      } =>
        event.type === "content_delta" &&
        (event.content as { kind?: string }).kind === "reasoning",
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.content).toMatchObject({
      kind: "reasoning",
      encrypted_content: "enc-blob",
    });
    expect(reasoning[0]?.content).not.toHaveProperty("summary");
  });

  test("preserves non-stream reasoning summary block boundaries", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp-summary",
        output: [
          {
            type: "reasoning",
            id: "rs-summary",
            summary: [
              { type: "summary_text", text: "Concise Thinking" },
              { type: "summary_text", text: "Concise Thinking2" },
            ],
          },
        ],
        status: "completed",
      } as never,
      fakeRequest(),
    );
    const summaries = events
      .filter(
        (event): event is Extract<CanonicalEvent, { type: "content_delta" }> =>
          event.type === "content_delta" && event.content.kind === "reasoning",
      )
      .map((event) => {
        const content = event.content as Extract<ContentPart, { kind: "reasoning" }>;
        return [content.summary_index, content.summary];
      });
    expect(summaries).toEqual([
      [0, "Concise Thinking"],
      [1, "Concise Thinking2"],
    ]);
  });

  test("preserves streaming reasoning summary_index", async () => {
    const body =
      `data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"Concise Thinking"}\n\n` +
      `data: {"type":"response.reasoning_summary_text.delta","summary_index":1,"delta":"Concise Thinking2"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const summaries = events
      .filter(
        (event): event is Extract<CanonicalEvent, { type: "content_delta" }> =>
          event.type === "content_delta" && event.content.kind === "reasoning",
      )
      .map((event) => {
        const content = event.content as Extract<ContentPart, { kind: "reasoning" }>;
        return [content.summary_index, content.summary];
      });
    expect(summaries).toEqual([
      [0, "Concise Thinking"],
      [1, "Concise Thinking2"],
    ]);
  });
});

describe("decodeResponsesSseStream parallel-call identity", () => {
  test("deltas without item_id resolve by output_index instead of merging", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_0","call_id":"call_a","name":"a","arguments":""}}\n\n` +
      `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_b","name":"b","arguments":""}}\n\n` +
      // Some bridges drop `item_id` but keep the output slot.
      `data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"x\\":1}"}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"y\\":2}"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(
      deltas.map((event) => (event.type === "tool_call_delta" ? [event.call_id, event.name] : null)),
    ).toEqual([
      ["call_a", "a"],
      ["call_b", "b"],
    ]);
  });

  test("two complete id-less function calls get distinct ids, not a shared literal", () => {
    const events = parseResponsesResponseToEvents(
      {
        output: [
          { type: "function_call", name: "a", arguments: "{}" },
          { type: "function_call", name: "b", arguments: "{}" },
        ],
        status: "completed",
      } as never,
      fakeRequest(),
    );
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
    const ids = deltas.map((event) =>
      event.type === "tool_call_delta" ? event.call_id : "",
    );
    expect(new Set(ids).size).toBe(2);
  });
});

describe("decodeResponsesSseStream tool-call continuity", () => {
  test("argument deltas without a matching added frame inherit the last call id", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call-1","call_id":"call-1","name":"a","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"call-1","delta":"{\\"x\\":1}"}\n\n` +
      // No `added` frame and no usable item_id: must join the in-progress
      // call, not a phantom shared one.
      `data: {"type":"response.function_call_arguments.delta","delta":"{\\"y\\":2}"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas.length).toBe(2);
    for (const delta of deltas) {
      expect(delta.type === "tool_call_delta" && delta.call_id).toBe("call-1");
    }
  });

  test("unknown event types are preserved as extension content, not dropped", async () => {
    const body =
      `data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://x.test"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const extensions = events.filter(
      (event) =>
        event.type === "content_delta" &&
        (event.content as { kind?: string }).kind === "extension",
    );
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({
      type: "content_delta",
      content: { kind: "extension", name: "responses:response.output_text.annotation.added" },
    });
  });
});

describe("decodeResponsesSseStream complete-item tool calls", () => {
  test("a function_call delivered only via output_item.done still yields the call", async () => {
    // Muse-style backend: the call never streams argument deltas; the whole
    // item arrives on `output_item.done`. Without this path the tool call is
    // lost and the turn looks like a plain stop.
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":""}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      type: "tool_call_delta",
      call_id: "call_x",
      name: "get_weather",
      arguments_delta: '{"city":"SF"}',
    });
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal).toMatchObject({ type: "terminal", stop_reason: "tool_use" });
  });

  test("function_call_arguments.done alone yields the call with full arguments", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_2","call_id":"call_y","name":"lookup","arguments":""}}\n\n` +
      // Grok sends item_id but omits call_id on arguments.done; resolve the
      // canonical call_id from the matching output_item.added frame.
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_2","arguments":"{\\"q\\":\\"hi\\"}"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      type: "tool_call_delta",
      call_id: "call_y",
      arguments_delta: '{"q":"hi"}',
    });
  });

  test("a completed item does not duplicate arguments that already streamed as deltas", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_3","call_id":"call_z","name":"f","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_3","delta":"{\\"a\\":1}"}\n\n` +
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_3","call_id":"call_z","arguments":"{\\"a\\":1}"}\n\n` +
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_3","call_id":"call_z","name":"f","arguments":"{\\"a\\":1}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ type: "tool_call_delta", call_id: "call_z" });
  });
});

describe("decodeResponsesSseStream collapses duplicate function_call items", () => {
  // Muse-family backends emit one logical call as two items with the same id
  // suffix but different prefixes (`call_<suffix>` and `fc_<suffix>`). The
  // agent must see exactly one call, otherwise it performs the action twice.
  test("the call_/fc_ pair yields one tool call, not two", async () => {
    const body =
      `data: {"type":"response.created","response":{"id":"resp_1","model":"muse"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"call_abc123","call_id":"call_abc123","name":"Write","arguments":"{\\"file_path\\":\\"/tmp/a.txt\\"}"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_abc123","call_id":"fc_abc123","name":"Write","arguments":"{\\"file_path\\":\\"/tmp/a.txt\\"}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ call_id: "call_abc123", name: "Write" });
  });

  test("genuinely distinct calls still both surface", async () => {
    const body =
      `data: {"type":"response.created","response":{"id":"resp_1","model":"muse"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"call_aaa","call_id":"call_aaa","name":"Write","arguments":"{}"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"call_bbb","call_id":"call_bbb","name":"Read","arguments":"{}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
  });

  test("distinct calls with identical name and arguments both surface", async () => {
    const body =
      `data: {"type":"response.created","response":{"id":"resp_1","model":"muse"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"call_same_a","call_id":"call_same_a","name":"Write","arguments":"{\\"path\\":\\"/tmp/same\\"}"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"call_same_b","call_id":"call_same_b","name":"Write","arguments":"{\\"path\\":\\"/tmp/same\\"}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => event.type === "tool_call_delta" ? event.call_id : "")).toEqual([
      "call_same_a",
      "call_same_b",
    ]);
  });

  test("an unknown-prefix duplicate also yields one tool call", async () => {
    // The old per-provider regex only knew `call_`/`fc_`. A backend using any
    // other prefix pair must collapse identically, or the agent acts twice.
    const body =
      `data: {"type":"response.created","response":{"id":"resp_1","model":"other"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"tool_abc","call_id":"tool_abc","name":"Write","arguments":"{\\"a\\":1}"}}\n\n` +
      `data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"xyz_abc","call_id":"xyz_abc","name":"Write","arguments":"{\\"a\\":1}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
  });

  test("output_item.done after argument deltas yields one call with full arguments", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":\\"SF\\"}"}\n\n` +
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","call_id":"call_x","arguments":"{\\"city\\":\\"SF\\"}"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      call_id: "call_x",
      name: "get_weather",
      arguments_delta: '{"city":"SF"}',
    });
  });
});

describe("decodeResponsesSseStream late tool-name recovery", () => {
  test("a name delivered only on output_item.done is recovered for streamed arguments", async () => {
    // Some bridges stream `function_call_arguments.delta` frames before any
    // frame names the call, and only reveal the name on the closing item.
    // Without recovery the surface encoder sees a nameless call carrying
    // arguments and cannot express it on the Messages wire at all.
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":\\"SF\\"}"}\n\n` +
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":"{\\"city\\":\\"SF\\"}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    // One argument delta, then one name-only recovery delta.
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ call_id: "call_x", arguments_delta: '{"city":"SF"}' });
    expect(deltas[1]).toMatchObject({
      call_id: "call_x",
      name: "get_weather",
      arguments_delta: "",
    });
  });

  test("a name already streamed in a delta is not re-emitted by output_item.done", async () => {
    const body =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":""}}\n\n` +
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{}"}\n\n` +
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_x","name":"get_weather","arguments":"{}"}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ call_id: "call_x", name: "get_weather" });
  });
});
