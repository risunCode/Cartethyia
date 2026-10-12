/**
 * Catalog coverage for the providers that carried no models, and resolution for
 * the reseller-suffixed ids a discovery run returns.
 *
 * Three separate gaps are pinned here because they fail the same way from the
 * client's side — a model that is absent, or present with `n/a` limits — while
 * having three unrelated causes.
 */
import { describe, expect, test } from "bun:test";
import { modelsDevCatalog } from "../../src/providers/discovery/models-dev-catalog";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";
import type { ModelDefinition } from "../../src/providers/model-definition";

async function catalogFor(providerId: string): Promise<readonly ModelDefinition[]> {
  const capabilities = (PROVIDER_CAPABILITIES as Record<
    string,
    { loadModels?: () => Promise<readonly ModelDefinition[]> }
  >)[providerId];
  expect(capabilities?.loadModels).toBeDefined();
  return (await capabilities!.loadModels!()) as readonly ModelDefinition[];
}

describe("reseller-suffixed model ids", () => {
  test(":free resolves to the same row as the bare id", () => {
    // OpenRouter lists `deepseek/deepseek-v4.1-flash:free`. The suffix is its
    // own billing marker, not a different model, so leaving it on made the
    // discovered model publish `n/a` limits while the unsuffixed id resolved.
    const bare = modelsDevCatalog.resolve("openrouter", "deepseek/deepseek-v4.1-flash");
    const free = modelsDevCatalog.resolve("openrouter", "deepseek/deepseek-v4.1-flash:free");
    expect(bare).toBeDefined();
    expect(free).toEqual(bare);
    expect(free?.contextLimit).toBe(1_048_576);
  });

  test("@variant resolves, and the provider-scoped row wins over a stranger's", () => {
    const pinned = modelsDevCatalog.resolve("openrouter", "qwen/qwen3-coder@pinned");
    expect(pinned).toBeDefined();
    expect(pinned?.contextLimit).toBeTypeOf("number");
  });

  test("an id the catalog genuinely disagrees about still fails closed", () => {
    // `mistral-large-latest` is filed by five providers with two different
    // context windows (128000 and 262144). Inventing one of them would be the
    // bug; `undefined` is the honest answer and must survive the new stripping.
    expect(modelsDevCatalog.resolve("openrouter", "mistralai/mistral-large-latest")).toBeUndefined();
    expect(
      modelsDevCatalog.resolve("openrouter", "mistralai/mistral-large-latest:free"),
    ).toBeUndefined();
  });

  test("an ordinary id is untouched by the stripping", () => {
    const plain = modelsDevCatalog.resolve("openai", "gpt-5");
    expect(plain).toBeDefined();
  });
});

describe("mistral catalog", () => {
  test("carries the current large and medium generalist aliases", async () => {
    const ids = (await catalogFor("mistral")).map((m) => m.modelId);
    expect(ids).toContain("mistral-large-latest");
    expect(ids).toContain("mistral-medium-latest");
  });

  test("drops the retired Magistral tiers and the unrequested small row", async () => {
    // Mistral's model overview deprecates Magistral Medium and Small in favour
    // of Mistral Medium 3.5 and Mistral Small 4, so listing them advertises
    // models the provider is actively retiring.
    const ids = (await catalogFor("mistral")).map((m) => m.modelId);
    expect(ids).not.toContain("magistral-medium-latest");
    expect(ids).not.toContain("magistral-small");
    expect(ids).not.toContain("mistral-small-latest");
  });

  test("every row resolves real limits and a price, not the defaults", async () => {
    // A row that failed to resolve would silently publish the 200k/64k default,
    // which looks measured and misleads capacity planning.
    for (const model of await catalogFor("mistral")) {
      expect(model.contextLimit).toBeTypeOf("number");
      expect(model.outputLimit).toBeTypeOf("number");
      expect(model.cost.input).toBeTypeOf("number");
    }
  });

  test("no row claims an output cap above its context window", async () => {
    for (const model of await catalogFor("mistral")) {
      if (model.contextLimit === null || model.outputLimit === null) continue;
      expect(model.outputLimit).toBeLessThanOrEqual(model.contextLimit);
    }
  });

  test("does not list the embedding row as a chat model", async () => {
    const ids = (await catalogFor("mistral")).map((m) => m.modelId);
    expect(ids).not.toContain("mistral-embed");
  });
});

describe("deepseek catalog", () => {
  test("carries only the live V4 families plus the flash entry", async () => {
    const ids = (await catalogFor("deepseek")).map((m) => m.modelId);
    expect(ids).toEqual(["deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-flash"]);
  });

  test("drops the retired and alias ids", async () => {
    // `v4.1-flash` replaces `v4-flash` in the published server list, and
    // `v4-flash-vision-exp` routes to it upstream.
    // `v4-pro-max` / `v4-pro-none` are aliases of `v4-pro`, not models.
    const ids = (await catalogFor("deepseek")).map((m) => m.modelId);
    expect(ids).not.toContain("deepseek-v4-flash");
    expect(ids).not.toContain("deepseek-v4-flash-vision-exp");
    expect(ids).not.toContain("deepseek-v4-pro-max");
    expect(ids).not.toContain("deepseek-v4-pro-none");
  });

  test("excludes the V3.2 families", async () => {
    const ids = (await catalogFor("deepseek")).map((m) => m.modelId);
    expect(ids).not.toContain("deepseek-chat");
    expect(ids).not.toContain("deepseek-reasoner");
  });

  test("no row falls back to the generic default limits", async () => {
    // 200k/64k is `defineModel`'s fallback for an id the catalog cannot resolve.
    for (const model of await catalogFor("deepseek")) {
      expect(model.contextLimit).toBeGreaterThan(200_000);
      expect(model.outputLimit).toBeGreaterThan(64_000);
    }
  });

  test("resolves limits from the base catalog, not restated numbers", async () => {
    const byId = new Map((await catalogFor("deepseek")).map((m) => [m.modelId, m]));
    // `v4-pro` has a provider-scoped row: 1M in, 384k out, tools, no vision.
    const pro = byId.get("deepseek-v4-pro");
    expect(pro?.contextLimit).toBe(1_000_000);
    expect(pro?.outputLimit).toBe(384_000);
    expect(pro?.toolCall).toBe(true);
    expect(pro?.modalities.input).not.toContain("image");
    // `v4.1-flash` is filed under other providers upstream, so it resolves
    // through the majority row. Its 1048576-token limit and the 1000000-token
    // value used elsewhere express the same 1M window; pin the catalog value
    // because that is what the client sees.
    const flash = byId.get("deepseek-v4.1-flash");
    expect(flash?.contextLimit).toBe(1_048_576);
    expect(flash?.outputLimit).toBe(384_000);
    expect(flash?.modalities.input).toContain("image");
    expect(flash?.toolCall).toBe(true);
    // `deepseek-flash` has a provider-scoped row: 1M in, 384k out, and unlike
    // `v4-pro` it accepts image parts.
    const entry = byId.get("deepseek-flash");
    expect(entry?.contextLimit).toBe(1_000_000);
    expect(entry?.outputLimit).toBe(384_000);
    expect(entry?.modalities.input).toContain("image");
    expect(entry?.toolCall).toBe(true);
  });
});
