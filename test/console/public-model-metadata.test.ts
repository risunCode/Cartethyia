import { describe, expect, test } from "bun:test";
import {
  advertisedMetadata,
  resolveTargetIds,
  type ModelMetadata,
} from "../../src/console/providers/catalog/public-model-store";

const meta = (contextLimit: number, outputLimit: number): ModelMetadata => ({
  contextLimit,
  outputLimit,
  modalities: { input: ["text"], output: ["text"] },
  reasoning: true,
  toolCall: true,
  webSearch: false,
  cost: null,
});

describe("public model metadata resolution", () => {
  test("walks combo members and aliases to concrete ids", () => {
    const aliases = new Map([["bansos/deepseek-v4.1-flash", "deepseek-pool"]]);
    const combos = new Map([
      ["deepseek-pool", ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"]],
    ]);
    expect(resolveTargetIds("bansos/deepseek-v4.1-flash", aliases, combos)).toEqual([
      "cb/deepseek-v4.1-flash",
      "cbcn/deepseek-v4.1-flash",
    ]);
  });

  test("uses the conservative minimum across all concrete members", () => {
    const metadata = new Map<string, ModelMetadata>([
      ["cb/deepseek-v4.1-flash", meta(1_000_000, 384_000)],
      ["cbcn/deepseek-v4.1-flash", meta(1_000_000, 50_000)],
    ]);
    const result = advertisedMetadata(
      ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"],
      metadata,
    );
    expect(result.contextLimit).toBe(1_000_000);
    expect(result.outputLimit).toBe(50_000);
  });

  test("cycle protection returns no fabricated target", () => {
    const aliases = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(resolveTargetIds("a", aliases, new Map())).toEqual([]);
  });
});
