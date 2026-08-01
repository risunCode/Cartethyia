import { describe, expect, test } from "bun:test";
import { injectSystemPrompt, prepareOutboundRequest } from "../../src/upstream/outbound";

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

  test("prepareOutboundRequest clones before injecting the configured system prompt", () => {
    const body = { messages: [{ role: "user", content: "Hi" }] };

    const prepared = prepareOutboundRequest(body, "openai", { systemPrompt: "Always cite sources." });

    expect(body).toEqual({ messages: [{ role: "user", content: "Hi" }] });
    expect(prepared).not.toBe(body);
    expect(prepared).toEqual({
      messages: [
        { role: "system", content: "Always cite sources." },
        { role: "user", content: "Hi" },
      ],
    });
  });

  test("returns the original body without allocation when no system prompt is configured", () => {
    const body = { messages: [{ role: "user", content: "Hi" }] };

    const prepared = prepareOutboundRequest(body, "openai", { systemPrompt: undefined });

    expect(prepared).toBe(body);
  });
});
