import { describe, expect, test } from "bun:test";

import {
  parseReasoningIntent,
  parseResponseFormat,
  parseToolChoice,
} from "../../src/transport/surface/dialects";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import type { CanonicalRequest } from "../../src/transport/canonical-model";

describe("cross-surface dialect parity", () => {
  test("parseToolChoice yields one canonical shape for equivalent wire inputs", () => {
    // String literal is shared verbatim by every dialect.
    for (const dialect of ["chat", "responses", "messages"] as const) {
      expect(parseToolChoice("auto", dialect)).toBe("auto");
    }

    // Named function: Chat wraps it under `function`, Responses/Messages flatten it.
    const chatFunction = parseToolChoice(
      { type: "function", function: { name: "get_weather" } },
      "chat",
    );
    const responsesFunction = parseToolChoice({ type: "tool", name: "get_weather" }, "responses");
    const messagesFunction = parseToolChoice({ type: "tool", name: "get_weather" }, "messages");
    expect(chatFunction).toEqual({ type: "tool", name: "get_weather" });
    expect(responsesFunction).toEqual(chatFunction);
    expect(messagesFunction).toEqual(chatFunction);

    // Custom tool: Chat nests under `custom`, Responses/Messages flatten it.
    const chatCustom = parseToolChoice({ type: "custom", custom: { name: "edit" } }, "chat");
    const responsesCustom = parseToolChoice({ type: "custom", name: "edit" }, "responses");
    expect(chatCustom).toEqual({ type: "custom", name: "edit" });
    expect(responsesCustom).toEqual(chatCustom);

    // allowed_tools is identical on every dialect.
    const allowed = { type: "allowed_tools", tools: [{ name: "t1" }] };
    const chatAllowed = parseToolChoice(allowed, "chat");
    expect(parseToolChoice(allowed, "responses")).toEqual(chatAllowed);
    expect(parseToolChoice(allowed, "messages")).toEqual(chatAllowed);
    expect(chatAllowed).toEqual({ type: "allowed_tools", mode: "auto", names: ["t1"] });
  });

  test("parseReasoningIntent normalizes Chat scalars and Responses nesting identically", () => {
    const chat = parseReasoningIntent({ reasoning_effort: "high", summary_mode: "concise" });
    const responses = parseReasoningIntent({ reasoning: { effort: "high", summary: "concise" } });
    expect(chat).toEqual({ effort: "high", summary_mode: "concise" });
    expect(responses).toEqual(chat);
  });

  test("parseResponseFormat normalizes Chat and Responses envelopes identically", () => {
    const chat = parseResponseFormat({
      type: "json_schema",
      json_schema: { name: "N", schema: { type: "object" } },
    });
    const responses = parseResponseFormat({ type: "json_schema", name: "N", schema: { type: "object" } });
    expect(chat).toEqual({ type: "json_schema", name: "N", schema: { type: "object" } });
    expect(responses).toEqual(chat);
  });

  test("instructions propagate to the Anthropic top-level system block", () => {
    const request = {
      model: "m",
      instructions: [{ kind: "text", text: "Rule 1" }],
      messages: [{ role: "user", content: [{ kind: "text", text: "Hi" }] }],
      generation_controls: { max_tokens: 10 },
      stream: false,
      source_surface: "responses",
    } as unknown as CanonicalRequest;
    const payload = canonicalToClaudeMessagesPayload(request);
    const system = payload.system as Array<Record<string, unknown>>;
    expect(system.map((b) => b["text"])).toContain("Rule 1");
  });

  test("in-message system turns hoist to Anthropic system, leaving only the user turn", () => {
    const request = {
      model: "m",
      messages: [
        { role: "system", content: [{ kind: "text", text: "Env" }] },
        { role: "user", content: [{ kind: "text", text: "Hi" }] },
      ],
      generation_controls: { max_tokens: 10 },
      stream: false,
      source_surface: "responses",
    } as unknown as CanonicalRequest;
    const payload = canonicalToClaudeMessagesPayload(request);
    const system = payload.system as Array<Record<string, unknown>>;
    expect(system.map((b) => b["text"])).toContain("Env");
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["user"]);
  });
});
