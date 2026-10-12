import { describe, expect, test } from "bun:test";
import {
  GITHUB_EXCLUDED_MODEL_IDS,
  GITHUB_MODELS,
} from "../../src/providers/integrations/github/github";
import { discoverGithubModels } from "../../src/providers/integrations/github/github-discovery";

describe("GitHub Copilot fallback model catalog", () => {
  test("omits models that failed reachability checks", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    for (const modelId of GITHUB_EXCLUDED_MODEL_IDS) {
      expect(modelIds.has(modelId), modelId).toBe(false);
    }
  });

  test("keeps models verified as reachable", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    expect(modelIds.has("copilot-search-a")).toBe(true);
    expect(modelIds.has("copilot-search-b")).toBe(true);
    expect(modelIds.has("gpt-3.5-turbo-0613")).toBe(true);
    expect(modelIds.has("gpt-4.1")).toBe(true);
    expect(modelIds.has("gpt-4o")).toBe(true);
    expect(modelIds.has("gpt-4o-mini")).toBe(true);
  });

  test("does not re-add excluded ids from the live account catalog", async () => {
    const response = new Response(JSON.stringify({
      data: [
        ...[...GITHUB_EXCLUDED_MODEL_IDS].map((id) => ({ id, supported_endpoints: ["/chat/completions"] })),
        { id: "gpt-4.1", supported_endpoints: ["/chat/completions"] },
      ],
    }));
    const models = await discoverGithubModels({
      credential: JSON.stringify({ access: "token", apiHost: "copilot.example" }),
      fetcher: async () => response,
    });

    expect(models?.map((model) => model.modelId)).toEqual(["gpt-4.1"]);
  });
});
