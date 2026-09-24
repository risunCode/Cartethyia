import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";
import { buildClaudeMessagesRequest, ensureAnthropicBeta } from "../../../src/providers/integrations/claude-messages";

function request(controls: Record<string, unknown>): CanonicalRequest {
  return {
    model: "claude-x",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: { max_tokens: 2048, ...controls },
    stream: false,
    source_surface: "messages",
  };
}

describe("buildClaudeMessagesRequest", () => {
  test("appends user-profiles beta when a user_profile_id is supplied", () => {
    const built = buildClaudeMessagesRequest({
      request: request({ "extension:user_profile_id": "up-1" }),
      authHeader: "x-api-key",
      credential: { secret: "sk-test" },
    });
    expect(built.headers["anthropic-beta"]).toBe("user-profiles");
    expect(built.headers["x-api-key"]).toBe("sk-test");
  });

  test("preserves existing betas while appending user-profiles", () => {
    const built = buildClaudeMessagesRequest({
      request: request({ "extension:user_profile_id": "up-1" }),
      authHeader: "x-api-key",
      credential: { secret: "sk-test", customHeaders: { "anthropic-beta": "existing-beta" } },
    });
    const betas = (built.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim());
    expect(betas).toContain("existing-beta");
    expect(betas).toContain("user-profiles");
  });

  test("omits user-profiles beta when no profile id is present", () => {
    const built = buildClaudeMessagesRequest({
      request: request({}),
      authHeader: "x-api-key",
      credential: { secret: "sk-test" },
    });
    expect(built.headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("ensureAnthropicBeta", () => {
  test("appends idempotently", () => {
    const headers: Record<string, string> = { "anthropic-beta": "a" };
    ensureAnthropicBeta(headers, "b");
    ensureAnthropicBeta(headers, "b");
    expect(headers["anthropic-beta"]).toBe("a,b");
  });
});