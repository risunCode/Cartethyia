import { describe, expect, test } from "bun:test";
import {
  clampReasoningEffort,
  normalizeThinkingConfig,
  resolveSupportedReasoningEfforts,
  RESPONSES_WIRE_SUPPORTED_EFFORTS,
  EXTENDED_SUPPORTED_EFFORTS,
} from "../../../src/transport/translation/thinking";
import type { CanonicalMessage, CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "test-model",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  } as CanonicalRequest;
}

const userTurn: CanonicalMessage = { role: "user", content: [{ kind: "text", text: "hi" }] };
const assistantTurn: CanonicalMessage = {
  role: "assistant",
  content: [{ kind: "text", text: "ok" }],
};
const toolTurn: CanonicalMessage = {
  role: "tool",
  content: [{ kind: "toolResult", call_id: "call_1", content: "done" }],
};

describe("normalizeThinkingConfig", () => {
  test("drops native thinking config when the last message is not user", () => {
    const request = requestWith({
      messages: [userTurn, assistantTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000, effort: "high" },
    });
    const next = normalizeThinkingConfig(request);
    expect(next.reasoning?.thinking_type).toBeUndefined();
    expect(next.reasoning?.budget_tokens).toBeUndefined();
    // Request-level effort survives a tool-result turn.
    expect(next.reasoning?.effort).toBe("high");
    // Input untouched.
    expect(request.reasoning?.thinking_type).toBe("enabled");
    expect(request.reasoning?.budget_tokens).toBe(5000);
  });

  test("preserves native thinking config when history replays thinking blocks", () => {
    const assistantWithThinking: CanonicalMessage = {
      role: "assistant",
      content: [
        { kind: "reasoning", payload: null, signature: "sig_abc", opaque: true },
        { kind: "text", text: "ok" },
      ],
    };
    const request = requestWith({
      messages: [userTurn, assistantWithThinking, toolTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    });
    // Signed blocks cannot be replayed without the thinking config, so the
    // drop is suppressed even on a tool-result turn.
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("preserves thinking config when the last message is user", () => {
    const request = requestWith({
      messages: [userTurn],
      reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
    });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("returns the same reference when only effort is present", () => {
    const request = requestWith({
      messages: [assistantTurn],
      reasoning: { effort: "medium" },
    });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("returns the same reference when there is no reasoning intent", () => {
    const request = requestWith({ messages: [assistantTurn] });
    expect(normalizeThinkingConfig(request)).toBe(request);
  });

  test("keeps unrelated reasoning fields", () => {
    const request = requestWith({
      messages: [toolTurn],
      reasoning: { thinking_type: "adaptive", budget_tokens: 1000, context: "all_turns" },
    });
    const next = normalizeThinkingConfig(request);
    expect(next.reasoning?.context).toBe("all_turns");
    expect(next.reasoning?.thinking_type).toBeUndefined();
  });

  test("normalizes effort when target options are provided", () => {
    const request = requestWith({
      model: "muse-spark-1.3-contributor-free",
      messages: [userTurn],
      reasoning: { effort: "max" },
    });
    const next = normalizeThinkingConfig(request, { wireFamily: "responses" });
    expect(next.reasoning?.effort).toBe("xhigh");
  });
});

describe("clampReasoningEffort", () => {
  test("returns undefined when requested effort is undefined or empty", () => {
    expect(clampReasoningEffort(undefined, RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
    expect(clampReasoningEffort("", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
  });

  test("normalizes off and none to undefined", () => {
    expect(clampReasoningEffort("none", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
    expect(clampReasoningEffort("off", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBeUndefined();
  });

  test("leaves supported effort untouched", () => {
    expect(clampReasoningEffort("high", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("high");
    expect(clampReasoningEffort("xhigh", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
    expect(clampReasoningEffort("low", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("low");
  });

  test("clamps max down to xhigh when max is not supported", () => {
    expect(clampReasoningEffort("max", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
  });

  test("allows max when max is in the supported ladder", () => {
    expect(clampReasoningEffort("max", EXTENDED_SUPPORTED_EFFORTS)).toBe("max");
  });

  test("normalizes ultra to max or clamped ceiling", () => {
    expect(clampReasoningEffort("ultra", EXTENDED_SUPPORTED_EFFORTS)).toBe("max");
    expect(clampReasoningEffort("ultra", RESPONSES_WIRE_SUPPORTED_EFFORTS)).toBe("xhigh");
  });

  test("floors up to model minimum if requested effort is below supported minimum", () => {
    const highOnlyLadder = ["high", "max"] as const;
    expect(clampReasoningEffort("low", highOnlyLadder)).toBe("high");
  });
});

describe("resolveSupportedReasoningEfforts", () => {
  test("explicitly declared catalog efforts take precedence", () => {
    const custom = ["low", "high"] as const;
    expect(resolveSupportedReasoningEfforts("any-model", "chat", custom)).toEqual(["low", "high"]);
  });

  test("responses wire defaults to 5-tier scale without max", () => {
    expect(resolveSupportedReasoningEfforts("some-model", "responses")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("frontier models on responses wire keep max support", () => {
    expect(resolveSupportedReasoningEfforts("gpt-5.6-sol", "responses")).toContain("max");
    expect(resolveSupportedReasoningEfforts("gpt-6-astra", "responses")).toContain("max");
  });

  test("gemini models resolve to 4-tier base scale", () => {
    expect(resolveSupportedReasoningEfforts("gemini-3-flash", "chat")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  test("claude / mimo / deepseek resolve to extended scale with max", () => {
    expect(resolveSupportedReasoningEfforts("", "chat")).toContain("max");
    expect(resolveSupportedReasoningEfforts("mimo-v2.5-free", "chat")).toContain("max");
    expect(resolveSupportedReasoningEfforts("deepseek-v4-flash", "chat")).toContain("max");
  });

  test("mimo-v2.6 excludes the tiers upstream answers with an opaque 500", () => {
    // Regression: the generic default handed this family `xhigh`, and OpenCode's
    // /zen/v1 answers `xhigh`, `max`, and `minimal` with a bare
    // `500 Internal server error` that names no parameter — the request simply
    // died. Its siblings on the same endpoint accept the full ladder, so the
    // narrowing is per model.
    const supported = resolveSupportedReasoningEfforts("mimo-v2.6-flash-free", "chat");
    expect(supported).toEqual(["low", "medium", "high"]);
    expect(supported).not.toContain("xhigh");
    expect(supported).not.toContain("max");
    expect(supported).not.toContain("minimal");
  });

  test("a caller-requested xhigh on mimo-v2.6 lands on an accepted tier", () => {
    const supported = resolveSupportedReasoningEfforts("mimo-v2.6-flash-free", "chat");
    expect(clampReasoningEffort("xhigh", supported)).toBe("high");
    expect(clampReasoningEffort("minimal", supported)).toBe("low");
    // Every value the clamp can return must itself be accepted upstream.
    for (const requested of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const clamped = clampReasoningEffort(requested, supported);
      if (clamped === undefined) throw new Error(`clamp returned undefined for ${requested}`);
      expect(supported).toContain(clamped);
    }
  });

  test("gpt-5.5 has neither minimal nor max on responses (OMP openai-codex)", () => {
    expect(resolveSupportedReasoningEfforts("gpt-5.5", "responses")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("OpenAI 5.6/6/daybreak rows take max without minimal (OMP catalog)", () => {
    for (const id of [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-daybreak-blue-latest",
    ]) {
      expect(resolveSupportedReasoningEfforts(id, "responses")).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  test("Claude ladders follow the published anthropic catalog", () => {
    // The 4.6 adaptive pair stops at high.
    expect(resolveSupportedReasoningEfforts("claude-sonnet-4-6", "chat")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // Budget-era rows keep minimal and stop at xhigh.
    const budget = resolveSupportedReasoningEfforts("claude-sonnet-4-5", "chat");
    expect(budget).toContain("minimal");
    expect(budget).not.toContain("max");
    // New-gen adaptive rows take max without minimal.
    const modern = resolveSupportedReasoningEfforts("claude-mythos-5", "chat");
    expect(modern).toContain("max");
    expect(modern).not.toContain("minimal");
    // Gateway-prefixed dot form resolves to the same ladder.
    expect(resolveSupportedReasoningEfforts("cb/claude-opus-4.6", "chat")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
