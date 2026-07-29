/** Custom providers repo tests — create/lookup/delete, slug collisions (REQ-8). */

import { beforeEach, describe, expect, test } from "bun:test";
import { useIsolatedDataDir } from "./helpers";
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProviderById,
  getCustomProviderBySlug,
  listCustomProviders,
  SlugConflictError,
} from "../../src/console/db/repos/custom-providers";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("custom providers CRUD", () => {
  test("creates a provider with a slugified name and looks it up by slug", async () => {
    const created = await createCustomProvider({ name: "My Local vLLM", type: "openai-compatible", baseUrl: "https://vllm.example.com/v1", credential: "sk-test" });
    expect(created.slug).toBe("my-local-vllm");
    expect(created.name).toBe("My Local vLLM");
    expect(created.baseUrl).toBe("https://vllm.example.com/v1");
    expect(created.credential).toBe("sk-test");

    const bySlug = getCustomProviderBySlug("my-local-vllm");
    expect(bySlug?.id).toBe(created.id);

    expect(listCustomProviders()).toHaveLength(1);
  });

  test("strips trailing slashes from baseUrl", async () => {
    const created = await createCustomProvider({ name: "Trailing", type: "openai-compatible", baseUrl: "https://api.example.com/v1///", credential: "x" });
    expect(created.baseUrl).toBe("https://api.example.com/v1");
  });

  test("rejects a slug colliding with another custom provider", async () => {
    createCustomProvider({ name: "Dup", type: "openai-compatible", baseUrl: "https://a.example.com", credential: "x" });
    expect(() => createCustomProvider({ name: "Dup", type: "openai-compatible", baseUrl: "https://b.example.com", credential: "y" })).toThrow(SlugConflictError);
  });

  test("rejects a slug colliding with a built-in provider prefix", async () => {
    expect(() => createCustomProvider({ name: "Kimchi Clone", type: "openai-compatible", baseUrl: "https://x.example.com", credential: "x", slug: "kimchi" })).toThrow(SlugConflictError);
  });

  test("rejects the reserved \"custom\" slug itself", async () => {
    expect(() => createCustomProvider({ name: "Custom", type: "openai-compatible", baseUrl: "https://x.example.com", credential: "x", slug: "custom" })).toThrow(SlugConflictError);
  });

  test("deletes a provider by id", async () => {
    const created = await createCustomProvider({ name: "ToDelete", type: "anthropic-compatible", baseUrl: "https://c.example.com", credential: "x" });
    expect(deleteCustomProvider(created.id)).toBe(true);
    expect(getCustomProviderById(created.id)).toBeNull();
    expect(getCustomProviderBySlug("todelete")).toBeNull();
  });
});
