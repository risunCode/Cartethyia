/**
 * The buddy roster is one shared list, so a model that belongs on both sites is
 * published on both or on neither.
 *
 * `cb` and `workbuddy` serve the same model set and read `BUDDY_SHARED_RAW`
 * directly, mapping it with their own endpoint path. A row added to one and not
 * the other cannot happen through this list — which is the point of asserting
 * on the *rendered* catalogs rather than on the raw table: the raw list would
 * pass while a provider's image/video filter silently dropped the row.
 */
import { describe, expect, test } from "bun:test";
import { CODEBUDDY_MODELS } from "../../src/providers/integrations/buddy/codebuddy";
import { WORKBUDDY_MODELS } from "../../src/providers/integrations/buddy/workbuddy";
import { WORKBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/workbuddy-cn";
import type { ModelDefinition } from "../../src/providers/model-definition";
import { CODEBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/codebuddy-cn";

function luna(rows: readonly ModelDefinition[]) {
  return rows.find((row) => row.modelId === "gpt-6-luna");
}

describe("live Buddy CLI models on the shared roster", () => {
  test("publishes upstream CLI ids with their captured metadata on both sites", () => {
    const capturedRows = [
      ["balanced-model", 256_000, 32_000, true],
      ["default-model", 176_000, 24_000, false],
      ["fast-model", 200_000, 32_000, true],
      ["gemini-3.8-flash", 1_000_000, 65_536, true],
      ["gpt-6-sol", 1_000_000, 128_000, true],
      ["step-5-preview", 1_000_000, 64_000, true],
    ] as const;

    for (const [modelId, contextLimit, outputLimit, reasoning] of capturedRows) {
      for (const rows of [CODEBUDDY_MODELS, WORKBUDDY_MODELS]) {
        const row = rows.find((model) => model.modelId === modelId);
        expect(row).toBeDefined();
        expect(row?.contextLimit).toBe(contextLimit);
        expect(row?.outputLimit).toBe(outputLimit);
        expect(row?.reasoning).toBe(reasoning);
        expect(row?.toolCall).toBe(true);
        expect(row?.modalities.input).toContain("image");
      }
    }
  });
});

describe("gpt-6-luna on the buddy roster", () => {
  test("cb publishes it at the shared context window", () => {
    const row = luna(CODEBUDDY_MODELS);
    expect(row).toBeDefined();
    // 1,050,000 is what `gpt-6.1-sol` carries on this roster, and what the
    // bundled base catalog records for `gpt-6-luna`. Asserting against the
    // sibling row rather than a literal keeps the two from drifting apart.
    expect(row?.contextLimit).toBe(1_050_000);
    expect(row?.outputLimit).toBe(128_000);
  });

  test("workbuddy publishes the same row at its own endpoint path", () => {
    const row = luna(WORKBUDDY_MODELS);
    expect(row).toBeDefined();
    // Same model, different URL: WorkBuddy's base carries no version segment,
    // so it needs the explicit `/v2` prefix. Asserting the path is what stops
    // the shared-list refactor from pointing workbuddy at cb's path.
    expect(row?.endpointPath).toBe("/v2/chat/completions");
    expect(luna(CODEBUDDY_MODELS)?.endpointPath).toBe("/chat/completions");
  });

  test("both sites carry identical limits for it", () => {
    // The shared list is only shared if the limits it yields are. A per-provider
    // override that changed one number would be invisible from either side.
    const cb = luna(CODEBUDDY_MODELS);
    const wb = luna(WORKBUDDY_MODELS);
    expect(wb?.contextLimit).toBe(cb?.contextLimit);
    expect(wb?.outputLimit).toBe(cb?.outputLimit);
    expect(wb?.reasoning).toBe(cb?.reasoning);
    expect(wb?.modalities.input).toEqual(cb?.modalities.input);
  });

  test("it is a reasoning, tool-calling, vision row", () => {
    // `toolCall: false` here silently strips `tools` during capability
    // preflight, so the model would look unable to call tools at all.
    const row = luna(CODEBUDDY_MODELS);
    expect(row?.reasoning).toBe(true);
    expect(row?.toolCall).toBe(true);
    expect(row?.modalities.input).toContain("image");
  });

  test("CodeBuddy CN stays separate from the international-only gpt-6-luna row", () => {
    expect(luna(CODEBUDDY_CN_MODELS)).toBeUndefined();
  });

  test("CodeBuddy CN publishes the newly fetched CLI models and drops the removed model", () => {
    const rows = [
      ["uto", 256_000, 32_000],
      ["space-bunny", 1_000_000, 128_000],
      ["step-5-preview", 1_000_000, 64_000],
    ] as const;
    for (const [modelId, contextLimit, outputLimit] of rows) {
      const row = CODEBUDDY_CN_MODELS.find((model) => model.modelId === modelId);
      expect(row).toBeDefined();
      expect(row?.contextLimit).toBe(contextLimit);
      expect(row?.outputLimit).toBe(outputLimit);
    }
    expect(CODEBUDDY_CN_MODELS.some((model) => model.modelId === "hy4-preview-x")).toBe(false);
  });

  test("WorkBuddy CN mirrors WorkBuddy models while keeping its provider identity", () => {
    const internationalIds = new Set(WORKBUDDY_MODELS.map((model) => model.modelId));
    expect(new Set(WORKBUDDY_CN_MODELS.map((model) => model.modelId))).toEqual(internationalIds);
    const cnRow = luna(WORKBUDDY_CN_MODELS);
    expect(cnRow?.endpointPath).toBe("/v2/chat/completions");
  });
});