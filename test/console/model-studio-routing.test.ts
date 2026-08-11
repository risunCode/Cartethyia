import { describe, expect, test } from "bun:test";
import type { PresentedProxyResponse } from "../../src/application/contracts";
import { dispatchModelStudioRequest, isModelStudioNoEligibleRoute, normalizeModelStudioResponse } from "../../src/console/model-studio-routing";

function jsonResponse(status: number, value: Record<string, unknown>): PresentedProxyResponse {
  return { status, headers: new Headers({ "content-type": "application/json" }), body: { mode: "json", value } };
}

const noEligibleRoute = jsonResponse(404, {
  error: { code: "model_not_found", message: "No eligible route found" },
});

describe("Model Studio surface routing", () => {
  test("retries a no-route OpenAI attempt through Anthropic for multi-slash models", async () => {
    const attempts: Array<{ surface: string; endpoint: string; model: unknown }> = [];
    const result = await dispatchModelStudioRequest(
      { model: "custom/vendor/multi-slash-model", messages: [], stream: true },
      async (attempt) => {
        attempts.push({ surface: attempt.surface, endpoint: attempt.endpoint, model: attempt.body.model });
        return attempts.length === 1
          ? noEligibleRoute
          : jsonResponse(200, { id: "msg_1", type: "message", model: "custom/vendor/multi-slash-model", content: [{ type: "text", text: "OK" }] });
      },
    );

    expect(attempts).toEqual([
      { surface: "openai-chat", endpoint: "/v1/chat/completions", model: "custom/vendor/multi-slash-model" },
      { surface: "anthropic-messages", endpoint: "/v1/messages", model: "custom/vendor/multi-slash-model" },
    ]);
    expect(result.surface).toBe("anthropic-messages");
    expect(result.result.status).toBe(200);
  });

  test("does not retry an API-key ACL rejection as another protocol", async () => {
    const blocked = jsonResponse(404, {
      error: { code: "model_not_found", message: "Model or provider is blocked by the API key ACL" },
    });
    const attempts: string[] = [];

    await dispatchModelStudioRequest({ model: "custom/vendor/multi-slash-model" }, async (attempt) => {
      attempts.push(attempt.surface);
      return blocked;
    });

    expect(attempts).toEqual(["openai-chat"]);
  });

  test("converts a successful Anthropic JSON response to the Model Studio chat shape", () => {
    const normalized = normalizeModelStudioResponse(jsonResponse(200, {
      id: "msg_1",
      type: "message",
      model: "custom/vendor/multi-slash-model",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    }), "anthropic-messages");

    expect(normalized.body).toMatchObject({
      mode: "json",
      value: {
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    });
  });

  test("recognizes only the sanitized no-eligible-route error", () => {
    expect(isModelStudioNoEligibleRoute(noEligibleRoute)).toBe(true);
    expect(isModelStudioNoEligibleRoute(jsonResponse(503, { error: { code: "credential_unavailable", message: "No eligible account available" } }))).toBe(false);
  });
});
