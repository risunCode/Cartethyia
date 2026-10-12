/**
 * `supportsModelDiscovery` must answer "does the registry resolve a discovery
 * resolver for this provider?", not "is this provider a builtin?".
 *
 * The two questions were interchangeable while the catalog had no
 * discovery-backed builtins. They stopped being interchangeable the moment one
 * was added, and the projection was the reason: a builtin registering
 * `loadModelDiscovery` reported `false`, so the dashboard hid both its "Fetch
 * models" button and its auto-sync effect, and the provider listed zero models
 * with no UI path to fetch any. The sync route itself worked — the control was
 * simply unreachable.
 *
 * This asserts at the seam that caused it, with a real registry rather than a
 * stub, so the check cannot pass against a lookup that always answers the same
 * way. The paired case is the load-bearing half: a builtin with no resolver must
 * still report `false`, because showing a control that would 502 is the
 * original mistake wearing the opposite hat.
 */
import { describe, expect, test } from "bun:test";
import { mapProviderRow } from "../../src/console/providers/catalog/catalog-projections";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { providers } from "../../src/persistence/schema";

/** The registry as the projection sees it: the one synchronous fact it reads. */
function lookup() {
  const registry = createDefaultProviderRegistry();
  return {
    hasModelDiscovery: (providerId: string) => registry.hasModelDiscovery(providerId),
  };
}

/** A builtin `providers` row; only `id` is read by the projection. */
function bundledRow(id: string) {
  return {
    id,
    displayName: null,
    baseUrl: null,
    tenantId: null,
    enabled: true,
    requiresAccount: true,
    wireFamilyDefault: "chat",
    compatibilityProfile: null,
    capabilityProfile: null,
  } as unknown as typeof providers.$inferSelect;
}

describe("provider model-discovery projection", () => {
  test("a builtin that registers a discovery resolver reports it", () => {
    // `ollamacloud` is the builtin that actually can discover. Before the fix
    // this returned false, which is what hid the Fetch models control.
    const record = mapProviderRow(bundledRow("ollamacloud"), lookup());
    expect(record.isBuiltIn).toBe(true);
    expect(record.supportsModelDiscovery).toBe(true);
  });

  test("a builtin with no discovery resolver still reports false", () => {
    // The other half of the contract: `gmi` registers neither a catalog nor a
    // resolver, so a "Fetch models" button would fail. Claiming it can is the
    // same defect as hiding the control from one that can.
    expect(mapProviderRow(bundledRow("gmi"), lookup()).supportsModelDiscovery).toBe(false);
    expect(mapProviderRow(bundledRow("nvidia"), lookup()).supportsModelDiscovery).toBe(false);
    expect(mapProviderRow(bundledRow("fireworks"), lookup()).supportsModelDiscovery).toBe(false);
  });

  test("a custom provider row stays true without a registration", () => {
    // A BYOK row has no registry entry, so `hasModelDiscovery` answers false for
    // it. Discovery is always available for a custom provider, so the `||`
    // tail in the projection is what keeps this true.
    const record = mapProviderRow(bundledRow("some-gateway"), lookup());
    expect(record.isBuiltIn).toBe(false);
    expect(record.supportsModelDiscovery).toBe(true);
  });

  test("the registry reports discovery from the registration, not the catalog", () => {
    // Guards the accessor itself. A lookup that answered from anything other
    // than `loadModelDiscovery` would satisfy the three cases above while
    // still being wrong, so this pins the source of the answer.
    const registry = createDefaultProviderRegistry();
    expect(registry.hasModelDiscovery("ollamacloud")).toBe(true);
    expect(registry.hasModelDiscovery("gmi")).toBe(false);
    expect(registry.hasModelDiscovery("not-a-provider")).toBe(false);
  });
});