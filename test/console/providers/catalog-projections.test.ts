import { describe, expect, test } from "bun:test";
import {
  endpointPathForProviderModel,
  mapProviderRow,
} from "../../../src/console/providers/catalog/catalog-projections";

describe("endpointPathForProviderModel", () => {
  test("prefers the operator compatibility profile", () => {
    expect(
      endpointPathForProviderModel("openai", "chat", { endpoint_paths_by_wire_family: { chat: "/custom" } }, null),
    ).toBe("/custom");
  });

  test("falls back to the provider static catalog", () => {
    expect(
      endpointPathForProviderModel("openai", "chat", null, null, { chat: "/static" }),
    ).toBe("/static");
  });

  test("uses the generic default for unknown providers", () => {
    expect(endpointPathForProviderModel("my-custom", "responses", null, null)).toBe(
      "/v1/responses",
    );
  });

  test("strips a versioned base path to avoid a doubled /v1", () => {
    expect(
      endpointPathForProviderModel(
        "cline",
        "chat",
        null,
        "https://api.cline.bot/api/v1",
        { chat: "/api/v1/chat/completions" },
      ),
    ).toBe("/chat/completions");
  });

  test("ignores a non-object compatibility profile", () => {
    expect(endpointPathForProviderModel("openai", "chat", "nope", null)).toBe(
      "/v1/chat/completions",
    );
  });
});

describe("mapProviderRow", () => {
  const base = {
    id: "my-provider",
    tenantId: "tenant-1",
    enabled: true,
    requiresAccount: true,
    wireFamilyDefault: null,
    capabilityProfile: null,
    baseUrl: null,
    compatibilityProfile: null,
  };

  test("projects a BYOK row with optional fields", () => {
    const record = mapProviderRow({
      ...base,
      baseUrl: "https://custom.test",
      capabilityProfile: { tools: true },
    } as never);
    expect(record).toMatchObject({
      providerId: "my-provider",
      isBuiltIn: false,
      supportsModelDiscovery: true,
      baseUrl: "https://custom.test",
    });
  });

  test("marks bundled providers as built-in without discovery", () => {
    const record = mapProviderRow({ ...base, id: "openai" } as never);
    expect(record.isBuiltIn).toBe(true);
    expect(record.supportsModelDiscovery).toBe(false);
  });
});
