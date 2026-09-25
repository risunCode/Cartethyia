import { describe, expect, test } from "bun:test";
import { toWireHistory } from "../../src/routes/Studio";
import { executeStudioTool, webToolsExplicitlyRequested } from "../../src/routes/model-lab/tools";
import type { StudioMessage } from "../../src/lib/contracts";

describe("studio client tools", () => {
  test("printf echoes text, clock returns timestamps", () => {
    expect(JSON.parse(executeStudioTool("printf", '{"text":"hi"}'))).toEqual({ output: "hi" });
    expect(executeStudioTool("printf", "not json")).toContain("error");
    expect(executeStudioTool("printf", "{}")).toContain("error");
    const clock = JSON.parse(executeStudioTool("clock", "{}")) as { iso: string };
    expect(Number.isNaN(Date.parse(clock.iso))).toBe(false);
    expect(executeStudioTool("nope", "{}")).toContain("unknown tool");
  });

  test("renders Mermaid flow and sequence syntax to ASCII", () => {
    expect(
      JSON.parse(
        executeStudioTool("render_mermaid", '{"code":"flowchart LR\\n  A --> B\\n  B --> C"}'),
      ),
    ).toEqual({ ascii: "A --> B\nB --> C" });
    expect(
      JSON.parse(
        executeStudioTool("render_mermaid", '{"code":"sequenceDiagram\\n  Client->>API: fetch"}'),
      ),
    ).toEqual({ ascii: "Client -> API: fetch" });
  });

  test("only enables web fetch for explicit fetch prompts", () => {
    expect(webToolsExplicitlyRequested("Explain how TCP works")).toBe(false);
    expect(webToolsExplicitlyRequested("search latest release notes")).toBe(false);
    expect(webToolsExplicitlyRequested("fetch https://example.com/docs")).toBe(true);
  });

  test("wire history replays tool turns with fresh pairing ids", () => {
    const messages: StudioMessage[] = [
      { role: "user", content: "print hi", ts: "t0" },
      {
        role: "assistant",
        content: "done",
        ts: "t1",
        toolRounds: [
          { toolCalls: [{ name: "printf", args: '{"text":"hi"}', result: '{"output":"hi"}' }] },
        ],
      },
    ];
    const wire = toWireHistory("sys", messages);
    expect(wire[0]).toEqual({ role: "system", content: "sys" });
    expect(wire[1]).toEqual({ role: "user", content: "print hi" });
    const call = wire[2] as {
      role: string;
      tool_calls: Array<{ id: string; function: { name: string } }>;
    };
    expect(call.role).toBe("assistant");
    expect(call.tool_calls[0]?.function.name).toBe("printf");
    expect(wire[3]).toMatchObject({
      role: "tool",
      tool_call_id: call.tool_calls[0]?.id,
      content: '{"output":"hi"}',
    });
    expect(wire[4]).toEqual({
      role: "assistant",
      content: "done",
    });
  });

  test("replays sequential tool rounds as separate assistant turns", () => {
    const wire = toWireHistory("", [
      {
        role: "user",
        content: "printf 407",
        ts: "t0",
      },
      {
        role: "assistant",
        content: "407",
        ts: "t1",
        toolRounds: [
          {
            toolCalls: [
              { name: "printf", args: '{"text":"407"}', result: '{"output":"407"}' },
            ],
          },
          {
            toolCalls: [
              { name: "printf", args: '{"text":"407"}', result: '{"output":"407"}' },
            ],
          },
        ],
      },
    ]);
    expect(wire).toHaveLength(6);
    expect(wire[0]).toMatchObject({ role: "user", content: "printf 407" });
    expect(wire[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "studio-1-0-0" }] });
    expect(wire[2]).toMatchObject({ role: "tool", tool_call_id: "studio-1-0-0" });
    expect(wire[3]).toMatchObject({ role: "assistant", tool_calls: [{ id: "studio-1-1-0" }] });
    expect(wire[4]).toMatchObject({ role: "tool", tool_call_id: "studio-1-1-0" });
    expect(wire[5]).toEqual({ role: "assistant", content: "407" });
  });

  test("plain turns pass through untouched", () => {
    const wire = toWireHistory("", [{ role: "user", content: "hi", ts: "t" }]);
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });

  test("replaying the same prompt does not duplicate the user turn", () => {
    // One user message in, one user message out. A duplicated user turn makes
    // the model answer the same request once per copy — the "printf 407 four
    // times" bug.
    const messages: StudioMessage[] = [
      { role: "user", content: "printf 407", ts: "t0" },
      { role: "assistant", content: "407", ts: "t1" },
    ];
    const wire = toWireHistory("", messages);
    const userTurns = wire.filter((m) => m["role"] === "user");
    expect(userTurns).toHaveLength(1);
  });

  test("attachments ride as multimodal parts", () => {
    const wire = toWireHistory("", [
      {
        role: "user",
        content: "see this",
        ts: "t",
        attachments: [
          { kind: "image", name: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
          { kind: "file", name: "d.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
          { kind: "audio", name: "v.wav", mime: "audio/wav", dataUrl: "data:audio/wav;base64,CCC" },
        ],
      },
    ]);
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          {
            type: "file",
            file: { file_data: "BBB", filename: "d.pdf", mime_type: "application/pdf" },
          },
          { type: "input_audio", input_audio: { data: "CCC", format: "wav" } },
        ],
      },
    ]);
  });
});
