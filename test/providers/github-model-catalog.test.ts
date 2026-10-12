import { describe, expect, test } from "bun:test";
import {
  GITHUB_EXCLUDED_MODEL_IDS,
  GITHUB_MODELS,
  githubModelUsesLongContext,
  githubModelRoute,
  recordGithubLongContextModels,
} from "../../src/providers/integrations/github/github";
import { defineModel } from "../../src/providers/model-definition";
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

  test("publishes all Auto routing tiers in the fallback catalog", () => {
    const modelIds = new Set(GITHUB_MODELS.map((model) => model.modelId));

    expect(modelIds.has("gpt-6-luna-low")).toBe(true);
    expect(modelIds.has("gpt-6-luna-medium")).toBe(true);
    expect(modelIds.has("gpt-6-luna-high")).toBe(true);
    expect(modelIds.has("auto")).toBe(true);
    expect(modelIds.has("auto-efficiency")).toBe(false);
    expect(modelIds.has("auto-balance")).toBe(false);
    expect(modelIds.has("auto-intelligence")).toBe(false);
  });

  test("does not re-add excluded ids from the live account catalog", async () => {
    const credential = JSON.stringify({ access: "token", apiHost: "copilot.example" });
    const response = new Response(JSON.stringify({
      data: [
        ...[...GITHUB_EXCLUDED_MODEL_IDS].map((id) => ({
          id,
          supported_endpoints: [id === "gpt-6-luna" ? "/responses" : "/chat/completions"],
        })),
        { id: "gpt-4.1", supported_endpoints: ["/chat/completions"] },
      ],
    }));
    const models = await discoverGithubModels({
      credential,
      fetcher: Object.assign(async () => response, {
        preconnect: fetch.preconnect.bind(fetch),
      }),
    });

    const modelIds = new Set(models?.map((model) => model.modelId));
    expect(modelIds.has("gpt-4.1")).toBe(true);
    expect(modelIds.has("gpt-6-luna")).toBe(false);
    expect(modelIds.has("gpt-6-luna-low")).toBe(true);
    expect(githubModelRoute("gpt-6-luna", credential)).toEqual({
      wireFamily: "responses",
      endpointPath: "/responses",
    });
  });

  test("scopes the long-context roster to each credential and replaces it on rediscovery", () => {
    const firstCredential = JSON.stringify({
      access: "access-a",
      apiHost: "copilot.example",
      github: "refresh-a",
    });
    const secondCredential = JSON.stringify({
      access: "access-b",
      apiHost: "copilot.example",
      github: "refresh-b",
    });
    const longContextModel = defineModel({
      id: "long-model",
      providerId: "github",
      ctx: 600_000,
    });

    recordGithubLongContextModels(firstCredential, [longContextModel]);
    expect(githubModelUsesLongContext("LONG-MODEL", firstCredential)).toBe(true);
    expect(githubModelUsesLongContext("long-model", secondCredential)).toBe(false);

    recordGithubLongContextModels(firstCredential, []);
    expect(githubModelUsesLongContext("long-model", firstCredential)).toBe(false);
  });

  test("records long-context models from the credential's latest discovered catalog", async () => {
    const credential = JSON.stringify({
      access: "catalog-access",
      apiHost: "copilot.example",
      github: "catalog-refresh",
    });
    const models = await discoverGithubModels({
      credential,
      fetcher: Object.assign(
        async () => new Response(JSON.stringify({
          data: [{
            id: "long-model",
            supported_endpoints: ["/chat/completions"],
            capabilities: { limits: { max_context_window_tokens: 600_000 } },
          }],
        })),
        { preconnect: fetch.preconnect.bind(fetch) },
      ),
    });

    expect(models?.some((model) => model.modelId === "long-model")).toBe(true);
    expect(models?.some((model) => model.modelId === "gpt-6-luna-low")).toBe(true);
    expect(githubModelUsesLongContext("long-model", credential)).toBe(true);
  });
});
