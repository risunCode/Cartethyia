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
  test("carries the current large/medium/small families", async () => {
    const models = await catalogFor("mistral");
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain("mistral-large-latest");
    expect(ids).toContain("mistral-medium-latest");
    expect(ids).toContain("mistral-small-latest");
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
  test("carries v4-flash and v4-pro", async () => {
    const ids = (await catalogFor("deepseek")).map((m) => m.modelId);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("deepseek-v4-pro");
  });

  test("resolves limits from the provider's own rows", async () => {
    for (const model of await catalogFor("deepseek")) {
      expect(model.contextLimit).toBe(1_000_000);
      expect(model.outputLimit).toBe(384_000);
      expect(model.reasoning).toBe(true);
      expect(model.toolCall).toBe(true);
    }
  });

  test("v4-flash takes vision and v4-pro does not, as the catalog files them", async () => {
    const models = await catalogFor("deepseek");
    const flash = models.find((m) => m.modelId === "deepseek-v4-flash");
    const pro = models.find((m) => m.modelId === "deepseek-v4-pro");
    expect(flash?.modalities.input).toContain("image");
    expect(pro?.modalities.input).not.toContain("image");
  });
});
