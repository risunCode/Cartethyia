import { describe, expect, test } from "bun:test";
import { ContractHarness } from "./contract-harness";

interface LiveApp {
  handle(request: Request): Response | Promise<Response>;
}

function asLiveApp(value: unknown): LiveApp {
  if (
    value === null ||
    typeof value !== "object" ||
    !("handle" in value) ||
    typeof value.handle !== "function"
  ) {
    throw new Error("production composition root did not expose a live handler");
  }
  return value as LiveApp;
}

describe("canonical translation boundary composition", () => {
  test("routes all three public surfaces through the real app composition", async () => {
    const harness = new ContractHarness();
    const app = asLiveApp(await harness.buildProductionCompositionRoot());
    const cases: Array<{ path: string; body: Record<string, unknown>; expectedType: string }> = [
      {
        path: "/v1/chat/completions",
        body: harness.requests.openAiChat(),
        expectedType: "chat.completion",
      },
      {
        path: "/v1/responses",
        body: harness.requests.openAiResponses(),
        expectedType: "response",
      },
      {
        path: "/v1/messages",
        body: harness.requests.anthropicMessages(),
        expectedType: "message",
      },
    ];

    for (const entry of cases) {
      const response = await app.handle(
        new Request(`http://cartethyia.test${entry.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-contract-key",
          },
          body: JSON.stringify(entry.body),
        }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload["object"] ?? payload["type"]).toBe(entry.expectedType);
    }
  });

  test("rejects unsupported capability before executor dispatch through the live route", async () => {
    const harness = new ContractHarness();
    const app = asLiveApp(
      await harness.buildProductionCompositionRoot({ rejectCapabilities: true }),
    );
    const body = harness.requests.openAiChat({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
        },
      ],
    });
    const response = await app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-contract-key" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["error"]).toMatchObject({ code: "capability_unsupported" });
    expect(harness.dispatchCount).toBe(0);
  });
});