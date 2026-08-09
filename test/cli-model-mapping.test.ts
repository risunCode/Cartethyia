import { describe, expect, test } from "bun:test";
import { claudeInjector } from "../src/console/cli-tools/injectors/claude";
import { codexInjector } from "../src/console/cli-tools/injectors/codex";
import { cliToolIdForClient, resolveCliModelMapping, type CliModelMappingSnapshot } from "../src/application/cli-model-mapping";
import type { ApplyInput } from "../src/console/cli-tools/types";
import { detectClient, type ClientIdentity } from "../src/application/contracts";

const claude: ClientIdentity = { name: "claude_code", source: "user_agent" };
const codex: ClientIdentity = { name: "codex", source: "protocol_header" };
const unknown: ClientIdentity = { name: "unknown", source: "unknown" };

function mappings(toolId: string, enabled: boolean): ReadonlyMap<string, CliModelMappingSnapshot> {
  return new Map([
    [toolId, {
      enabled,
      entries: [
        { sourceModel: "claude/claude-opus-4-8", targetModel: "openai/gpt-5.5", enabled: true },
        { sourceModel: "gpt-5.1", targetModel: "openai/o4-mini", enabled: false },
      ],
    }],
  ]);
}

describe("CLI model mapping", () => {
  test("maps only the detected CLI's exact enabled native slot", () => {
    expect(resolveCliModelMapping(claude, "claude/claude-opus-4-8", mappings("claude", true))).toBe("openai/gpt-5.5");
    expect(resolveCliModelMapping(codex, "claude/claude-opus-4-8", mappings("claude", true))).toBe("claude/claude-opus-4-8");
  });

  test("does not map disabled settings, disabled entries, or unknown clients", () => {
    expect(resolveCliModelMapping(claude, "claude/claude-opus-4-8", mappings("claude", false))).toBe("claude/claude-opus-4-8");
    expect(resolveCliModelMapping(claude, "gpt-5.1", mappings("claude", true))).toBe("gpt-5.1");
    expect(resolveCliModelMapping(unknown, "claude/claude-opus-4-8", mappings("claude", true))).toBe("claude/claude-opus-4-8");
  });

  test("detects the current Claude CLI user agent for model mapping", () => {
    const client = detectClient(new Headers({ "user-agent": "claude-cli/2.1.226 (external, sdk-cli)" }));
    expect(client).toEqual({ name: "claude_code", source: "user_agent" });
    expect(resolveCliModelMapping(client, "claude/claude-opus-4-8", mappings("claude", true))).toBe("openai/gpt-5.5");
  });

  test("keeps client detector IDs stable", () => {
    expect(cliToolIdForClient("claude_code")).toBe("claude");
    expect(cliToolIdForClient("codex")).toBe("codex");
    expect(cliToolIdForClient("github_copilot")).toBe("copilot");
    expect(cliToolIdForClient("unknown")).toBeNull();
  });
});


describe("CLI native slot injectors", () => {
  const input: ApplyInput = {
    endpoint: "http://localhost:12800",
    apiKey: "sk-test",
    models: ["fallback-model"],
    modelSlots: {
      opus: "claude/source-opus",
      sonnet: "claude/source-sonnet",
      haiku: "claude/source-haiku",
      fable: "claude/source-fable",
      mythos: "claude/source-mythos",
      session: "gpt-5.5",
      subagent: "o4-mini",
      review: "gpt-5.5-review",
    },
  };

  test("Claude download emits every configured native role", async () => {
    const result = await claudeInjector.download(input);
    expect(result.content).toContain(`\"ANTHROPIC_DEFAULT_FABLE_MODEL\": \"claude/source-fable\"`);
    expect(result.content).toContain(`\"ANTHROPIC_CUSTOM_MODEL_OPTION\": \"claude/source-mythos\"`);
  });

  test("Claude download keeps the host base for Claude Code's appended /v1/messages path", async () => {
    const result = await claudeInjector.download({
      ...input,
      endpoint: "http://localhost:12800/v1",
    });
    const downloaded = JSON.parse(result.content) as { env: { ANTHROPIC_BASE_URL: string } };
    expect(downloaded.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12800");
  });

  test("Codex download emits session, subagent, and review roles", async () => {
    const result = await codexInjector.download(input);
    expect(result.content).toContain(`model = \"gpt-5.5\"`);
    expect(result.content).toContain(`review_model = \"gpt-5.5-review\"`);
    expect(result.content).toContain(`[agents.subagent]`);
    expect(result.content).toContain(`model = \"o4-mini\"`);
  });
});