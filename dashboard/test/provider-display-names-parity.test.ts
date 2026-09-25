import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { providerDisplayName } from "../src/lib/provider-names";

/**
 * `dashboard/src/lib/provider-names.ts` hand-maintains a display-name entry
 * per built-in provider ID. This is the parity contract check its own file
 * doc comment asks for: it fails the moment a new provider is added to
 * `BUNDLED_PROVIDER_IDS` without a matching dashboard display name, instead
 * of silently falling back to showing the raw provider ID slug in the UI.
 */
describe("dashboard/backend parity — provider display names", () => {
  test("every built-in provider ID has a friendly dashboard display name", () => {
    for (const providerId of BUNDLED_PROVIDER_IDS) {
      const displayed = providerDisplayName(providerId);
      expect(displayed).not.toBe(providerId);
    }
  });
});