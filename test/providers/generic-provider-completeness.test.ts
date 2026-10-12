/**
 * A bundled API-key provider must be able to list models.
 *
 * The failure this guards is not hypothetical and is not a crash: a provider
 * registered with neither `loadModels` nor `loadModelDiscovery` boots cleanly,
 * seeds its `providers` row, renders a card in the console, and lists zero
 * models — permanently, because the "Fetch models" control is hidden for every
 * builtin. `gmi`, `nvidia`, and `fireworks` all shipped exactly that way.
 *
 * Two halves are asserted, because they fail differently:
 *
 * 1. **Registration completeness** — every id in `GENERIC_API_KEY_PROVIDER_IDS`
 *    has a spec row and a registry entry. The `satisfies Record` on the spec map
 *    already proves the first at compile time; this states it as a runtime
 *    invariant so the failure names the missing provider.
 * 2. **Discoverability** — the providers that opted into the discovery-backed
 *    helper actually resolve one. This is the half with no compile-time
 *    protection: a row can name a valid spec, pass every type check, and still
 *    list nothing.
 */
import { describe, expect, test } from "bun:test";
import {
  GENERIC_API_KEY_PROVIDER_IDS,
  GENERIC_API_KEY_SPECS,
  VERSIONED_ROOT_API_KEY_PROVIDER_IDS,
  VERSIONED_ROOT_API_KEY_SPECS,
} from "../../src/providers/specs/configured-openai-providers";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import { BUNDLED_PROVIDER_MODULES } from "../../src/providers/default-registry";
import { BUNDLED_PROVIDER_METADATA, providerBaseUrl } from "../../src/providers/metadata";
import { joinUrl } from "../../src/protocol/codecs";
import { BARE_ROOT_ENDPOINTS } from "../../src/protocol/codecs";
import type { WireFamily } from "../../src/protocol/canonical-model";

const registry = createDefaultProviderRegistry();

/** Ids registered through the shared discovery-backed helper. */
const DISCOVERY_BACKED = [
  "groq",
  "together",
  "deepinfra",
  "siliconflow",
  "siliconflowcn",
  "novita",
  "venice",
  "nanogpt",
  "baseten",
  "synthetic",
  "stepfun",
  "sakana",
  "helmcode",
  "coralbricks",
  "aiand",
  "wafer",
  "coreweave",
  "qianfan",
  "zhipucoding",
  "firepass",
] as const;

describe("bundled API-key provider completeness", () => {
  test("every generic spec id has a spec row and a registry entry", () => {
    for (const providerId of GENERIC_API_KEY_PROVIDER_IDS) {
      expect(GENERIC_API_KEY_SPECS[providerId]).toBeDefined();
      const registration = BUNDLED_PROVIDER_MODULES.find((m) => m.id === providerId);
      expect(registration).toBeDefined();
      expect(typeof registry.resolveModelDiscovery).toBe("function");
    }
  });

  test("every discovery-backed provider registers a discovery resolver", () => {
    // The assertion that catches a catalog-less, discovery-less provider. Each
    // id here is one an operator can otherwise never populate.
    for (const providerId of DISCOVERY_BACKED) {
      expect(registry.hasModelDiscovery(providerId)).toBe(true);
    }
  });

  test("a discovery-backed provider declares an endpoint path for its wire", () => {
    // A resolver with no path behind it discovers models it cannot dispatch.
    for (const providerId of DISCOVERY_BACKED) {
      const module = BUNDLED_PROVIDER_MODULES.find((m) => m.id === providerId);
      expect(module).toBeDefined();
      expect(Object.keys(module!.endpointPathsByWireFamily ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("qianfan pins its own unprefixed chat path", () => {
    // Qianfan's root is already `/v2`, so it cannot use the shared generic
    // spec's `/v1`-prefixed path. Asserted at the owning constant rather than
    // as a literal, so a future root change moves the expectation with it.
    const module = BUNDLED_PROVIDER_MODULES.find((m) => m.id === "qianfan");
    expect(module!.endpointPathsByWireFamily?.chat).toBe("/chat/completions");
    expect(module!.endpointPathsByWireFamily?.chat).not.toBe(BARE_ROOT_ENDPOINTS.chat);
  });

  test("no provider declares a doubled path for its own base", () => {
    // `joinUrl` is plain concatenation, so a `/v1/…` path declared against a
    // base already rooted at a version produces `…/v1/v1/chat/completions` and
    // every request 404s — silently, because nothing dispatches until an
    // operator configures an account. Four aggregators shipped this way in the
    // first pass of this batch (`groq`, `deepinfra`, `novita`, `venice`) before
    // the spec was split by base-root shape.
    //
    // Scoped to providers that declare a registry map, because that is where
    // this failure lives. A provider whose map is absent resolves its path from
    // a static catalog row instead (`cline` ships `/chat/completions` that way),
    // and one with neither a map nor rows dispatches nothing at all — asserting
    // over those would be asserting against a path no request uses.
    const doubled: string[] = [];
    for (const module of BUNDLED_PROVIDER_MODULES) {
      if (module.endpointPathsByWireFamily === undefined) continue;
      const baseUrl = providerBaseUrl(module.id);
      for (const [wireFamily, declared] of Object.entries(
        module.endpointPathsByWireFamily,
      ) as [WireFamily, string][]) {
        // The dispatched URL is the declared path joined to the base
        // verbatim: nothing rewrites it, so a doubled version segment here is
        // one the gateway would actually send.
        const finalUrl = joinUrl(baseUrl, declared);
        if (/\/(v\d+)(?:\/[a-z0-9]+)?\/\1\//i.test(finalUrl)) {
          doubled.push(`${module.id}/${wireFamily} → ${finalUrl}`);
        }
      }
    }
    expect(doubled).toEqual([]);
  });

  test("a versioned-root provider declares a path below its root", () => {
    // The structural half of the check above, pinned at the seam that makes it
    // true: a base ending in a version segment must not also declare a
    // `/v1`-prefixed path, because those two cannot both be right.
    for (const providerId of VERSIONED_ROOT_API_KEY_PROVIDER_IDS) {
      const baseUrl = providerBaseUrl(providerId);
      expect(new URL(baseUrl).pathname).toMatch(/\/v\d+(\/|$)/);
      const spec = VERSIONED_ROOT_API_KEY_SPECS[providerId];
      expect(spec.endpoint_paths_by_wire_family?.chat).toBe("/chat/completions");
    }
  });

  test("providers without discovery keep reporting it absent", () => {
    // The paired half. These three register neither a catalog nor a resolver,
    // and claiming otherwise would offer a control that cannot work.
    for (const providerId of ["gmi", "nvidia", "fireworks"]) {
      expect(registry.hasModelDiscovery(providerId)).toBe(false);
    }
  });

  test("every bundled metadata id has a registry entry", () => {
    // `BUNDLED_PROVIDER_MODULES` throws at module load when this fails, so the
    // test proves the boot path rather than a lookup.
    const moduleIds = new Set(BUNDLED_PROVIDER_MODULES.map((m) => m.id));
    for (const metadata of BUNDLED_PROVIDER_METADATA) {
      expect(moduleIds.has(metadata.id)).toBe(true);
    }
  });
});