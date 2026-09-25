import { describe, expect, test } from "bun:test";
import { normalizeUsage, repriceUsage, usageToChatWire, usageToMessagesWire, usageToResponsesWire } from "../../src/providers/usage";
import type { UsageRecord } from "../../src/transport/canonical-model";
import { modelsDevCatalog } from "../../src/providers/discovery/models-dev-catalog";
import { computeTokensPerSec } from "../../src/observability/token-speed";

describe("normalizeUsage", () => {
  test("extracts cached tokens from Chat Completions usage", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(10);
    expect(usage.cached_input_tokens).toBe(40);
    expect(usage.uncached_input_tokens).toBe(60);
  });

  test("extracts cached tokens from Responses usage", () => {
    const usage = normalizeUsage({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      input_tokens_details: { cached_tokens: 40 },
    });
    expect(usage.cached_input_tokens).toBe(40);
  });

  test("extracts DeepSeek-family cached tokens", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60,
    });
    expect(usage.cached_input_tokens).toBe(40);
    expect(usage.uncached_input_tokens).toBe(60);
  });

  test("DeepSeek flat hit wins over zeroed prompt_tokens_details (CodeBuddy)", () => {
    // CodeBuddy stamps prompt_tokens_details.cached_tokens with a constant 0
    // while carrying the real hit count flat — the zero must not shadow it.
    const usage = normalizeUsage({
      prompt_tokens: 1592,
      completion_tokens: 10,
      total_tokens: 1602,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 1408,
      prompt_cache_miss_tokens: 184,
    });
    expect(usage.cached_input_tokens).toBe(1408);
    expect(usage.uncached_input_tokens).toBe(184);
  });

  test("extracts flat cached_tokens (Gemini/mapGeminiUsage shape)", () => {
    const usage = normalizeUsage({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cached_tokens: 40,
    });
    expect(usage.cached_input_tokens).toBe(40);
  });

  test("leaves cache unavailable when no cache fields are present", () => {
    const usage = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });
    expect(usage.cached_input_tokens).toBe("unavailable");
  });
});

