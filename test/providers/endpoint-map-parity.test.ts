import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITIES } from "../../src/providers/default-registry";
import type { WireFamily } from "../../src/transport/canonical-model";

/**
 * `PROVIDER_CAPABILITIES[id].endpointPathsByWireFamily` is the path the
 * discovery/probe layer tests against; the model catalog's `endpointPath` is
 * the path dispatch actually calls. They are separate declarations, so they can
 * drift — and one already had: `ollamacloud` advertised `native` and `messages`
 * paths while its adapter spec serves only `chat` and `responses`, so the probe
 * exercised two endpoints that provider cannot answer on.
 *
 * This asserts the two agree per wire family, so a registry map can only name a
 * path the provider's own catalog also serves.
 */
type Capability = {
  readonly endpointPathsByWireFamily?: Readonly<Partial<Record<WireFamily, string>>>;
  readonly loadModels?: () => Promise<readonly { wireFamily: WireFamily; endpointPath: string }[]>;
};

const entries = Object.entries(PROVIDER_CAPABILITIES as unknown as Record<string, Capability>)
  .filter(([, cap]) => cap.endpointPathsByWireFamily !== undefined);

describe("registry endpoint map ↔ model catalog parity", () => {
  test("the providers with a registry endpoint map are the expected set", () => {
    // A new entry here is a deliberate act: it means the provider declares its
    // paths twice and this test now guards the pair.
    expect(entries.map(([id]) => id).sort()).toEqual(
      ["anthropic", "cerebras", "ollamacloud", "openai", "opencodeft", "opencodezen"].sort(),
    );
  });

  for (const [providerId, cap] of entries) {
    test(`${providerId} registry paths match its catalog`, async () => {
      const models = cap.loadModels ? await cap.loadModels() : [];
      // A provider with no bundled catalog (ollamacloud discovers its models)
      // declares its families in the adapter spec instead; the capability gate
      // there rejects anything outside `supported_wire_families`, so there is
      // no catalog row to compare against.
      if (models.length === 0) return;
      for (const [wireFamily, registryPath] of Object.entries(cap.endpointPathsByWireFamily!)) {
        const served = models.filter((m) => m.wireFamily === wireFamily);
        expect(served.length).toBeGreaterThan(0);
        for (const model of served) {
          expect(model.endpointPath).toBe(registryPath);
        }
      }
    });
  }
});
