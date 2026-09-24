import { describe, expect, test } from "bun:test";

import type { CanonicalEvent, CanonicalMessage, UsageRecord } from "../../src/transport/canonical-model";
import { MessagesAdapter } from "../../src/transport/surface/messages/adapter";
import { applyMessagesToolLedger } from "../../src/transport/surface/messages/parse";
import { MessagesStreamEncoder } from "../../src/transport/surface/messages/stream";
import { ContractHarness } from "./contract-harness";

const adapter = new MessagesAdapter();
const usage: UsageRecord = {
  input_tokens: 20,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  uncached_input_tokens: 20,
  output_tokens: 11,
  reasoning_tokens: 4,
  estimated_cost: 0,
};

describe("Messages adapter production contract", () => {
  test("builds through the shared production composition harness and serves a real request", async () => {
    const harness = new ContractHarness();
    const app = await harness.buildProductionCompositionRoot();
    expect(app).toBeDefined();

    const response = await app.handle(
      new Request("http://cartethyia.test/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer contract-test-token",
        },
        body: JSON.stringify(harness.requests.anthropicMessages()),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content?.[0]?.type).toBe("text");
    expect(body.stop_reason).toBe("end_turn");
  });

  test("accepts createAnthropic and Claude Code option/header shapes", () => {
    const parsed = adapter.parse({
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "user-agent": "claude-code/1.0",
        "x-app": "cli",
        authorization: "Bearer client-token",
      },
      body: {
        model: "claude-4-6-sonnet",
        max_tokens: 4096,
        system: [
          { type: "text", text: "You are Claude Code." },
          { type: "text", text: "billing" },
        ],
        messages: [{ role: "user", content: "hello" }],
        disableParallelToolUse: true,
        sendReasoning: true,
        effort: "high",
        thinking: { type: "enabled", budget_tokens: 4096 },
        toolStreaming: true,
        structuredOutputMode: "auto",
        metadata: { userId: "cli-user" },
      },
    });
    expect(parsed.source_surface).toBe("messages");
    expect(parsed.system?.map((part) => part.kind)).toEqual(["text", "text"]);
    expect(parsed.generation_controls.parallel_tool_calls).toBe(false);
    expect(parsed.generation_controls["extension:metadata_user_id"]).toBe("cli-user");
    expect(parsed.reasoning).toMatchObject({ thinking_type: "enabled", budget_tokens: 4096 });
  });

  test("rebuilds canonical tool rounds through the ledger with ordering and error signaling", () => {
    const canonical: CanonicalMessage[] = [
      {
        role: "assistant",
        content: [
          { kind: "toolCall", call_id: "a", name: "lookup", arguments: { key: "a" }, index: 0 },
          { kind: "toolCall", call_id: "b", name: "lookup", arguments: { key: "b" }, index: 1 },
        ],
      },
      {
        role: "user",
        content: [
          { kind: "text", text: "trailing text" },
          { kind: "toolResult", call_id: "b", content: "denied", is_error: true },
          { kind: "toolResult", call_id: "a", content: "ok" },
        ],
      },
    ];
    const rebuilt = applyMessagesToolLedger(canonical);
    expect(rebuilt.map((message) => message.content.map((part) => part.kind))).toEqual([
      ["toolCall", "toolCall"],
      ["toolResult", "toolResult"],
      ["text"],
    ]);
    const resultParts = rebuilt[1]?.content;
    expect(resultParts?.[0]).toMatchObject({ kind: "toolResult", call_id: "a" });
    expect(resultParts?.[1]).toMatchObject({
      kind: "toolResult",
      call_id: "b",
      is_error: true,
      // Error payloads survive verbatim: they are the diagnostic detail a
      // retry depends on, never rewritten into instructive prose.
      content: "denied",
    });
  });

  test("round-trips thinking signatures and redacted payloads without exposing raw reasoning", () => {
    const request = adapter.parse({
      model: "claude-4-6-sonnet",
      max_tokens: 4096,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "summary only", signature: "signature-opaque" },
            { type: "redacted_thinking", data: "opaque-redacted" },
          ],
        },
      ],
    });
    const events: CanonicalEvent[] = [
      {
        type: "content_delta",
        sequence_number: 1,
        content: request.messages[0]?.content[0] ?? { kind: "text", text: "" },
      },
      {
        type: "content_delta",
        sequence_number: 2,
        content: request.messages[0]?.content[1] ?? { kind: "text", text: "" },
      },
      { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "stop", usage },
    ];
    const encoded = adapter.encode(events, {
      response_id: "msg-contract",
      model: "claude-4-6-sonnet",
    });
    if (encoded.type !== "message") throw new Error("expected a Messages response");
    expect(encoded.content[0]).toEqual({
      type: "thinking",
      thinking: "summary only",
      signature: "signature-opaque",
    });
    expect(encoded.content[1]).toEqual({ type: "redacted_thinking", data: "opaque-redacted" });
  });

  test("emits final usage and every allowed stop reason through streaming lifecycle", () => {
    for (const [stop_reason, expectedWireReason] of [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_use", "tool_use"],
      ["refusal", "refusal"],
      ["content_filter", "refusal"],
      ["error", "end_turn"],
      ["cancelled", "end_turn"],
    ] as const) {
      const events: CanonicalEvent[] = [
        { type: "content_delta", sequence_number: 1, content: { kind: "text", text: "ok" } },
        { type: "usage", sequence_number: 2, usage: { ...usage, reasoning_tokens: "unavailable" } },
        { type: "terminal", sequence_number: 3, state: "complete", stop_reason, usage },
      ];
      const encoder = new MessagesStreamEncoder({ response_id: "msg-contract", model: "claude" });
      const encoded = events.flatMap((event) => encoder.push(event));
      expect(encoded[0]?.type).toBe("message_start");
      expect(encoded.at(-2)).toMatchObject({
        type: "message_delta",
        delta: { stop_reason: expectedWireReason },
        usage: { output_tokens: 11, output_tokens_details: { thinking_tokens: 4 } },
      });
      expect(encoded.at(-1)?.type).toBe("message_stop");
    }
  });
});
