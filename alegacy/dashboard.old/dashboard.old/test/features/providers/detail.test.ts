import { describe, expect, test } from "vitest";
import { normalizeProviderDetail } from "../../../src/features/providers/detail";

type ProviderDetailInput = Parameters<typeof normalizeProviderDetail>[0];

function providerInput(overrides: Partial<ProviderDetailInput> = {}): ProviderDetailInput {
  return {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    credentialKind: "api_key",
    enabled: true,
    models: [],
    accounts: [],
    ...overrides,
  };
}

describe("normalizeProviderDetail", () => {
  test("normalizes metadata, account provider ids, and routing defaults", () => {
    const result = normalizeProviderDetail(providerInput({
      credentialKinds: ["api_key", "oauth"],
      models: [{
        modelId: "gpt-5",
        enabled: true,
        capabilities: { chat: true, media: true, websearch: true },
        metadata: {
          categories: ["reasoning", "vision"],
          context: { inputTokens: 128_000, outputTokens: 4_096 },
          pricing: { inputPerMillion: 1.25, outputPerMillion: 10 },
          source: "catalog",
        },
      }],
      accounts: [{
        id: "account-1",
        provider: "",
        providerId: "openai",
        name: "Primary",
        credentialKind: "api_key",
        credentialHint: "sk-test",
        active: true,
        health: null,
      }],
      routing: { strategy: "round-robin" },
    }));

    expect(result).toMatchObject({
      authKind: "api-key",
      supportsOAuth: true,
      accountCredentialKind: "api_key",
      status: "ok",
      routing: { strategy: "round-robin", stickyLimit: 1, useStickyLimit: false, proxyRouteId: null },
      models: [{
        id: "gpt-5",
        reasoning: true,
        vision: true,
        websearch: true,
        capabilities: { chat: true, media: true, websearch: true },
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        pricing: { input: 1.25, output: 10 },
      }],
      accounts: [{ provider: "openai" }],
    });
  });

  test("treats manual credentials as no-auth and preserves disabled status", () => {
    const result = normalizeProviderDetail(providerInput({
      id: "custom",
      credentialKind: "manual",
      enabled: false,
      models: [{ modelId: "local-model", enabled: true, source: "manual" }],
    }));

    expect(result).toMatchObject({
      authKind: "none",
      supportsOAuth: false,
      authHint: "No authentication required",
      status: "warn",
      modelManagement: { canAddModels: true, canFetchModels: true },
      models: [{ id: "local-model", source: "manual", reasoning: false, vision: false }],
    });
  });

  test("keeps quota unknown and drops secret-shaped account metadata", () => {
    const result = normalizeProviderDetail(providerInput({
      accounts: [{
        id: "account-2",
        label: "Secondary",
        enabled: true,
        credentialKind: "oauth",
        credentialHint: "secondary@example.com",
        quota: { status: "not-a-state", token: "must-not-enter-ui", remaining: 12 },
        health: { status: "healthy", statusCode: 200, sanitizedMessage: null },
        token: "must-not-enter-ui",
      } as ProviderDetailInput["accounts"][number]],
    }));

    expect(result.accounts).toEqual([expect.objectContaining({
      id: "account-2",
      name: "Secondary",
      active: true,
      quota: expect.objectContaining({ status: "unknown", remaining: 12 }),
    })]);
    expect(result.accounts[0]).not.toHaveProperty("token");
    expect(result.accounts[0]?.quota).not.toHaveProperty("token");
  });
});
