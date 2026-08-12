import { describe, expect, test } from "bun:test";
import { isNativePassthroughEligible, detectClientFormat } from "../../src/open-sse/translate";
import { normalizeMessagesRequest, buildMessagesPayload } from "../../src/open-sse/translate/request/anthropic";
import { capabilitiesOf } from "../../src/open-sse/transport/catalog";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

describe("Anthropic Claude Code controls", () => {
  test("preserves adaptive thinking, output effort, metadata, MCP, and tool errors", () => {
    const result = normalizeMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      metadata: { user_id: "cli-user", trace: "anthropic-fixture" },
      mcp_servers: [{ type: "url", url: "https://mcp.example.test/sse", name: "repo" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Read the file." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: { file_path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", is_error: true, content: "File not found" }] },
      ],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    expect(result.request.reasoningConfig).toEqual({ effort: "high" });
    expect(result.request.metadata).toEqual({ user_id: "cli-user", trace: "anthropic-fixture" });
    expect(result.request.metadataUserId).toBe("cli-user");
    expect(result.request.mcpServers).toEqual([{ type: "url", url: "https://mcp.example.test/sse", name: "repo" }]);

    const payload = buildMessagesPayload(result.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true }));
    expect(payload.thinking).toEqual({ type: "adaptive" });
    expect(payload.output_config).toEqual({ effort: "high" });
    expect(payload.metadata).toBeUndefined();
    expect(payload.mcp_servers).toEqual([{ type: "url", url: "https://mcp.example.test/sse", name: "repo" }]);
    expect((payload.messages as Array<Record<string, unknown>>)[2]?.content).toEqual([{ type: "tool_result", tool_use_id: "call_read", is_error: true, content: "File not found" }]);
  });

  test("accepts explicit thinking budgets within the provider bound", () => {
    const result = normalizeMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "Continue." }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoningConfig).toEqual({ maxTokens: 2048 });
    expect(buildMessagesPayload(result.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true })).thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  test("preserves valid thinking signatures and rejects oversized signatures", () => {
    const valid = normalizeMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "sig_123" }] }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      const payload = buildMessagesPayload(valid.request, capabilitiesOf({ surfaces: ["anthropic-messages"], reasoning: true }));
      expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toEqual([{ type: "thinking", thinking: "private", signature: "sig_123" }]);
    }

    const invalid = normalizeMessagesRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "x".repeat(512_001) }] }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });
    expect(invalid.ok).toBe(false);
  });

  test("allows native passthrough only for explicit same-protocol profiles", () => {
    const claude = detectClientFormat("/v1/messages", "anthropic-messages", new Headers({ "user-agent": "claude-code/1.0" }), {});
    expect(isNativePassthroughEligible({ client: claude.profile, source: "anthropic-messages", target: "anthropic-messages", providerAllowsNative: true })).toBe(true);
    expect(isNativePassthroughEligible({ client: claude.profile, source: "anthropic-messages", target: "openai-chat", providerAllowsNative: true })).toBe(false);
    expect(isNativePassthroughEligible({ client: { ...claude.profile, passthrough: "never" }, source: "anthropic-messages", target: "anthropic-messages", providerAllowsNative: true })).toBe(false);
  });
});
