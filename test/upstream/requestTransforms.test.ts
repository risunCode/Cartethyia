import { describe, expect, test } from "bun:test";
import { compressToolResults, injectSystemPrompt, prepareOutboundRequest } from "../../src/upstream/outbound";

const noPromptSettings = {
  rtk: { enabled: true, minChars: 500, maxReductionPercent: 35 },
  systemPrompt: undefined,
};

describe("adaptive RTK tool-result compression", () => {
  test("leaves ordinary long prose untouched because it has no recognized command-output shape", () => {
    const prose = "This is ordinary tool prose. ".repeat(100);
    const body = { messages: [{ role: "tool", content: prose }] };

    const stats = compressToolResults(body, 500, 35);

    expect(body.messages[0]!.content).toBe(prose);
    expect(stats.textBlocksCompressed).toBe(0);
  });

  test("rejects a recognized candidate when its size reduction exceeds the configured quality budget", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = { messages: [{ role: "tool", content: status }] };

    const stats = compressToolResults(body, 500, 35);

    expect(body.messages[0]!.content).toBe(status);
    expect(stats.textBlocksCompressed).toBe(0);
  });

  test("compresses a recognized git-status tool result when it stays within the configured quality budget", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = { messages: [{ role: "tool", content: status }] };

    const stats = compressToolResults(body, 500, 90);

    expect(body.messages[0]!.content).toContain("~ Modified: 80 files");
    expect(body.messages[0]!.content).toContain("... +70 more");
    expect(stats).toMatchObject({ textBlocksSeen: 1, textBlocksCompressed: 1, filters: ["git-status"] });
  });

  test("never compresses an error tool result because its full trace is diagnostic context", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", content: status, is_error: true }] }] };

    const stats = compressToolResults(body, 500, 90);

    expect(body.messages[0]!.content[0]!.content).toBe(status);
    expect(stats.textBlocksSeen).toBe(0);
  });

  test("compresses successful Anthropic tool_result blocks with the same adaptive policy", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: status }] }] };

    const stats = compressToolResults(body, 500, 90);

    expect(body.messages[0]!.content[0]!.content).toContain("~ Modified: 80 files");
    expect(stats.filters).toEqual(["git-status"]);
  });

  test("handles Responses function_call_output without touching unrelated input items", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = {
      input: [
        { type: "message", role: "user", content: "Keep this." },
        { type: "function_call_output", call_id: "call_1", output: status },
      ],
    };

    compressToolResults(body, 500, 90);

    expect(body.input[0]).toEqual({ type: "message", role: "user", content: "Keep this." });
    expect(body.input[1]!.output).toContain("~ Modified: 80 files");
  });
});

describe("configured system prompt injection", () => {
  test("appends to an existing OpenAI system message", () => {
    const body = { messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hi" }] };

    injectSystemPrompt(body, "openai", "Always cite sources.");

    expect(body.messages[0]!.content).toBe("Be concise.\n\nAlways cite sources.");
  });

  test("creates an OpenAI system message when no system or developer instruction exists", () => {
    const body = { messages: [{ role: "user", content: "Hi" }] };

    injectSystemPrompt(body, "openai", "Always cite sources.");

    expect(body.messages[0]).toEqual({ role: "system", content: "Always cite sources." });
  });

  test("appends to Responses instructions instead of synthesizing a message item", () => {
    const body = { instructions: "Be concise.", input: "Hi" };

    injectSystemPrompt(body, "openai", "Always cite sources.");

    expect(body).toEqual({ instructions: "Be concise.\n\nAlways cite sources.", input: "Hi" });
  });

  test("inserts into Anthropic system blocks before a cache breakpoint", () => {
    const body = {
      system: [
        { type: "text", text: "Stable context" },
        { type: "text", text: "Cached suffix", cache_control: { type: "ephemeral" } },
      ],
    };

    injectSystemPrompt(body, "anthropic", "Always cite sources.");

    expect(body.system.map((block) => block.text)).toEqual(["Stable context", "Always cite sources.", "Cached suffix"]);
  });

  test("prepareOutboundRequest clones before applying configured transforms", () => {
    const status = ["On branch main", ...Array.from({ length: 80 }, (_, index) => ` M src/file-${index}.ts`)].join("\n");
    const body = { messages: [{ role: "tool", content: status }] };

    const prepared = prepareOutboundRequest(body, "openai", { ...noPromptSettings, systemPrompt: "Always cite sources." });

    expect(body).toEqual({ messages: [{ role: "tool", content: status }] });
    expect(prepared).not.toBe(body);
    expect(prepared).toEqual({
      messages: [
        { role: "system", content: "Always cite sources." },
        { role: "tool", content: status },
      ],
    });
  });

  test("returns the original body without allocation when both transforms are disabled", () => {
    const body = { messages: [{ role: "user", content: "Hi" }] };

    const prepared = prepareOutboundRequest(body, "openai", {
      rtk: { enabled: false, minChars: 1_500, maxReductionPercent: 35 },
      systemPrompt: undefined,
    });

    expect(prepared).toBe(body);
  });
});