describe("repriceUsage", () => {
  test("uses the routed model's prebuilt base catalog rates", () => {
    const usage = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 600,
      completion_tokens: 100,
    });
    const repriced = repriceUsage(usage, "openai", "gpt-4o");
    const catalog = modelsDevCatalog.costFor("openai", "gpt-4o");
    const expected =
      (400 * (catalog.input ?? 0) +
        600 * (catalog.cache_read ?? catalog.input ?? 0) +
        100 * (catalog.output ?? 0)) /
      1_000_000;
    expect(repriced.estimated_cost).toBeCloseTo(expected, 12);
  });

  test("reports an unpriced route as null, never as a measured zero", () => {
    // Zero is a real answer (a free tier); `null` is what lets the console's
    // `partial` flag count the row as unpriced instead of reporting `$0.00` as
    // if it were measured.
    const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10 });
    expect(repriceUsage(usage, "unknown", "unknown-model").estimated_cost).toBeNull();
  });

  test("prices the input side when the upstream reported no cache breakdown", () => {
    // The common case: a plain OpenAI-compatible response with no cache
    // details. `uncached_input_tokens` is then `"unavailable"`, and reading it
    // as zero priced only the output — a million prompt tokens cost nothing.
    const usage = normalizeUsage({ prompt_tokens: 1_000_000, completion_tokens: 500_000 });
    expect(usage.uncached_input_tokens).toBe("unavailable");

    const repriced = repriceUsage(usage, "openai", "gpt-4o");
    const catalog = modelsDevCatalog.costFor("openai", "gpt-4o");
    const expected =
      (1_000_000 * (catalog.input ?? 0) + 500_000 * (catalog.output ?? 0)) / 1_000_000;
    expect(expected).toBeGreaterThan(0);
    expect(repriced.estimated_cost).toBeCloseTo(expected, 12);
    // Guard against the regression specifically: output-only pricing is half.
    expect(repriced.estimated_cost).toBeGreaterThan((500_000 * (catalog.output ?? 0)) / 1_000_000);
  });

  test("a cache-less turn prices the same as an explicitly all-uncached record", () => {
    // `uncached_input_tokens` unavailable and an explicit uncached count of the
    // same size describe the same billing; both must price identically. The
    // explicit side is the shape the dispatch estimate produces.
    const implicit = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100 });
    expect(implicit.uncached_input_tokens).toBe("unavailable");
    const explicit: typeof implicit = {
      ...implicit,
      uncached_input_tokens: 1000,
    };
    expect(repriceUsage(implicit, "openai", "gpt-4o").estimated_cost).toBe(
      repriceUsage(explicit, "openai", "gpt-4o").estimated_cost,
    );
  });

  test("a cached turn still bills the cached portion at the cache rate", () => {
    // The input fallback must not shadow a real cache breakdown.
    const usage = normalizeUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens: 100,
    });
    expect(usage.uncached_input_tokens).toBe(400);
    const repriced = repriceUsage(usage, "openai", "gpt-4o");
    const catalog = modelsDevCatalog.costFor("openai", "gpt-4o");
    const expected =
      (400 * (catalog.input ?? 0) +
        600 * (catalog.cache_read ?? catalog.input ?? 0) +
        100 * (catalog.output ?? 0)) /
      1_000_000;
    expect(repriced.estimated_cost).toBeCloseTo(expected, 12);
  });
});
describe("usage-to-wire builders (E1)", () => {
  const full: UsageRecord = {
    input_tokens: 100,
    cached_input_tokens: 30,
    cache_write_tokens: 5,
    uncached_input_tokens: 70,
    output_tokens: 20,
    reasoning_tokens: 8,
    estimated_cost: 0,
  };
  const bare: UsageRecord = {
    input_tokens: 100,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: "unavailable",
    output_tokens: 20,
    reasoning_tokens: "unavailable",
    estimated_cost: 0,
  };

  test("chat builder emits totals plus cache/reasoning details", () => {
    expect(usageToChatWire(full)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 8 },
    });
    expect(usageToChatWire(bare)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
  });

  test("responses builder keeps root+nested duality", () => {
    expect(usageToResponsesWire(full)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cached_input_tokens: 30,
      input_tokens_details: { cached_tokens: 30 },
      reasoning_tokens: 8,
      output_tokens_details: { reasoning_tokens: 8 },
    });
    expect(usageToResponsesWire(bare)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    });
  });

  test("messages builder avoids SDK double-counting", () => {
    expect(usageToMessagesWire(full)).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
      output_tokens_details: { thinking_tokens: 8 },
    });
    // No cache info: raw total, nothing to subtract.
    expect(usageToMessagesWire(bare)).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(usageToMessagesWire(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("tokensPerSec calculation", () => {
  test("streaming uses the observed decode window, excluding TTFT", () => {
    // 100 output tokens decoded over 1.5s of observed streaming.
    expect(
      computeTokensPerSec({
        outputTokens: 100,
        latencyMs: 2000,
        stream: true,
        firstContentDeltaAtMs: 1000,
        lastEventAtMs: 2500,
      }),
    ).toBeCloseTo(66.67, 1);
    expect(
      computeTokensPerSec({
        outputTokens: 200,
        latencyMs: 3000,
        stream: true,
        firstContentDeltaAtMs: 1000,
        lastEventAtMs: 3000,
      }),
    ).toBeCloseTo(100, 1);
  });

  test("non-streaming falls back to end-to-end effective speed, not infinity", () => {
    // TTFT equals total latency: decode happened upstream and is
    // unobservable, so report output over total time instead of dividing
    // by a zero (or ~ms) window.
    expect(computeTokensPerSec({ outputTokens: 50, latencyMs: 1000 })).toBeCloseTo(50, 1);
  });

  test("returns undefined with no output tokens", () => {
    expect(
      computeTokensPerSec({
        outputTokens: 0,
        latencyMs: 2000,
        stream: true,
        firstContentDeltaAtMs: 500,
        lastEventAtMs: 1500,
      }),
    ).toBeUndefined();
    expect(computeTokensPerSec({ latencyMs: 2000 })).toBeUndefined();
  });

  test("handles undefined values gracefully", () => {
    expect(computeTokensPerSec({ latencyMs: 2000 })).toBeUndefined();
    // Event timings absent (non-streaming): effective speed, not undefined.
    expect(computeTokensPerSec({ outputTokens: 100, latencyMs: 2000 })).toBeCloseTo(50, 1);
  });
});

describe("normalizeUsage wire shapes", () => {

describe("normalizeUsage - Anthropic reads/writes/thinking", () => {
  test("maps Anthropic cache_read_input_tokens to cached_input_tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 500,
    });

    // Anthropic reports fresh tokens only in input_tokens; the canonical
    // total is fresh + read.
    expect(result.input_tokens).toBe(1500);
    expect(result.cached_input_tokens).toBe(500);
    expect(result.uncached_input_tokens).toBe(1000);
    expect(result.output_tokens).toBe(100);
    expect(result.cache_write_tokens).toBe("unavailable");
    expect(result.reasoning_tokens).toBe("unavailable");
  });

  test("maps Anthropic cache_creation_input_tokens to cache_write_tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 800,
    });

    expect(result.cache_write_tokens).toBe(800);
    // No read field: the reported total is the inclusive total, kept as-is.
    expect(result.input_tokens).toBe(1000);
    expect(result.cached_input_tokens).toBe("unavailable");
  });

  test("maps Anthropic output_tokens_details.thinking_tokens to reasoning_tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      output_tokens_details: {
        thinking_tokens: 250,
      },
    });

    expect(result.reasoning_tokens).toBe(250);
  });
  test("combines Anthropic read + write + thinking in single response", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 400,
      output_tokens_details: {
        thinking_tokens: 200,
      },
    });

    expect(result.cached_input_tokens).toBe(500);
    expect(result.cache_write_tokens).toBe(400);
    expect(result.reasoning_tokens).toBe(200);
    expect(result.uncached_input_tokens).toBe(1000); // fresh only
    expect(result.input_tokens).toBe(1900); // 1000 + 500 + 400
  });
});

