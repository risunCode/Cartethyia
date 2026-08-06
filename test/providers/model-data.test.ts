import { describe, expect, test } from "bun:test";
import { lookupModelData } from "../../src/providers/model-data";

describe("lookupModelData", () => {
  test("resolves context and pricing for a known OpenAI flagship model", () => {
    const data = lookupModelData("openai", "gpt-5");
    expect(data).not.toBeNull();
    expect(data?.context.inputTokens).toBeGreaterThan(0);
    expect(data?.context.outputTokens).toBeGreaterThan(0);
    expect(data?.pricing.inputPerMillion).toBeGreaterThan(0);
    expect(data?.pricing.outputPerMillion).toBeGreaterThan(0);
  });

  test("resolves a provider-qualified model id under a gateway adapter (cline/deepseek-v4-flash)", () => {
    const data = lookupModelData("cline", "deepseek/deepseek-v4-flash");
    expect(data).not.toBeNull();
    expect(data?.context.inputTokens).toBeGreaterThan(0);
    expect(data?.pricing.inputPerMillion).toBeLessThan(5);
  });

  test("maps the repo gemini provider id to the models.dev google provider id", () => {
    const data = lookupModelData("gemini", "gemini-2.5-pro");
    expect(data).not.toBeNull();
    expect(data?.context.inputTokens).toBeGreaterThan(0);
  });

  test("maps the repo Codex provider id to the models.dev OpenAI provider id", () => {
    const data = lookupModelData("codex", "gpt-5.6-sol");
    expect(data).not.toBeNull();
    expect(data?.context.inputTokens).toBeGreaterThan(0);
  });

  test("returns null for unknown or non-matching model ids without fabricating data", () => {
    expect(lookupModelData("openai", "no-such-model")).toBeNull();
    expect(lookupModelData("unknown-provider", "gpt-5")).toBeNull();
  });

  test("does not fabricate data for models.dev has no entry for (permissive null)", () => {
    // claude-3-7-sonnet is not a canonical models.dev id — lookup stays null.
    expect(lookupModelData("anthropic", "claude-3-7-sonnet")).toBeNull();
  });
});
