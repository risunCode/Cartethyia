import { describe, expect, test } from "bun:test";
import { applyFilterRules, compressToolResults, injectSystemPrompt, prepareOutboundRequest } from "../../src/upstream/outbound";
import type { SanitizerFilterRule } from "../../src/upstream/outbound";
import { DEFAULT_SANITIZER_RULES } from "../../src/console/default-sanitizer-rules";

const noPromptSettings = {
  rtk: { enabled: true, minChars: 500, maxReductionPercent: 35 },
  systemPrompt: undefined,
  filterRules: [],
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
      filterRules: [],
    });

    expect(prepared).toBe(body);
  });
});

describe("Filter Rules sanitizer (applyFilterRules)", () => {
  test("replaces a literal match in a message's string content", () => {
    const body = { messages: [{ role: "user", content: "I am using Claude Code today." }] };
    const rules: SanitizerFilterRule[] = [{ pattern: "Claude Code", replacement: "a CLI tool", isRegex: false }];

    applyFilterRules(body, "openai", rules);

    expect(body.messages[0]!.content).toBe("I am using a CLI tool today.");
  });

  test("applies a regex rule to the Anthropic system string", () => {
    const body: { system?: string } = { system: "You are Claude Code, Anthropic's official CLI for Claude." };
    const rules: SanitizerFilterRule[] = [{ pattern: "You are Claude Code, Anthropic's official CLI for Claude\\.", replacement: "", isRegex: true }];

    applyFilterRules(body, "anthropic", rules);

    expect(body.system).toBe("");
  });

  test("applies rules to OpenAI-shaped instructions", () => {
    const body = { instructions: "powered by Claude, the assistant." };
    const rules: SanitizerFilterRule[] = [{ pattern: "powered by (Claude|Anthropic)", replacement: "built on a model", isRegex: true }];

    applyFilterRules(body, "openai", rules);

    expect(body.instructions).toBe("built on a model, the assistant.");
  });

  test("skips a malformed rule at runtime and still applies the remaining rules", () => {
    const body = { messages: [{ role: "user", content: "remove-me keep-me" }] };
    const rules: SanitizerFilterRule[] = [
      { pattern: "(unterminated", replacement: "x", isRegex: true },
      { pattern: "remove-me ", replacement: "", isRegex: false },
    ];

    expect(() => applyFilterRules(body, "openai", rules)).not.toThrow();
    expect(body.messages[0]!.content).toBe("keep-me");
  });

  test("is a no-op with an empty rule list", () => {
    const body = { messages: [{ role: "user", content: "unchanged" }] };

    applyFilterRules(body, "openai", []);

    expect(body.messages[0]!.content).toBe("unchanged");
  });
});

// Regression: `agentic-identity` and `mcp-reference` used to be unanchored
// (`"MCP (?:server|client|protocol)[^.]*\\.?"`, matching anywhere in the
// text), so any sentence merely mentioning MCP or an "agentic"/"autonomous"
// tool got deleted wholesale, stripping legitimate tool-use instructions from
// client system prompts and breaking tool calling for MCP-style clients.
// Both rules are now anchored to a
// leading identity claim ("You are"/"Powered by"/"This is") so they only
// strip self-identification, not capability instructions.
describe("built-in Filter Rules do not eat tool-use instructions (regression)", () => {
  test("preserves an MCP protocol capability sentence with a function-use instruction", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. You have access to tools via the MCP protocol. Use the search_web function when needed.",
        },
      ],
    };

    applyFilterRules(body, "openai", DEFAULT_SANITIZER_RULES as unknown as SanitizerFilterRule[]);

    expect(body.messages[0]!.content).toBe(
      "You are a helpful assistant. You have access to tools via the MCP protocol. Use the search_web function when needed.",
    );
  });

  test("preserves an MCP server capability sentence listing available functions", () => {
    const body = {
      messages: [{ role: "system", content: "This assistant can call tools through an MCP server. Available functions: get_weather, send_email." }],
    };

    applyFilterRules(body, "openai", DEFAULT_SANITIZER_RULES as unknown as SanitizerFilterRule[]);

    expect(body.messages[0]!.content).toBe("This assistant can call tools through an MCP server. Available functions: get_weather, send_email.");
  });

  test("preserves a Model Context Protocol capability sentence", () => {
    const body = { system: "Tools are exposed through the Model Context Protocol (MCP). Call functions as needed to complete tasks." };

    applyFilterRules(body, "anthropic", DEFAULT_SANITIZER_RULES as unknown as SanitizerFilterRule[]);

    expect(body.system).toBe("Tools are exposed through the Model Context Protocol (MCP). Call functions as needed to complete tasks.");
  });

  test("still strips an actual vendor identity claim mentioning MCP", () => {
    const body = { system: "You are connected via the MCP protocol to a proprietary tool server." };

    applyFilterRules(body, "anthropic", DEFAULT_SANITIZER_RULES as unknown as SanitizerFilterRule[]);

    expect(body.system).toBe("");
  });

  test("still strips an autonomous/agentic identity claim", () => {
    const body = { system: "You are an autonomous AI agent built by SomeVendor for coding tasks." };

    applyFilterRules(body, "anthropic", DEFAULT_SANITIZER_RULES as unknown as SanitizerFilterRule[]);

    expect(body.system).toBe("");
  });
});
