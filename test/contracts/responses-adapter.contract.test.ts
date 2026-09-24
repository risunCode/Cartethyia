import { describe, expect, test } from "bun:test";

import { ContractHarness } from "./contract-harness";
import { ResponsesAdapter } from "../../src/transport/surface/responses/adapter";

const usage = {
  input_tokens: 20,
  cached_input_tokens: 8,
  cache_write_tokens: "unavailable" as const,
  uncached_input_tokens: 12,
  output_tokens: 9,
  reasoning_tokens: 5,
  estimated_cost: 0.02,
  actual_cost: null,
};

describe("Responses adapter production contract", () => {
  test("uses the contract harness, keeps item input distinct, and serves a real request", async () => {
    const harness = new ContractHarness();
    const app = await harness.buildProductionCompositionRoot();
    expect(app).toBeDefined();

    const response = await app.handle(
      new Request("http://cartethyia.test/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer contract-test-token",
        },
        body: JSON.stringify(harness.requests.openAiResponses()),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as { object?: string; status?: string };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");

    const adapter = new ResponsesAdapter();
    const request = adapter.parse(
      harness.requests.openAiResponses({
        input: [
          {
            type: "message",
            id: "developer-1",
            role: "developer",
            content: [{ type: "input_text", text: "Use tools" }],
          },
          {
            type: "function_call",
            id: "function-1",
            call_id: "call-1",
            name: "lookup",
            arguments: '{"key":"a"}',
          },
          { type: "function_call_output", id: "output-1", call_id: "call-1", output: "value" },
        ],
      }),
    );
    expect(request.source_surface).toBe("responses");
    // Developer input items hoist to canonical `instructions` (no surface emits
    // a `developer` role upstream — Anthropic has none).
    expect(request.instructions).toEqual([{ kind: "text", text: "Use tools" }]);
    expect(request.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(request.messages[0]?.content[0]).toMatchObject({ kind: "toolCall", call_id: "call-1" });
    expect(request.messages[1]?.content[0]).toMatchObject({
      kind: "toolResult",
      call_id: "call-1",
    });
    expect(request.messages).not.toHaveLength(1);
  });

  test("round-trips function calls and ordered streaming lifecycle", async () => {
    const harness = new ContractHarness();
    await harness.buildProductionCompositionRoot();
    const adapter = new ResponsesAdapter();
    const request = adapter.parse(
      harness.requests.openAiResponses({
        input: [
          {
            type: "function_call",
            id: "item-1",
            call_id: "call-1",
            name: "lookup",
            arguments: "{}",
          },
        ],
      }),
    );
    const roundTrip = adapter.encodeRequest(request);
    expect(roundTrip.input).toEqual([
      { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: "{}" },
    ]);

    const events = adapter.encode([
      { type: "response_start", sequence_number: 1, model: "cartethyia-test-model" },
      { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "ready" } },
      {
        type: "tool_call_delta",
        sequence_number: 3,
        call_id: "call-1",
        name: "lookup",
        arguments_delta: "{}",
      },
      { type: "terminal", sequence_number: 4, state: "complete", usage },
    ]);
    expect(events[0]?.type).toBe("response.created");
    expect(events.map((event) => event.type)).toContain("response.output_item.added");
    expect(events.map((event) => event.type)).toContain("response.function_call_arguments.delta");
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(
      events.filter(
        (event) =>
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed",
      ),
    ).toHaveLength(1);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  test("preserves reasoning summary and encrypted next-turn echo opaquely", async () => {
    const harness = new ContractHarness();
    await harness.buildProductionCompositionRoot();
    const adapter = new ResponsesAdapter();
    const encrypted = "opaque-reasoning-sentinel-\\u0000-\\u00ff";
    const request = adapter.parse({
      model: "cartethyia-test-model",
      input: [
        {
          type: "reasoning",
          id: "reason-1",
          summary: [{ type: "summary_text", text: "brief" }],
          encrypted_content: encrypted,
        },
      ],
      include: ["reasoning.encrypted_content"],
      store: false,
    });
    const nextTurn = adapter.encodeRequest(request);
    const input = nextTurn.input;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) throw new Error("Responses next turn must use input[]");
    const reasoningItem = input[0];
    if (reasoningItem === null || typeof reasoningItem !== "object")
      throw new Error("Missing reasoning item");
    const encryptedValue = reasoningItem["encrypted_content"];
    expect(encryptedValue).toBe(encrypted);
    const reparsed = adapter.parse(nextTurn);
    const reasoning = reparsed.messages[0]?.content[0];
    if (reasoning === undefined || reasoning.kind !== "reasoning")
      throw new Error("Missing canonical reasoning item");
    expect(reasoning.encrypted_content).toBe(encrypted);
    expect(reasoning.payload).toBe(encrypted);

    const encoded = adapter.encode(
      [
        { type: "response_start", sequence_number: 1, model: "cartethyia-test-model" },
        {
          type: "content_delta",
          sequence_number: 2,
          content: {
            kind: "reasoning",
            payload: encrypted,
            opaque: true,
            encrypted_content: encrypted,
            summary: "brief",
          },
        },
        { type: "usage", sequence_number: 3, usage },
        { type: "terminal", sequence_number: 4, state: "complete" },
      ],
    );
    expect(
      encoded.find((event) => event.type === "response.reasoning.encrypted_content")
        ?.encrypted_content,
    ).toBe(encrypted);
    expect(encoded.at(-1)?.response).toMatchObject({
      usage: { output_tokens: 9, reasoning_tokens: 5 },
    });
  });
});
