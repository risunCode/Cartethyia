import { describe, expect, test } from "bun:test";
import { OpenAIAdapter } from "../../src/providers/openai";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelService } from "../../src/console/services/models";
import type { ModelRepository, ModelView } from "../../src/console/views/models";

function modelView(modelId: string): ModelView {
  return { providerId: "openai", modelId, displayName: modelId, enabled: true, source: "built-in" };
}

describe("model catalog persistence", () => {
  test("persists fetched or manually added IDs even when the adapter catalog already knows them", async () => {
    const persisted: string[] = [];
    const repository = {
      list: async () => [],
      get: async () => null,
      setEnabled: async (_providerId: string, modelId: string) => {
        persisted.push(modelId);
        return modelView(modelId);
      },
      setAllEnabled: async () => {},
      saveCatalog: async () => {},
      delete: async () => true,
    } satisfies ModelRepository;
    const registry = new ProviderRegistry();
    registry.register(new OpenAIAdapter());
    const service = new ModelService(repository, registry);

    expect(await service.addCustom("openai", "gpt-5.6")).toMatchObject({ modelId: "gpt-5.6" });
    expect(persisted).toEqual(["gpt-5.6"]);
  });
});
