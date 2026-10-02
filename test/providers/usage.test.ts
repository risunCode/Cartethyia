/**
 * Cross-wire token usage accounting.
 *
 * Every proxied request reports token counts in a shape specific to its
 * upstream, and the gateway reconciles them into one canonical record. The
 * shapes disagree in ways that are easy to get subtly wrong, and each wrong
 * answer is a real cost:
 *
 * - **Anthropic reports fresh tokens only.** `input_tokens` excludes the cache
 *   read and write volumes, which arrive in their own fields. **OpenAI reports
 *   an all-in total** with the cached subset inside `*_tokens_details`. Reading
 *   one as the other double-counts or under-counts the input on every cached
 *   turn.
 * - **The same cache number has five different spellings** across the provider
 *   families the gateway bridges, and one of them
 *   (`*_tokens_details.cached_tokens`) is stamped with a constant `0` by the
 *   DeepSeek-family bridges while the real count sits flat in
 *   `prompt_cache_hit_tokens`. Preferring the details field silently reports
 *   every cache hit as a miss.
 * - **Absence is not zero.** A provider that omits its usage frame is
 *   *unmeasured*, and `normalizeUsage({})` produces a record of zeros — the
 *   same shape a genuinely measured all-zero turn has. Conflating them makes
 *   the dispatch's conservative estimate unreachable, so the turn reconciles to
 *   zero and its token budget is refunded in full.
 *
 * The wire builders are the inverse direction, and their maths differs per
 * surface on purpose: Messages must not double-count when a client sums
 * `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`,
 * which the official SDK docs instruct it to do.
 *
 * Everything here is a pure function of a plain object.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeUsage,
  usageFromProvider,
  usageToChatWire,
  usageToMessagesWire,
  usageToResponsesWire,
  type OpenAiUsage,
} from "../../src/providers/usage";
import type { UsageRecord } from "../../src/transport/canonical-model";

describe("normalizeUsage: the OpenAI shape", () => {
  test("reads prompt and completion tokens", () => {
    const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 40 });
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(40);
  });

  test("treats the reported total as all-in and derives the uncached part", () => {
    // OpenAI's `prompt_tokens` includes the cached subset, so uncached is
    // total minus cached — not the other way round.
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 60 },
    });
    expect(usage.cached_input_tokens).toBe(60);
    expect(usage.uncached_input_tokens).toBe(40);
    // The canonical total stays the provider's own all-in figure.
    expect(usage.input_tokens).toBe(100);
  });

  test("clamps a cached count larger than the total rather than going negative", () => {
    const usage = normalizeUsage({
      prompt_tokens: 50,
      prompt_tokens_details: { cached_tokens: 999 },
    });
    expect(usage.cached_input_tokens).toBe(50);
    expect(usage.uncached_input_tokens).toBe(0);
  });

  test("reads the Responses API details field as well", () => {
    const usage = normalizeUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 25 },
    });
    expect(usage.cached_input_tokens).toBe(25);
    expect(usage.uncached_input_tokens).toBe(75);
  });

  test("a negative token count is clamped to zero", () => {
    const usage = normalizeUsage({ prompt_tokens: -5, completion_tokens: -1 });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  test("a non-numeric count is not read", () => {
    const usage = normalizeUsage({ prompt_tokens: "100", completion_tokens: null });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });
});

describe("normalizeUsage: the Anthropic shape", () => {
  test("input_tokens counts fresh tokens only, and the total adds the cache volumes", () => {
    // The distinction the whole module exists for: Anthropic's `input_tokens`
    // excludes the cache read and write, so the canonical all-in total is
    // fresh + read + written.
    const usage = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 30,
    });
    expect(usage.uncached_input_tokens).toBe(10);
    expect(usage.cached_input_tokens).toBe(90);
    expect(usage.cache_write_tokens).toBe(30);
    expect(usage.input_tokens).toBe(130);
  });

  test("a cache read with no write still adds the read to the total", () => {
    const usage = normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 90 });
    expect(usage.input_tokens).toBe(100);
    expect(usage.cache_write_tokens).toBe("unavailable");
  });

  test("a write-only report records the write but leaves the total alone", () => {
    // Measured: with no cache *read* field the payload is not the Anthropic
    // cache shape, so the inclusive-total maths applies and `input_tokens` is
    // not augmented. The write volume is still recorded for the cost
    // calculation. Documented as-is rather than asserted as ideal.
    const usage = normalizeUsage({ input_tokens: 10, cache_creation_input_tokens: 30 });
    expect(usage.input_tokens).toBe(10);
    expect(usage.cached_input_tokens).toBe("unavailable");
    expect(usage.cache_write_tokens).toBe(30);
  });

  test("sums the cache_creation breakdown when the flat field is absent", () => {
    const usage = normalizeUsage({
      input_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 },
    });
    expect(usage.cache_write_tokens).toBe(25);
  });

  test("an all-zero breakdown reports unavailable rather than a measured zero", () => {
    // A breakdown object that names no volume is not a measurement of zero
    // writes; it is a provider that did not report.
    const usage = normalizeUsage({
      input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    });
    expect(usage.cache_write_tokens).toBe("unavailable");
  });

  test("a missing field is unavailable, never zero", () => {
    // The distinction that keeps the dispatch's estimate reachable.
    const usage = normalizeUsage({ input_tokens: 10, output_tokens: 1 });
    expect(usage.cached_input_tokens).toBe("unavailable");
    expect(usage.cache_write_tokens).toBe("unavailable");
    expect(usage.uncached_input_tokens).toBe("unavailable");
    expect(usage.reasoning_tokens).toBe("unavailable");
  });
});

describe("normalizeUsage: the cache-count spellings", () => {
  test("reads DeepSeek's flat prompt_cache_hit_tokens", () => {
    const usage = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 70 });
    expect(usage.cached_input_tokens).toBe(70);
  });

  test("prefers the flat hit count over a zeroed details field", () => {
    // The measured bridge behaviour: the real count is flat while
    // `prompt_tokens_details.cached_tokens` is a constant 0. Preferring the
    // details field reports every cache hit as a miss.
    const usage = normalizeUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 70,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage.cached_input_tokens).toBe(70);
  });

  test("reads Gemini's flat cached_tokens", () => {
    const usage = normalizeUsage({ prompt_tokens: 100, cached_tokens: 30 });
    expect(usage.cached_input_tokens).toBe(30);
  });

  test("reads Gemini's cachedContentTokenCount", () => {
    const usage = normalizeUsage({ prompt_tokens: 100, cachedContentTokenCount: 30 });
    expect(usage.cached_input_tokens).toBe(30);
  });

  test("the DeepSeek flat field outranks the Anthropic field, against the field order", () => {
    // Measured, and contrary to what the branch order suggests: the
    // `prompt_cache_hit_tokens` check runs *after* the Anthropic one but
    // assigns unconditionally, so it wins. Pinned as the real behaviour —
    // the two fields do not co-occur on any bridged provider, so the
    // precedence is unobservable in practice, but it should not be a surprise
    // if one ever sends both.
    const usage = normalizeUsage({
      input_tokens: 1,
      cache_read_input_tokens: 11,
      prompt_cache_hit_tokens: 22,
    });
    expect(usage.cached_input_tokens).toBe(22);
  });

  test("the Anthropic field outranks the remaining flat and nested spellings", () => {
    const usage = normalizeUsage({
      input_tokens: 1,
      cache_read_input_tokens: 11,
      cached_tokens: 33,
      cachedContentTokenCount: 44,
      prompt_tokens_details: { cached_tokens: 55 },
    });
    expect(usage.cached_input_tokens).toBe(11);
  });
});

describe("normalizeUsage: reasoning tokens", () => {
  test("reads Anthropic's thinking_tokens", () => {
    const usage = normalizeUsage({
      output_tokens: 100,
      output_tokens_details: { thinking_tokens: 40 },
    });
    expect(usage.reasoning_tokens).toBe(40);
  });

  test("reads OpenAI's reasoning_tokens", () => {
    const usage = normalizeUsage({
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    expect(usage.reasoning_tokens).toBe(40);
  });

  test("the Anthropic key wins when both are present", () => {
    const usage = normalizeUsage({
      output_tokens_details: { thinking_tokens: 40, reasoning_tokens: 99 },
    });
    expect(usage.reasoning_tokens).toBe(40);
  });

  test("prediction counts are carried through into details", () => {
    const usage = normalizeUsage({
      output_tokens_details: {
        accepted_prediction_tokens: 7,
        rejected_prediction_tokens: 3,
      },
    });
    expect(usage.details?.accepted_prediction_tokens).toBe(7);
    expect(usage.details?.rejected_prediction_tokens).toBe(3);
  });

  test("no details object is emitted when there is nothing to put in it", () => {
    expect(normalizeUsage({ input_tokens: 1 })).not.toHaveProperty("details");
  });
});

describe("normalizeUsage: credit", () => {
  test("carries a non-negative finite credit through", () => {
    expect(normalizeUsage({ credit: 1.01 }).credit_used).toBe(1.01);
  });

  test("zero credit is a real measurement and is carried", () => {
    // Probed live: a 29-token turn reports credit 0 while a 72k-token turn
    // reports 1.01. Zero is a value, not an absence.
    expect(normalizeUsage({ credit: 0 }).credit_used).toBe(0);
  });

  test("a negative or non-finite credit is dropped rather than clamped", () => {
    // Clamping to 0 would invent a measurement the provider did not make.
    expect(normalizeUsage({ credit: -1 })).not.toHaveProperty("credit_used");
    expect(normalizeUsage({ credit: Number.NaN })).not.toHaveProperty("credit_used");
    expect(normalizeUsage({ credit: Number.POSITIVE_INFINITY })).not.toHaveProperty("credit_used");
  });

  test("a non-numeric credit is dropped", () => {
    expect(normalizeUsage({ credit: "1.01" })).not.toHaveProperty("credit_used");
  });
});

describe("usageFromProvider: absence is not zero", () => {
  test("a non-object payload is unmeasured", () => {
    for (const raw of [null, undefined, 42, "usage", true]) {
      expect(usageFromProvider(raw)).toBeUndefined();
    }
  });

  test("an empty usage object is unmeasured, not a measured zero", () => {
    // `normalizeUsage({})` yields a record of zeros, which is the same shape a
    // genuinely measured all-zero turn has. Returning it would make the
    // dispatch's conservative estimate unreachable.
    expect(usageFromProvider({})).toBeUndefined();
  });

  test("a usage object of explicit zeros is also unmeasured", () => {
    expect(usageFromProvider({ prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined();
  });

  test("any positive count makes it a measurement", () => {
    expect(usageFromProvider({ prompt_tokens: 1 })).toBeDefined();
    expect(usageFromProvider({ completion_tokens: 1 })).toBeDefined();
    expect(usageFromProvider({ prompt_cache_hit_tokens: 1, prompt_tokens: 1 })).toBeDefined();
    expect(usageFromProvider({ cache_read_input_tokens: 1 })).toBeDefined();
    expect(usageFromProvider({ cache_creation_input_tokens: 1 })).toBeDefined();
    expect(usageFromProvider({ output_tokens_details: { reasoning_tokens: 1 } })).toBeDefined();
  });

  test("a cache count with no input total is clamped away and reads as unmeasured", () => {
    // Measured boundary, not an intent: on the OpenAI-inclusive path the cached
    // count is clamped to the total (`Math.min(input_tokens, cached)`), so a
    // payload carrying only a cache count has nothing left to report and
    // normalizes to all zeros. A real provider always sends the total beside
    // the cache fields, so this only affects a malformed frame — and treating
    // it as unmeasured is the safe direction, since the dispatch then falls
    // back to its conservative estimate rather than reconciling to zero.
    expect(usageFromProvider({ prompt_cache_hit_tokens: 1 })).toBeUndefined();
    expect(usageFromProvider({ prompt_tokens: 0, prompt_cache_hit_tokens: 5 })).toBeUndefined();
  });

  test("a reported payload is normalized rather than passed through", () => {
    const usage = usageFromProvider({ prompt_tokens: 100, completion_tokens: 5 });
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.output_tokens).toBe(5);
  });
});

describe("usageToChatWire", () => {
  const usage: UsageRecord = {
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_tokens: "unavailable",
    uncached_input_tokens: 40,
    output_tokens: 20,
    reasoning_tokens: 8,
    estimated_cost: null,
  };

  test("reports prompt, completion, and their sum", () => {
    const wire: OpenAiUsage = usageToChatWire(usage);
    expect(wire.prompt_tokens).toBe(100);
    expect(wire.completion_tokens).toBe(20);
    expect(wire.total_tokens).toBe(120);
  });

  test("nests the cached count in prompt_tokens_details", () => {
    expect(usageToChatWire(usage).prompt_tokens_details).toEqual({ cached_tokens: 60 });
  });

  test("nests the reasoning count in completion_tokens_details", () => {
    expect(usageToChatWire(usage).completion_tokens_details).toEqual({ reasoning_tokens: 8 });
  });

  test("an unavailable cache count is omitted, not written as a value", () => {
    const bare: UsageRecord = {
      ...usage,
      cached_input_tokens: "unavailable",
      reasoning_tokens: "unavailable",
    };
    const wire = usageToChatWire(bare);
    expect(wire).not.toHaveProperty("prompt_tokens_details");
    expect(wire).not.toHaveProperty("completion_tokens_details");
  });

  test("prediction counts are carried into the completion details", () => {
    const withPredictions: UsageRecord = {
      ...usage,
      reasoning_tokens: "unavailable",
      details: { accepted_prediction_tokens: 5, rejected_prediction_tokens: 2 },
    };
    expect(usageToChatWire(withPredictions).completion_tokens_details).toEqual({
      accepted_prediction_tokens: 5,
      rejected_prediction_tokens: 2,
    });
  });
});

describe("usageToResponsesWire", () => {
  const usage: UsageRecord = {
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_tokens: "unavailable",
    uncached_input_tokens: 40,
    output_tokens: 20,
    reasoning_tokens: 8,
    estimated_cost: null,
  };

  test("reports the root totals", () => {
    const wire = usageToResponsesWire(usage);
    expect(wire["input_tokens"]).toBe(100);
    expect(wire["output_tokens"]).toBe(20);
    expect(wire["total_tokens"]).toBe(120);
  });

  test("cached and reasoning counts appear both at the root and nested", () => {
    // The historical duality: the xAI bridge reads the root fields while the
    // OpenAI shape reads the nested ones, so both must be present.
    const wire = usageToResponsesWire(usage);
    expect(wire["cached_input_tokens"]).toBe(60);
    expect(wire["input_tokens_details"]).toEqual({ cached_tokens: 60 });
    expect(wire["reasoning_tokens"]).toBe(8);
    expect(wire["output_tokens_details"]).toEqual({ reasoning_tokens: 8 });
  });

  test("unavailable counts produce neither root nor nested fields", () => {
    const bare: UsageRecord = {
      ...usage,
      cached_input_tokens: "unavailable",
      reasoning_tokens: "unavailable",
    };
    const wire = usageToResponsesWire(bare);
    expect(wire).not.toHaveProperty("cached_input_tokens");
    expect(wire).not.toHaveProperty("input_tokens_details");
    expect(wire).not.toHaveProperty("reasoning_tokens");
    expect(wire).not.toHaveProperty("output_tokens_details");
  });
});

describe("usageToMessagesWire", () => {
  test("an undefined record reports a zero pair rather than throwing", () => {
    expect(usageToMessagesWire(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  test("subtracts the cache volumes so a client summing the fields does not double-count", () => {
    // The official SDK docs instruct a client to sum input_tokens +
    // cache_read_input_tokens + cache_creation_input_tokens. Sending the
    // all-in total in `input_tokens` would count the cached tokens twice.
    const usage: UsageRecord = {
      input_tokens: 130,
      cached_input_tokens: 90,
      cache_write_tokens: 30,
      uncached_input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: "unavailable",
      estimated_cost: null,
    };
    const wire = usageToMessagesWire(usage);
    expect(wire["input_tokens"]).toBe(10);
    expect(wire["cache_read_input_tokens"]).toBe(90);
    expect(wire["cache_creation_input_tokens"]).toBe(30);
    // The client's sum recovers the canonical total.
    expect(
      Number(wire["input_tokens"]) +
        Number(wire["cache_read_input_tokens"]) +
        Number(wire["cache_creation_input_tokens"]),
    ).toBe(130);
  });

  test("passes the total through when the provider reported no cache info", () => {
    // There is nothing to subtract, so the all-in figure is the only truth.
    const usage: UsageRecord = {
      input_tokens: 100,
      cached_input_tokens: "unavailable",
      cache_write_tokens: "unavailable",
      uncached_input_tokens: "unavailable",
      output_tokens: 5,
      reasoning_tokens: "unavailable",
      estimated_cost: null,
    };
    const wire = usageToMessagesWire(usage);
    expect(wire["input_tokens"]).toBe(100);
    expect(wire).not.toHaveProperty("cache_read_input_tokens");
    expect(wire).not.toHaveProperty("cache_creation_input_tokens");
  });

  test("never reports a negative input count", () => {
    // Defensive: a record whose uncached figure exceeds its total would
    // otherwise put a negative number on the wire.
    const usage: UsageRecord = {
      input_tokens: 10,
      cached_input_tokens: 5,
      cache_write_tokens: "unavailable",
      uncached_input_tokens: -3,
      output_tokens: 1,
      reasoning_tokens: "unavailable",
      estimated_cost: null,
    };
    expect(usageToMessagesWire(usage)["input_tokens"]).toBe(0);
  });

  test("reports reasoning as Anthropic's thinking_tokens", () => {
    const usage: UsageRecord = {
      input_tokens: 10,
      cached_input_tokens: "unavailable",
      cache_write_tokens: "unavailable",
      uncached_input_tokens: "unavailable",
      output_tokens: 5,
      reasoning_tokens: 7,
      estimated_cost: null,
    };
    expect(usageToMessagesWire(usage)["output_tokens_details"]).toEqual({ thinking_tokens: 7 });
  });

  test("a measured zero cache count is still reported, unlike an unavailable one", () => {
    const usage: UsageRecord = {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_tokens: "unavailable",
      uncached_input_tokens: 10,
      output_tokens: 1,
      reasoning_tokens: "unavailable",
      estimated_cost: null,
    };
    expect(usageToMessagesWire(usage)["cache_read_input_tokens"]).toBe(0);
  });
});

describe("the round trip through a wire builder keeps the canonical totals", () => {
  test("a cached OpenAI turn survives normalize then chat-wire", () => {
    const normalized = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
    });
    const wire = usageToChatWire(normalized);
    expect(wire.prompt_tokens).toBe(100);
    expect(wire.prompt_tokens_details?.cached_tokens).toBe(60);
  });

  test("a cached Anthropic turn survives normalize then messages-wire", () => {
    const normalized = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 30,
    });
    const wire = usageToMessagesWire(normalized);
    expect(wire["input_tokens"]).toBe(10);
    expect(wire["cache_read_input_tokens"]).toBe(90);
    expect(wire["cache_creation_input_tokens"]).toBe(30);
  });

  test("the same canonical record produces a consistent total on every wire", () => {
    // Chat and Responses report the all-in total; Messages splits it into
    // fresh + read + write. All three must agree once summed.
    const normalized = normalizeUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 30,
    });
    const chat = usageToChatWire(normalized);
    const responses = usageToResponsesWire(normalized);
    const messages = usageToMessagesWire(normalized);
    const messagesTotal =
      Number(messages["input_tokens"]) +
      Number(messages["cache_read_input_tokens"] ?? 0) +
      Number(messages["cache_creation_input_tokens"] ?? 0);
    expect(chat.prompt_tokens).toBe(130);
    expect(responses["input_tokens"]).toBe(130);
    expect(messagesTotal).toBe(130);
  });
});