describe("normalizeUsage - GPT-5.6+ cached/reasoning", () => {
  test("maps OpenAI input_tokens_details.cached_tokens to cached_input_tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: {
        cached_tokens: 300,
      },
    });

    expect(result.cached_input_tokens).toBe(300);
    expect(result.uncached_input_tokens).toBe(700);
  });

  test("maps OpenAI output_tokens_details.reasoning_tokens to reasoning_tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      output_tokens_details: {
        reasoning_tokens: 150,
      },
    });

    expect(result.reasoning_tokens).toBe(150);
  });

  test("GPT-5.6+ does NOT populate cache_write_tokens (marked unavailable)", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: {
        cached_tokens: 200,
      },
      output_tokens_details: {
        reasoning_tokens: 50,
      },
    });

    // OpenAI response does not include cache_write_tokens
    expect(result.cache_write_tokens).toBe("unavailable");
  });

  test("combines OpenAI cached + reasoning tokens", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: {
        cached_tokens: 400,
      },
      output_tokens_details: {
        reasoning_tokens: 200,
      },
    });

    expect(result.cached_input_tokens).toBe(400);
    expect(result.reasoning_tokens).toBe(200);
    expect(result.uncached_input_tokens).toBe(600); // 1000 - 400
  });
});

describe("normalizeUsage - pre-5.6 no-write usage", () => {
  test("OpenAI pre-5.6 has no cache_write_tokens field", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      // No cache_creation_input_tokens or cache_write_tokens
    });

    expect(result.cache_write_tokens).toBe("unavailable");
  });

  test("missing fields default to unavailable, not zero", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
    });

    expect(result.cached_input_tokens).toBe("unavailable");
    expect(result.cache_write_tokens).toBe("unavailable");
    expect(result.reasoning_tokens).toBe("unavailable");
  });
});

describe("normalizeUsage - missing cache fields", () => {
  test("partial cache info is handled correctly", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 200,
      // No cache_creation_input_tokens
      // No output_tokens_details
    });

    expect(result.cached_input_tokens).toBe(200);
    expect(result.cache_write_tokens).toBe("unavailable");
    expect(result.reasoning_tokens).toBe("unavailable");
  });

  test("no cache info leaves all cache/reasoning as unavailable", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
    });

    expect(result.cached_input_tokens).toBe("unavailable");
    expect(result.cache_write_tokens).toBe("unavailable");
    expect(result.uncached_input_tokens).toBe("unavailable");
    expect(result.reasoning_tokens).toBe("unavailable");
  });
});

