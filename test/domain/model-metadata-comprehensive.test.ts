import { describe, expect, test } from "bun:test";
import { resolveModelMetadata, type ModelMetadataLookup } from "../../src/domain/model-metadata";
import type { ComboDefinition, ModelReferenceConfig, ResolvedModel } from "../../src/domain/routing";
import type { ModelMetadata } from "../../src/domain/contracts";

/** Builds a minimal ModelMetadata with sensible defaults. */
function meta(partial: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    context: { inputTokens: 128_000, outputTokens: 8_192 },
    categories: ["text"],
    pricing: { inputPerMillion: 1, outputPerMillion: 4 },
    source: "catalog",
    updatedAt: null,
    ...partial,
  };
}

/** A lookup backed by a plain map. */
function mapLookup(table: Map<string, ModelMetadata>): ModelMetadataLookup {
  return (providerId, modelId) => table.get(`${providerId}/${modelId}`) ?? null;
}

/** Builds a config with the given aliases and combos; prefixes map identity. */
function config(opts: {
  aliases?: ReadonlyMap<string, string>;
  combos?: ReadonlyMap<string, ComboDefinition>;
}): ModelReferenceConfig {
  const prefixes = new Map<string, string>([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["google", "google"],
  ]);
  return {
    prefixes,
    aliases: opts.aliases ?? new Map(),
    combos: opts.combos ?? new Map(),
  };
}

describe("resolveModelMetadata — direct model", () => {
  test("returns kind=model with the catalog metadata for a qualified model", () => {
    const table = new Map([["openai/gpt-5", meta({ categories: ["text", "reasoning"] })]]);
    const result = resolveModelMetadata("openai/gpt-5", config({}), mapLookup(table));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("model");
    expect(result!.context).toEqual({ inputTokens: 128_000, outputTokens: 8_192 });
    expect(result!.pricing).toEqual({ inputPerMillion: 1, outputPerMillion: 4 });
    expect(result!.source).toBe("catalog");
    expect(result!.targets).toEqual([{ providerId: "openai", modelId: "gpt-5" }] satisfies readonly ResolvedModel[]);
  });
});

describe("resolveModelMetadata — combo aggregation", () => {
  test("combines metadata from multiple component models taking the maximum bounds", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({
        context: { inputTokens: 200_000, outputTokens: 4_096 },
        pricing: { inputPerMillion: 2, outputPerMillion: 8 },
        categories: ["text", "reasoning"],
        updatedAt: "2026-01-01T00:00:00Z",
      })],
      ["anthropic/claude", meta({
        context: { inputTokens: 150_000, outputTokens: 12_000 },
        pricing: { inputPerMillion: 3, outputPerMillion: 12 },
        categories: ["text", "vision"],
        updatedAt: "2026-02-01T00:00:00Z",
      })],
    ]);
    const combo: ComboDefinition = {
      id: "powerhouse",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("powerhouse", config({ combos: new Map([["powerhouse", combo]]) }), mapLookup(table));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("combo");
    expect(result!.context).toEqual({ inputTokens: 200_000, outputTokens: 12_000 });
    expect(result!.pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 12 });
    expect(result!.categories).toEqual(["vision", "text", "reasoning"]);
    expect(result!.updatedAt).toBe("2026-02-01T00:00:00Z");
  });
});

describe("resolveModelMetadata — null lookup", () => {
  test("returns null for an unknown model without fabricating any metadata", () => {
    const table = new Map<string, ModelMetadata>();
    const result = resolveModelMetadata("openai/ghost", config({}), mapLookup(table));
    expect(result).toBeNull();
  });

  test("returns null for an unqualified model with no alias or combo", () => {
    const table = new Map<string, ModelMetadata>([["openai/gpt-5", meta()]]);
    const result = resolveModelMetadata("gpt-5", config({}), mapLookup(table));
    expect(result).toBeNull();
  });
});

describe("resolveModelMetadata — mixed source", () => {
  test("labels source as custom when any component is custom", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({ source: "catalog", updatedAt: "2026-01-01T00:00:00Z" })],
      ["anthropic/claude", meta({ source: "custom", updatedAt: "2026-03-01T00:00:00Z" })],
    ]);
    const combo: ComboDefinition = {
      id: "mixed",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("mixed", config({ combos: new Map([["mixed", combo]]) }), mapLookup(table));
    expect(result!.source).toBe("custom");
  });

  test("source stays catalog when every component is catalog", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({ source: "catalog" })],
      ["anthropic/claude", meta({ source: "catalog" })],
    ]);
    const combo: ComboDefinition = {
      id: "all-catalog",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("all-catalog", config({ combos: new Map([["all-catalog", combo]]) }), mapLookup(table));
    expect(result!.source).toBe("catalog");
  });
});

