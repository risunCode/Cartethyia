import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import { ToolCallTextExtractor, extractInferhubTextToolCalls } from "../../../src/providers/integrations/inferhub";
import { collect } from "../../helpers/sse-fixtures";

function textDelta(text: string, seq = 1): CanonicalEvent {
  return { type: "content_delta", sequence_number: seq, content: { kind: "text", text } };
}

function terminal(stop_reason?: "stop" | "tool_use", seq = 9): CanonicalEvent {
  return { type: "terminal", sequence_number: seq, state: "complete", ...(stop_reason ? { stop_reason } : {}) };
}

function requestWithTools(): CanonicalRequest {
  return {
    model: "inferhub/ag/claude-opus-4-6-thinking",
    messages: [],
    tools: [
      {
        name: "calculator",
        description: "math",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

async function run(events: CanonicalEvent[], request: CanonicalRequest = requestWithTools()) {
  async function* source() {
    yield* events;
  }
  return collect(extractInferhubTextToolCalls(request, source()));
}

describe("ToolCallTextExtractor", () => {
  test("extracts a block split across chunks", () => {
    const extractor = new ToolCallTextExtractor();
    const seen: string[] = [];
    let calls = 0;
    for (const chunk of [
      "Let me compute.\n<tool_",
      'call>\n{"name": "calcu',
      'lator", "arguments": {"expression": "12 * 8"}}\n</tool_',
      "call>\nDone.",
    ]) {
      const result = extractor.push(chunk);
      seen.push(result.text);
      calls += result.calls.length;
    }
    seen.push(extractor.flush().text);
    expect(seen.join("")).toBe("Let me compute.\n\nDone.");
    expect(calls).toBe(1);
  });

  test("leaves normal angle brackets alone", () => {
    const extractor = new ToolCallTextExtractor();
    const { text, calls } = extractor.push("a < b and c > d, also <<shift>>");
    expect(extractor.flush().text).toBe("");
    expect(text).toBe("a < b and c > d, also <<shift>>");
    expect(calls).toEqual([]);
  });

  test("restores unterminated and invalid blocks as prose", () => {
    const extractor = new ToolCallTextExtractor();
    const first = extractor.push('Thinking <tool_call>\n{"name": "x"');
    expect(first.text).toBe("Thinking ");
    expect(first.calls).toEqual([]);
    expect(extractor.flush().text).toBe('<tool_call>\n{"name": "x"');

    const invalid = new ToolCallTextExtractor();
    const parsed = invalid.push("A <tool_call>not json</tool_call> B");
    expect(parsed.calls).toEqual([]);
    expect(parsed.text).toBe("A <tool_call>not json</tool_call> B");
  });
});

describe("extractInferhubTextToolCalls", () => {
  test("emits tool deltas, strips text, flips terminal to tool_use", async () => {
    const events = await run([
      textDelta("I'll call it.\n<tool_call>\n", 1),
      textDelta('{"name": "calculator", "arguments": {"expression": "12 * 8"}}\n</tool_call>\nAnswer: 96.', 2),
      terminal("stop", 3),
    ]);
    const deltas = events.filter((event) => event.type === "tool_call_delta");
    expect(deltas).toMatchObject([{ call_id: "call_1", name: "calculator" }]);
    expect((deltas[0] as { arguments_delta?: string }).arguments_delta).toContain("12 * 8");
    const texts = events
      .filter((event) => event.type === "content_delta")
      .map((event) => ((event as { content: { text: string } }).content.text).toString());
    expect(texts.join("")).not.toContain("<tool_call>");
    expect(texts.join("")).toContain("Answer: 96.");
    const end = events.find((event) => event.type === "terminal");
    expect(end).toMatchObject({ stop_reason: "tool_use" });
  });

  test("passes through untouched when the request declares no tools", async () => {
    const bare = { model: "x", messages: [], generation_controls: {} } as unknown as CanonicalRequest;
    const input = [textDelta("Raw <tool_call>\n{}\n</tool_call> text.", 1), terminal("stop", 2)];
    const events = await run(input, bare);
    expect(events).toEqual(input);
  });

  test("keeps plain answers on stop without inventing calls", async () => {
    const events = await run([textDelta("Just prose, 5 < 10.", 1), terminal("stop", 2)]);
    expect(events.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(events.find((event) => event.type === "terminal")).toMatchObject({ stop_reason: "stop" });
  });
});
describe("toInferhubTextModeRequest", () => {
  const toolCallMsg = {
    role: "assistant",
    content: [{ kind: "toolCall", call_id: "call_1", name: "calculator", arguments: { expression: "1+1" } }],
  };
  const toolMsg = {
    role: "tool",
    content: [{ kind: "toolResult", call_id: "call_1", content: "2" }],
  };
  test("passes through non-ag models and tool-free history", async () => {
    const { toInferhubTextModeRequest } = await import("../../../src/providers/integrations/inferhub");
    const base = {
      model: "inferhub/ag/claude-opus-4-6-thinking",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      tools: [{ name: "calculator", description: "d", parameters: {} }],
      generation_controls: {},
    } as unknown as CanonicalRequest;
    expect(toInferhubTextModeRequest(base)).toBeUndefined();
    expect(
      toInferhubTextModeRequest({ ...base, model: "inferhub/cc/claude-opus-4-6", messages: [toolCallMsg, toolMsg] } as unknown as CanonicalRequest),
    ).toBeUndefined();
  });
  test("converts tool history to text blocks and drops structured tools", async () => {
    const { toInferhubTextModeRequest } = await import("../../../src/providers/integrations/inferhub");
    const converted = toInferhubTextModeRequest({
      model: "ag/claude-opus-4-6-thinking",
      messages: [{ role: "user", content: [{ kind: "text", text: "q" }] }, toolCallMsg, toolMsg],
      tools: [{ name: "calculator", description: "d", parameters: {} }],
      tool_choice: "auto",
      generation_controls: {},
    } as unknown as CanonicalRequest);
    expect(converted).toBeDefined();
    expect("tools" in converted!).toBe(false);
    expect("tool_choice" in converted!).toBe(false);
    const texts = converted!.messages.map((m) => ({
      role: m.role,
      text: m.content.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(""),
    }));
    expect(texts[1]!.text).toContain("<tool_call>");
    expect(texts[1]!.text).toContain('"calculator"');
    expect(texts[2]).toMatchObject({ role: "user" });
    expect(texts[2]!.text).toContain("<tool_result>");
  });
});
describe("result block dropping", () => {
  test("swallows fabricated results only when enabled", async () => {
    const { ToolCallTextExtractor } = await import("../../../src/providers/integrations/inferhub");
    const plain = new ToolCallTextExtractor();
    expect(plain.push("A <tool_result>\n99\n</tool_result> B").text).toBe("A <tool_result>\n99\n</tool_result> B");
    const dropping = new ToolCallTextExtractor(true);
    const first = dropping.push("A <tool_result>\n99\n</tool_result> B <tool_call>\n");
    expect(first.text).toBe("A  B ");
    const second = dropping.push('{"name": "f", "arguments": {}}\n</tool_call> C');
    expect(second.calls).toHaveLength(1);
    expect(second.text).toBe(" C");
    expect(dropping.flush().text).toBe("");
  });
});

