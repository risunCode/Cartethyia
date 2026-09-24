import { describe, expect, test } from "bun:test";
import {
  TOOL_ID_PATTERN,
  generateToolCallId,
  sanitizeRequestToolIds,
  sanitizeToolId,
} from "../../../src/transport/translation/tool-id";
import type { CanonicalMessage, CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(messages: readonly CanonicalMessage[]): CanonicalRequest {
  return {
    model: "test-model",
    messages,
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  } as CanonicalRequest;
}

function userText(text: string): CanonicalMessage {
  return { role: "user", content: [{ kind: "text", text }] };
}

function toolCallMessage(callId: string, name = "get_weather"): CanonicalMessage {
  return {
    role: "assistant",
    content: [{ kind: "toolCall", call_id: callId, name, arguments: "{}", index: 0 }],
  };
}

function toolResultMessage(callId: string): CanonicalMessage {
  return {
    role: "tool",
    content: [{ kind: "toolResult", call_id: callId, content: "sunny" }],
  };
}

describe("sanitizeToolId", () => {
  test("keeps already-valid ids", () => {
    expect(sanitizeToolId("call_abc-123")).toBe("call_abc-123");
  });

  test("strips characters outside the Anthropic class", () => {
    expect(sanitizeToolId("call:abc/123!")).toBe("callabc123");
  });

  test("returns null when nothing valid remains", () => {
    expect(sanitizeToolId("!!!")).toBeNull();
    expect(sanitizeToolId("")).toBeNull();
  });

  test("returns null for non-strings", () => {
    expect(sanitizeToolId(123)).toBeNull();
    expect(sanitizeToolId(null)).toBeNull();
    expect(sanitizeToolId(undefined)).toBeNull();
  });
});

describe("generateToolCallId", () => {
  test("uses the positional shape without a tool name", () => {
    expect(generateToolCallId(2, 3)).toBe("call_msg2_tc3");
    expect(generateToolCallId()).toBe("call_msg0_tc0");
  });

  test("appends a sanitized tool name when given", () => {
    expect(generateToolCallId(2, 3, "get_weather")).toBe("call_msg2_tc3_get_weather");
    expect(generateToolCallId(2, 3, "get weather!")).toBe("call_msg2_tc3_getweather");
  });

  test("stays deterministic across calls", () => {
    expect(generateToolCallId(1, 0, "read")).toBe(generateToolCallId(1, 0, "read"));
  });
});

describe("sanitizeRequestToolIds", () => {
  test("rewrites a bad toolCall id and its matching toolResult to the same value", () => {
    const request = requestWith([
      userText("weather?"),
      toolCallMessage("bad:id"),
      toolResultMessage("bad:id"),
    ]);
    const next = sanitizeRequestToolIds(request);
    const call = next.messages[1]?.content[0];
    const result = next.messages[2]?.content[0];

    expect(call?.kind).toBe("toolCall");
    expect(result?.kind).toBe("toolResult");
    if (call?.kind === "toolCall" && result?.kind === "toolResult") {
      expect(call.call_id).toBe("badid");
      expect(result.call_id).toBe(call.call_id);
    }
    // Input is untouched.
    expect(request.messages[1]?.content[0]).toMatchObject({ call_id: "bad:id" });
  });

  test("generates a deterministic fallback when the id sanitizes to empty", () => {
    const request = requestWith([
      userText("weather?"),
      toolCallMessage("!!!", "get_weather"),
      toolResultMessage("!!!"),
    ]);
    const next = sanitizeRequestToolIds(request);
    const call = next.messages[1]?.content[0];
    const result = next.messages[2]?.content[0];

    expect(call?.kind === "toolCall" ? call.call_id : null).toBe("call_msg1_tc0_get_weather");
    expect(result?.kind === "toolResult" ? result.call_id : null).toBe(
      "call_msg1_tc0_get_weather",
    );
  });

  test("sanitizes an orphan invalid toolResult independently", () => {
    const request = requestWith([toolResultMessage("x y")]);
    const next = sanitizeRequestToolIds(request);
    const result = next.messages[0]?.content[0];
    expect(result?.kind === "toolResult" ? result.call_id : null).toBe("xy");
  });

  test("returns the same reference when all ids are valid", () => {
    const request = requestWith([
      userText("weather?"),
      toolCallMessage("call_1"),
      toolResultMessage("call_1"),
    ]);
    expect(sanitizeRequestToolIds(request)).toBe(request);
  });

  test("leaves non-tool messages and parts untouched", () => {
    const request = requestWith([
      userText("hello"),
      toolCallMessage("bad:id"),
      toolResultMessage("bad:id"),
    ]);
    const next = sanitizeRequestToolIds(request);
    expect(next).not.toBe(request);
    expect(next.messages[0]).toBe(request.messages[0]);
    expect(next.messages[0]?.content[0]).toBe(request.messages[0]?.content[0]);
  });

  test("exposes the Anthropic id pattern", () => {
    expect(TOOL_ID_PATTERN.test("call_1")).toBe(true);
    expect(TOOL_ID_PATTERN.test("call:1")).toBe(false);
  });
});