describe("normalizeUsage - no double-count in uncached_input_tokens", () => {
  test("Anthropic input holds fresh tokens; total adds cached on top", () => {
    const result = normalizeUsage({
      input_tokens: 5000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
    });

    // Fresh tokens stay uncached; nothing is subtracted from them.
    expect(result.uncached_input_tokens).toBe(5000);
    expect(result.input_tokens).toBe(7000);
    expect(result.cached_input_tokens).toBe(2000);
  });

  test("when cached is unavailable, uncached is also unavailable", () => {
    const result = normalizeUsage({
      input_tokens: 5000,
      output_tokens: 500,
      // No cache info
    });

    expect(result.cached_input_tokens).toBe("unavailable");
    expect(result.uncached_input_tokens).toBe("unavailable");
  });
});


describe("normalizeUsage - complete usage record contract", () => {
  test("full record with all fields populated", () => {
    const result = normalizeUsage({
      input_tokens: 2000,
      output_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 800,
      output_tokens_details: {
        thinking_tokens: 100,
      },
      estimated_cost: 0.0425,
    }) as UsageRecord;

    // Validate all fields exist and have correct types
    expect(typeof result.input_tokens).toBe("number");
    // Fresh 2000 + read 1000 + written 800.
    expect(result.input_tokens).toBe(3800);

    expect(typeof result.cached_input_tokens).toBe("number");
    expect(result.cached_input_tokens).toBe(1000);

    expect(typeof result.cache_write_tokens).toBe("number");
    expect(result.cache_write_tokens).toBe(800);

    expect(typeof result.uncached_input_tokens).toBe("number");
    expect(result.uncached_input_tokens).toBe(2000);

    expect(typeof result.output_tokens).toBe("number");
    expect(result.output_tokens).toBe(200);

    expect(typeof result.reasoning_tokens).toBe("number");
    expect(result.reasoning_tokens).toBe(100);

    // No `model` in the payload means no catalog lookup, so the cost is
    // unknown (`null`) rather than a fabricated zero.
    expect(result.estimated_cost).toBeNull();
  });  test("typecheck: unavailable fields are string literal", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
    });

    // These should be "unavailable" string, not a number
    const cached = result.cached_input_tokens;
    const writes = result.cache_write_tokens;
    const reason = result.reasoning_tokens;
    const uncached = result.uncached_input_tokens;

    expect(cached).toBe("unavailable");
    expect(writes).toBe("unavailable");
    expect(reason).toBe("unavailable");
    expect(uncached).toBe("unavailable");
  });

  test("all input fields properly default", () => {
    const result = normalizeUsage({});

    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.cached_input_tokens).toBe("unavailable");
    expect(result.cache_write_tokens).toBe("unavailable");
    expect(result.uncached_input_tokens).toBe("unavailable");
    expect(result.reasoning_tokens).toBe("unavailable");
    // Unpriced, not free: no model was named, so no rate could be applied.
    expect(result.estimated_cost).toBeNull();
  });
});

describe("normalizeUsage - edge cases", () => {
  test("zero cache tokens is valid (not same as unavailable)", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
    });

    expect(result.cached_input_tokens).toBe(0);
    expect(result.uncached_input_tokens).toBe(1000);
  });

  test("zero reasoning tokens is valid", () => {
    const result = normalizeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      output_tokens_details: {
        thinking_tokens: 0,
      },
    });

    expect(result.reasoning_tokens).toBe(0);
  });

  test("large token counts are handled", () => {
    const result = normalizeUsage({
      input_tokens: 1000000,
      output_tokens: 100000,
      cache_read_input_tokens: 500000,
    });

    expect(result.input_tokens).toBe(1500000);
    expect(result.cached_input_tokens).toBe(500000);
    expect(result.uncached_input_tokens).toBe(1000000);
  });

});
});
