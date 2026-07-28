import { describe, expect, test } from "bun:test";
import {
  anthropicStopToOpenAIFinish,
  anthropicStopToResponsesStatus,
  isOpenAIFinishReason,
  openAIFinishToAnthropicStop,
} from "../../src/translate/concerns/finishReasons";

describe("finishReasons concern", () => {
  test("isOpenAIFinishReason accepts every known reason", () => {
    for (const r of ["stop", "length", "tool_calls", "content_filter", "function_call"]) {
      expect(isOpenAIFinishReason(r)).toBe(true);
    }
  });

  test("isOpenAIFinishReason rejects unknown strings", () => {
    expect(isOpenAIFinishReason("bogus")).toBe(false);
  });

  test("anthropicStopToOpenAIFinish maps every non-null reason", () => {
    expect(anthropicStopToOpenAIFinish("end_turn")).toBe("stop");
    expect(anthropicStopToOpenAIFinish("stop_sequence")).toBe("stop");
    expect(anthropicStopToOpenAIFinish("max_tokens")).toBe("length");
    expect(anthropicStopToOpenAIFinish("tool_use")).toBe("tool_calls");
    expect(anthropicStopToOpenAIFinish("pause_turn")).toBe("stop");
    expect(anthropicStopToOpenAIFinish("refusal")).toBe("content_filter");
  });

  test("anthropicStopToOpenAIFinish treats null as a normal stop", () => {
    expect(anthropicStopToOpenAIFinish(null)).toBe("stop");
  });

  test("openAIFinishToAnthropicStop maps every reason, including the two colliding on tool_use", () => {
    expect(openAIFinishToAnthropicStop("stop")).toBe("end_turn");
    expect(openAIFinishToAnthropicStop("length")).toBe("max_tokens");
    expect(openAIFinishToAnthropicStop("tool_calls")).toBe("tool_use");
    expect(openAIFinishToAnthropicStop("content_filter")).toBe("refusal");
    expect(openAIFinishToAnthropicStop("function_call")).toBe("tool_use");
  });

  test("anthropicStopToResponsesStatus: max_tokens becomes incomplete/max_output_tokens", () => {
    expect(anthropicStopToResponsesStatus("max_tokens")).toEqual({ status: "incomplete", incompleteReason: "max_output_tokens" });
  });

  test("anthropicStopToResponsesStatus: refusal becomes incomplete/content_filter", () => {
    expect(anthropicStopToResponsesStatus("refusal")).toEqual({ status: "incomplete", incompleteReason: "content_filter" });
  });

  test("anthropicStopToResponsesStatus: every other reason (including null) is completed", () => {
    for (const r of ["end_turn", "tool_use", "stop_sequence", "pause_turn", null] as const) {
      expect(anthropicStopToResponsesStatus(r)).toEqual({ status: "completed" });
    }
  });
});
