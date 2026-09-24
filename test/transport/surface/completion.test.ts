import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, UsageRecord } from "../../../src/transport/canonical-model";
import { CompletionAdapter, CompletionStreamEncoder } from "../../../src/transport/surface/completion";

const usage: UsageRecord = {
  input_tokens: 3,
  cached_input_tokens: "unavailable",
  cache_write_tokens: "unavailable",
  uncached_input_tokens: 3,
  output_tokens: 2,
  reasoning_tokens: "unavailable",
  estimated_cost: 0,
};

const events: CanonicalEvent[] = [
  { type: "response_start", sequence_number: 1, model: "test-model" },
  { type: "content_delta", sequence_number: 2, content: { kind: "text", text: "world" } },
  { type: "terminal", sequence_number: 3, state: "complete", stop_reason: "stop", usage },
];

describe("CompletionAdapter", () => {
  test("parses prompt arrays and completion generation controls", () => {
    const request = new CompletionAdapter().parse({
      model: "test-model",
      prompt: ["one", "two"],
      max_tokens: 20,
      n: 2,
      echo: true,
      suffix: "!",
      stop: ["END"],
      temperature: 0.4,
      top_p: 0.9,
      logprobs: 4,
      seed: 8,
      reasoning_level: "high",
    });
    expect(request).toMatchObject({
      model: "test-model",
      source_surface: "completion",
      messages: [
        { role: "user", content: [{ kind: "text", text: "one" }] },
        { role: "user", content: [{ kind: "text", text: "two" }] },
      ],
      generation_controls: {
        max_tokens: 20,
        n: 2,
        stop: ["END"],
        logprobs: true,
        top_logprobs: 4,
        "extension:completion.echo": true,
         "extension:completion.suffix": "!",
      },
      reasoning: { effort: "high" },
    });
    expect(new CompletionAdapter().matchesBodyShape({ prompt: "hello" })).toBe(true);
  });
  test("rejects bodies without a usable prompt", () => {
    for (const body of [
      {},
      { model: "test-model" },
      { model: "test-model", messages: [{ role: "user", content: "say ok" }] },
    ]) {
      let caught: unknown;
      try {
        new CompletionAdapter().parse(body);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "invalid_request", status: 400 });
    }
  });

  test("encodes non-streaming text completion with echo and suffix", () => {
    const output = new CompletionAdapter().encodeOutput(events, {
      response_id: "cmpl-1",
      prompt: "hello ",
      echo: true,
      suffix: "!",
      created: 10,
    });
    const response = JSON.parse(new TextDecoder().decode(output.bytes)) as Record<string, unknown>;
    expect(response).toMatchObject({
      id: "cmpl-1",
      object: "text_completion",
      created: 10,
      model: "test-model",
      choices: [{ text: "hello world!", index: 0, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  test("encodes streaming deltas and the terminal reason through the live stream encoder", () => {
    const encoder = new CompletionStreamEncoder({ model: "test-model", response_id: "cmpl-2" });
    const chunks = [...events.flatMap((event) => encoder.push(event)), ...encoder.finish()];
    const wire = JSON.stringify(chunks);
    expect(wire).toContain('"text":"world"');
    expect(wire).toContain('"finish_reason":"stop"');
  });
});
