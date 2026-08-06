import { describe, expect, test } from "bun:test";
import { resolveModelMetadata, type ModelMetadataLookup } from "../../src/domain/model-metadata";

const lookup: ModelMetadataLookup = (providerId, modelId) => providerId === "openai" && modelId === "gpt-5"
  ? {
      context: { inputTokens: 256_000, outputTokens: 16_384 },
      categories: ["text", "reasoning"],
      pricing: { inputPerMillion: 0.5, outputPerMillion: 2 },
      source: "catalog",
      updatedAt: null,
    }
  : null;

describe("resolveModelMetadata", () => {
  test("labels alias metadata as a router while inheriting target details", () => {
    const metadata = resolveModelMetadata(
      "fast-model",
      {
        prefixes: new Map([["openai", "openai"]]),
        aliases: new Map([["fast-model", "openai/gpt-5"]]),
        combos: new Map(),
      },
      lookup,
    );

    expect(metadata).toMatchObject({
      kind: "router",
      context: { inputTokens: 256_000, outputTokens: 16_384 },
      categories: ["text", "reasoning"],
      pricing: { inputPerMillion: 0.5, outputPerMillion: 2 },
    });
  });
});
