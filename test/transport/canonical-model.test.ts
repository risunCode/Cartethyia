import { describe, expect, test } from "bun:test";

import { summarizeParts } from "../../src/transport/canonical-model";
import { publicGatewayErrorDetails } from "../../src/transport/gateway-error";
import { accountsUnavailableError } from "../../src/transport/routing/route-model";
import type { CacheHint, CanonicalEvent, CanonicalRequest, ContentPart, UsageRecord } from "../../src/transport/canonical-model";

describe("canonical-model.test.ts", () => {
const lookupTool = {
  name: "lookup",
  description: "Look up a value.",
  jsonSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
  strict: true,
} satisfies NonNullable<CanonicalRequest["tools"]>[number];

const parallelParts = [
  { kind: "toolCall", call_id: "call-a", name: "lookup", arguments: '{"key":"a"}', index: 0 },
  { kind: "toolCall", call_id: "call-b", name: "lookup", arguments: '{"key":"b"}', index: 1 },
  {
    kind: "toolResult",
    call_id: "call-a",
    content: [{ kind: "text", text: "a-result" }],
  },
  {
    kind: "toolResult",
    call_id: "call-b",
    content: [{ kind: "text", text: "b-result" }],
  },
] satisfies ContentPart[];

const chatRequest = {
  model: "chat-model",
  messages: [
    { role: "user", content: [{ kind: "text", text: "Hello" }] },
    { role: "assistant", content: parallelParts },
  ],
  tools: [lookupTool],
  tool_choice: "auto",
  generation_controls: { temperature: 0.2, top_p: 0.9, parallel_tool_calls: true },
  response_format: { type: "json_object" },
  cache_hint: "stable_prefix",
  stream: true,
  source_surface: "chat",
} satisfies CanonicalRequest;

const responsesRequest = {
  model: "responses-model",
  instructions: [{ kind: "text", text: "Be concise." }],
  messages: [{ role: "developer", content: [{ kind: "text", text: "Use JSON." }] }],
  reasoning: {
    effort: "medium",
    mode: "standard",
    summary: "brief",
    context: "all_turns",
  },
  response_format: { type: "json_schema", schema: { type: "object" }, strict: true },
  cache_hint: { kind: "breakpoint", list: [2, 5] },
  generation_controls: { max_output_tokens: 256, "extension:verbosity": "low" },
  stream: false,
  source_surface: "responses",
} satisfies CanonicalRequest;

const messagesRequest = {
  model: "messages-model",
  system: [{ kind: "text", text: "You are helpful." }],
  messages: [
    {
      role: "user",
      content: [
        { kind: "image", payload: { media_type: "image/png", data: "opaque" } },
        { kind: "text", text: "Describe this." },
      ],
    },
  ],
  reasoning: { thinking_type: "adaptive", budget_tokens: 1024 },
  generation_controls: { top_k: 20, stop: ["END"] },
  stream: true,
  source_surface: "messages",
} satisfies CanonicalRequest;

const opaqueReasoning = {
  kind: "reasoning",
  payload: { encrypted: "provider-owned", signature: "opaque" },
  opaque: true,
} satisfies ContentPart;

const extensionPart = {
  kind: "extension",
  name: "provider-only-control",
  payload: { value: "must-not-be-downgraded" },
} satisfies ContentPart;

const reportedUsage = {
  input_tokens: 100,
  cached_input_tokens: 40,
  cache_write_tokens: 10,
  uncached_input_tokens: 60,
  output_tokens: 25,
  reasoning_tokens: 5,
  estimated_cost: 0.012,
} satisfies UsageRecord;

const unavailableUsage = {
  input_tokens: 100,
  cached_input_tokens: "unavailable",
  cache_write_tokens: "unavailable",
  uncached_input_tokens: "unavailable",
  output_tokens: 25,
  reasoning_tokens: "unavailable",
  estimated_cost: 0.012,
} satisfies UsageRecord;

const canonicalEvents = [
  { type: "message_start", sequence_number: 1, event_id: "evt-1" },
  { type: "response_start", sequence_number: 2, model: "chat-model" },
  { type: "content_delta", sequence_number: 3, content: { kind: "text", text: "Hi" } },
  {
    type: "tool_call_delta",
    sequence_number: 4,
    call_id: "call-a",
    name: "lookup",
    arguments_delta: '{"key":',
  },
  {
    type: "tool_result",
    sequence_number: 5,
    call_id: "call-a",
    content: [{ kind: "text", text: "a-result" }],
  },
  { type: "usage", sequence_number: 6, usage: reportedUsage },
  { type: "keepalive", sequence_number: 7 },
  { type: "error", sequence_number: 8, category: "upstream", message: "bounded" },
  { type: "terminal", sequence_number: 9, state: "complete", usage: reportedUsage },
] satisfies CanonicalEvent[];

const cacheHints = ["stable_prefix", { kind: "breakpoint", list: [0, 3, 8] }] satisfies CacheHint[];

describe("canonical request shapes", () => {
  test("accepts the three source surfaces without surface-specific fields", () => {
    expect([
      chatRequest.source_surface,
      responsesRequest.source_surface,
      messagesRequest.source_surface,
    ]).toEqual(["chat", "responses", "messages"]);
    expect(chatRequest.messages[0]?.content[0]).toEqual({ kind: "text", text: "Hello" });
    expect(responsesRequest.instructions?.[0]).toEqual({ kind: "text", text: "Be concise." });
    expect(messagesRequest.system?.[0]).toEqual({ kind: "text", text: "You are helpful." });
  });

  test("keeps content part and parallel tool ordering", () => {
    expect(parallelParts.map((part) => part.kind)).toEqual([
      "toolCall",
      "toolCall",
      "toolResult",
      "toolResult",
    ]);
    expect(parallelParts[0]).toMatchObject({ call_id: "call-a", name: "lookup", index: 0 });
    expect(parallelParts[1]).toMatchObject({ call_id: "call-b", name: "lookup", index: 1 });
    expect(parallelParts[2]).toMatchObject({ call_id: "call-a" });
    expect(parallelParts[3]).toMatchObject({ call_id: "call-b" });
  });

  test("keeps reasoning artifacts opaque and unsupported material as extensions", () => {
    expect(opaqueReasoning.kind).toBe("reasoning");
    expect(opaqueReasoning.opaque).toBe(true);
    expect(opaqueReasoning.payload).toEqual({ encrypted: "provider-owned", signature: "opaque" });
    expect(extensionPart).toEqual({
      kind: "extension",
      name: "provider-only-control",
      payload: { value: "must-not-be-downgraded" },
    });
  });
});

describe("canonical cache and usage contracts", () => {
  test("represents stable prefixes and ordered breakpoints", () => {
    expect(cacheHints).toEqual(["stable_prefix", { kind: "breakpoint", list: [0, 3, 8] }]);
    expect(cacheHints[1]).toMatchObject({ kind: "breakpoint", list: [0, 3, 8] });
  });

  test("does not double-count cached input", () => {
    expect(reportedUsage.uncached_input_tokens).toBe(
      reportedUsage.input_tokens - reportedUsage.cached_input_tokens,
    );
    expect(unavailableUsage.cached_input_tokens).toBe("unavailable");
    expect(unavailableUsage.cache_write_tokens).toBe("unavailable");
    expect(unavailableUsage.reasoning_tokens).toBe("unavailable");
  });
});

describe("canonical events", () => {
  test("accepts every event variant with strictly increasing sequence numbers", () => {
    expect(canonicalEvents.map((event) => event.type)).toEqual([
      "message_start",
      "response_start",
      "content_delta",
      "tool_call_delta",
      "tool_result",
      "usage",
      "keepalive",
      "error",
      "terminal",
    ]);
    expect(canonicalEvents.map((event) => event.sequence_number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(canonicalEvents.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });

  test("allows only the three terminal states", () => {
    const terminalStates = ["complete", "failed", "aborted"] as const;
    const terminals = terminalStates.map((state, index) => ({
      type: "terminal" as const,
      sequence_number: index + 1,
      state,
    }));

    expect(terminals.map((event) => event.state)).toEqual(["complete", "failed", "aborted"]);
  });
});
});

describe("summarizeParts", () => {
  const baseRequest: CanonicalRequest = {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };

  test("detects image, tool activity, reasoning, and extensions in one pass", () => {
    const request: CanonicalRequest = {
      ...baseRequest,
      system: [{ kind: "extension", name: "server_tool_use", payload: {} }],
      messages: [
        {
          role: "user",
          content: [
            { kind: "image", payload: {} },
            { kind: "reasoning", payload: {}, opaque: true, encrypted_content: "abc" },
            { kind: "toolCall", call_id: "c", name: "t", arguments: "{}", index: 0 },
          ],
        },
      ],
    };
    const summary = summarizeParts(request);
    expect(summary.hasImage).toBe(true);
    expect(summary.hasToolActivity).toBe(true);
    expect(summary.hasOpaqueReasoning).toBe(true);
    expect(summary.hasEncryptedReasoning).toBe(true);
    expect([...summary.extensionNames]).toEqual(["server_tool_use"]);
  });

  test("memoizes per request object and reports an empty summary when clean", () => {
    const summary = summarizeParts(baseRequest);
    expect(summary.hasImage).toBe(false);
    expect(summary.hasToolActivity).toBe(false);
    expect(summary.extensionNames.size).toBe(0);
    // Same object → same memoized summary instance.
    expect(summarizeParts(baseRequest)).toBe(summary);
  });
});

describe("publicGatewayErrorDetails", () => {
  test("exposes accounts_unavailable reasons and candidate_count to public clients", () => {
    const details = publicGatewayErrorDetails(
      accountsUnavailableError("cb/x", ["cooldown", "unhealthy"]),
    );
    expect(details.reasons).toEqual(["cooldown", "unhealthy"]);
    expect(details.candidate_count).toBe(2);
  });
});
