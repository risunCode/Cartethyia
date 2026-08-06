import { describe, test, expect } from "bun:test";
import { applyFilterRules, type FilterRuleConfig } from "../../src/domain/filter-rules";
import type { NormalizedProviderRequest, NormalizedMessage, NormalizedTool, ContentBlock } from "../../src/domain/contracts";

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function message(role: NormalizedMessage["role"], text: string): NormalizedMessage {
  return { role, content: [textBlock(text)] };
}

function tool(name: string, description: string): NormalizedTool {
  return { name, description, inputSchema: {} };
}

function makeRequest(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "test-model",
    messages: [message("system", "You are Claude Code, Anthropic's official CLI."), message("user", "Hello")],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 10_000_000, connectTimeoutMs: 30_000, firstByteTimeoutMs: 60_000, idleTimeoutMs: 120_000, totalTimeoutMs: 300_000 },
    ...overrides,
  };
}

const enabledConfig = (rules: FilterRuleConfig["rules"]): FilterRuleConfig => ({ enabled: true, rules });

describe("applyFilterRules", () => {
  test("returns request unchanged when disabled", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, { enabled: false, rules: [{ pattern: "Claude Code", replacement: "the assistant", isRegex: false }] });
    expect(result).toBe(req);
  });

  test("returns request unchanged when no rules", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, { enabled: true, rules: [] });
    expect(result).toBe(req);
  });

  test("returns request unchanged when no text content", () => {
    const req = makeRequest({ messages: [{ role: "user", content: [{ type: "image", image: { kind: "url", value: "x", mediaType: null } }] }] });
    const result = applyFilterRules(req, enabledConfig([{ pattern: "test", replacement: "x", isRegex: false }]));
    expect(result).toBe(req);
  });

  test("applies literal replacement to message text", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, enabledConfig([{ pattern: "Claude Code", replacement: "the assistant", isRegex: false }]));
    expect(result.messages[0]!.content[0]!.text).toBe("You are the assistant, Anthropic's official CLI.");
    expect(result.messages[1]!.content[0]!.text).toBe("Hello");
  });

  test("applies regex replacement", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, enabledConfig([{ pattern: "You are Claude Code[^.]*\\.", replacement: "", isRegex: true }]));
    expect(result.messages[0]!.content[0]!.text).toBe("");
  });

  test("applies multiple rules in order", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, enabledConfig([
      { pattern: "You are Claude Code[^.]*\\.", replacement: "[redacted]", isRegex: true },
      { pattern: "Claude Code", replacement: "the assistant", isRegex: false },
    ]));
    // First rule replaces the whole sentence, second rule has no "Claude Code" left to match
    expect(result.messages[0]!.content[0]!.text).toBe("[redacted]");
  });

  test("filters tool descriptions", () => {
    const req = makeRequest({ tools: [tool("bash", "Execute commands as Claude Code.")] });
    const result = applyFilterRules(req, enabledConfig([{ pattern: "Claude Code", replacement: "the assistant", isRegex: false }]));
    expect(result.tools[0]!.description).toBe("Execute commands as the assistant.");
  });

  test("filters reasoning content", () => {
    const req = makeRequest({ messages: [{ role: "assistant", content: [textBlock("ok")], reasoningContent: "Claude Code is thinking" }] });
    const result = applyFilterRules(req, enabledConfig([{ pattern: "Claude Code", replacement: "the assistant", isRegex: false }]));
    expect(result.messages[0]!.reasoningContent).toBe("the assistant is thinking");
  });

  test("skips invalid regex patterns silently", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, enabledConfig([
      { pattern: "[invalid", replacement: "x", isRegex: true },
      { pattern: "Claude Code", replacement: "the assistant", isRegex: false },
    ]));
    expect(result.messages[0]!.content[0]!.text).toBe("You are the assistant, Anthropic's official CLI.");
  });

  test("strips matching text with empty replacement", () => {
    const req = makeRequest();
    const result = applyFilterRules(req, enabledConfig([{ pattern: "Claude Code, ", replacement: "", isRegex: false }]));
    expect(result.messages[0]!.content[0]!.text).toBe("You are Anthropic's official CLI.");
  });

  test("returns same reference when no changes made", () => {
    const req = makeRequest({ messages: [message("user", "Hello world")] });
    const result = applyFilterRules(req, enabledConfig([{ pattern: "nonexistent", replacement: "x", isRegex: false }]));
    expect(result).toBe(req);
  });
});