describe("resolveModelMetadata — category ordering", () => {
  test("categories are sorted in canonical order regardless of input order", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({ categories: ["reasoning"] })],
      ["anthropic/claude", meta({ categories: ["vision"] })],
      ["google/gemini", meta({ categories: ["text"] })],
    ]);
    const combo: ComboDefinition = {
      id: "sorted",
      models: ["openai/gpt-5", "anthropic/claude", "google/gemini"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("sorted", config({ combos: new Map([["sorted", combo]]) }), mapLookup(table));
    // Canonical order: vision, text, reasoning.
    expect(result!.categories).toEqual(["vision", "text", "reasoning"]);
  });
});

describe("resolveModelMetadata — updatedAt aggregation", () => {
  test("most recent timestamp wins across combo members", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({ updatedAt: "2026-01-01T00:00:00Z" })],
      ["anthropic/claude", meta({ updatedAt: "2026-06-01T00:00:00Z" })],
      ["google/gemini", meta({ updatedAt: "2026-03-01T00:00:00Z" })],
    ]);
    const combo: ComboDefinition = {
      id: "freshness",
      models: ["openai/gpt-5", "anthropic/claude", "google/gemini"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("freshness", config({ combos: new Map([["freshness", combo]]) }), mapLookup(table));
    expect(result!.updatedAt).toBe("2026-06-01T00:00:00Z");
  });

  test("null updatedAt stays null when every member has null updatedAt", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({ updatedAt: null })],
      ["anthropic/claude", meta({ updatedAt: null })],
    ]);
    const combo: ComboDefinition = {
      id: "no-dates",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("no-dates", config({ combos: new Map([["no-dates", combo]]) }), mapLookup(table));
    expect(result!.updatedAt).toBeNull();
  });
});

describe("resolveModelMetadata — router alias inherits target", () => {
  test("alias inherits context, capabilities, pricing, source, and updatedAt from its resolved target", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({
        context: { inputTokens: 256_000, outputTokens: 16_384 },
        categories: ["text", "reasoning"],
        pricing: { inputPerMillion: 0.5, outputPerMillion: 2 },
        source: "catalog",
        updatedAt: "2026-05-01T00:00:00Z",
      })],
    ]);
    const aliases = new Map([["fast-model", "openai/gpt-5"]]);
    const result = resolveModelMetadata("fast-model", config({ aliases }), mapLookup(table));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("router");
    expect(result!.context).toEqual({ inputTokens: 256_000, outputTokens: 16_384 });
    expect(result!.categories).toEqual(["text", "reasoning"]);
    expect(result!.pricing).toEqual({ inputPerMillion: 0.5, outputPerMillion: 2 });
    expect(result!.source).toBe("catalog");
    expect(result!.updatedAt).toBe("2026-05-01T00:00:00Z");
  });
});

describe("resolveModelMetadata — never fabricates", () => {
  test("unknown metadata fields stay null, never fabricated as zero", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({
        context: { inputTokens: 128_000, outputTokens: null },
        pricing: { inputPerMillion: null, outputPerMillion: 5 },
        updatedAt: null,
      })],
    ]);
    const result = resolveModelMetadata("openai/gpt-5", config({}), mapLookup(table));
    expect(result!.context.outputTokens).toBeNull();
    expect(result!.pricing.inputPerMillion).toBeNull();
    expect(result!.pricing.outputPerMillion).toBe(5);
    expect(result!.updatedAt).toBeNull();
  });

  test("combo with all-unknown members returns null, never fabricates limits or prices", () => {
    // The lookup returns null for every model — no metadata anywhere.
    const table = new Map<string, ModelMetadata>();
    const combo: ComboDefinition = {
      id: "phantoms",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("phantoms", config({ combos: new Map([["phantoms", combo]]) }), mapLookup(table));
    expect(result).toBeNull();
  });

  test("combo with mixed known/unknown members aggregates only the known ones", () => {
    const table = new Map<string, ModelMetadata>([
      ["openai/gpt-5", meta({
        context: { inputTokens: 200_000, outputTokens: 8_192 },
        pricing: { inputPerMillion: 2, outputPerMillion: 8 },
        categories: ["text"],
        updatedAt: "2026-01-01T00:00:00Z",
      })],
      // anthropic/claude has no metadata entry — must be skipped, not fabricated.
    ]);
    const combo: ComboDefinition = {
      id: "partial",
      models: ["openai/gpt-5", "anthropic/claude"],
      strategy: "fallback",
      stickyLimit: 0,
    };
    const result = resolveModelMetadata("partial", config({ combos: new Map([["partial", combo]]) }), mapLookup(table));
    expect(result).not.toBeNull();
    // Only the known member contributes; output is exactly its values.
    expect(result!.context).toEqual({ inputTokens: 200_000, outputTokens: 8_192 });
    expect(result!.pricing).toEqual({ inputPerMillion: 2, outputPerMillion: 8 });
    expect(result!.categories).toEqual(["text"]);
  });
});
