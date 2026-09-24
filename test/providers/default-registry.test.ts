import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_MODULES, PROVIDER_CAPABILITIES, createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { BUNDLED_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { BUNDLED_PROVIDER_METADATA } from "../../src/providers/provider-metadata";

describe("default provider composition", () => {
  test("registers every bundled provider exactly once with matching identity", async () => {
    const registry = createDefaultProviderRegistry();
    const registrations = registry.registrations();
    const registeredIds = registrations.map((registration) => registration.provider_id);

    expect(new Set(registeredIds).size).toBe(registeredIds.length);
    expect([...registeredIds].sort()).toEqual([...BUNDLED_PROVIDER_IDS].sort());
  });

  test("every bundled provider has exactly one capability descriptor", () => {
    const capabilityIds = Object.keys(PROVIDER_CAPABILITIES).sort();
    expect(capabilityIds).toEqual([...BUNDLED_PROVIDER_IDS].sort());
  });

  test("module metadata, upstream host, and lazy loaders are wired", () => {
    for (const module of BUNDLED_PROVIDER_MODULES) {
      expect(BUNDLED_PROVIDER_IDS).toContain(module.id);
      expect(module.upstreamHost.hostname.length).toBeGreaterThan(0);
      expect(typeof module.loadAdapter).toBe("function");
    }
  });

  test("metadata parity: every bundled metadata row materializes one module", () => {
    const moduleIds = BUNDLED_PROVIDER_MODULES.map((module) => module.id).sort();
    const metadataIds = BUNDLED_PROVIDER_METADATA.map((metadata) => metadata.id).sort();
    expect(moduleIds).toEqual(metadataIds);
  });

  test("lazy capability resolution matches the declared capability surface", async () => {
    const registry = createDefaultProviderRegistry();
    expect(await registry.resolveAuthentication("claude")).toBeDefined();
    expect(await registry.resolveAuthentication("openai")).toBeUndefined();
    expect(await registry.resolveQuotaCollector("codex")).toBeDefined();
    expect(await registry.resolveQuotaCollector("openai")).toBeUndefined();
    expect(await registry.resolveModelDiscovery("openai")).toBeDefined();
    expect(registry.modelDiscoveryRequiresCredential("opencodeft")).toBe(false);
    expect(registry.modelDiscoveryRequiresCredential("openai")).toBe(true);
  });
});
