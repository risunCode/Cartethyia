import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import { type CanonicalEvent, type CanonicalRequest } from "../../src/transport/canonical-model";
import {
  parseCustomProviderId,
  BUNDLED_PROVIDER_IDS,
  CredentialResolver,
  isBundledProviderId,
  parseProviderId,
  ProviderRegistry,
  type ProviderDispatchTarget,
  type ProviderAdapter,
  type ProviderDispatchContext,
} from "../../src/providers/provider-registry";
import { unwrapProviderToken } from "../../src/providers/credential-envelope";

function fakeAdapter(provider_id: ProviderDispatchTarget["provider_id"]): ProviderAdapter {
  return {
    provider_id,
    async *dispatch(
      _request: CanonicalRequest,
      _candidate: ProviderDispatchTarget,
      _context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      yield { type: "keepalive", sequence_number: 1 };
    },
  };
}

const resolver = new CredentialResolver();

describe("registry.test.ts", () => {
  describe("ProviderRegistry", () => {
    test("loads every registration eagerly", async () => {
      const registry = new ProviderRegistry();
      const loads: string[] = [];
      registry.register({
        provider_id: "openai",
        load: async () => {
          loads.push("openai");
          return fakeAdapter("openai");
        },
      });
      registry.register({
        provider_id: "cursor",
        load: async () => {
          loads.push("cursor");
          return fakeAdapter("cursor");
        },
      });

      const snapshot = await registry.load();
      expect([...snapshot.adapters.keys()].sort()).toEqual(["cursor", "openai"]);
      expect(loads.sort()).toEqual(["cursor", "openai"]);
    });

    test("rejects duplicate registrations and adapter identity drift", async () => {
      const registry = new ProviderRegistry();
      registry.register({
        provider_id: "openai",
        load: async () => fakeAdapter("openai"),
      });
      expect(() =>
        registry.register({
          provider_id: "openai",
          load: async () => fakeAdapter("openai"),
        }),
      ).toThrow();
      registry.register({
        provider_id: "anthropic",
        load: async () => fakeAdapter("openai"),
      });
      await expect(registry.load()).rejects.toThrow();
    });

    test("resolve loads lazily, caches, and returns undefined when unregistered", async () => {
      const registry = new ProviderRegistry();
      const loads: string[] = [];
      registry.register({
        provider_id: "openai",
        load: async () => {
          loads.push("openai");
          return fakeAdapter("openai");
        },
      });
      registry.register({
        provider_id: "cursor",
        load: async () => {
          loads.push("cursor");
          return fakeAdapter("cursor");
        },
      });

      expect(loads).toEqual([]);
      const cursor = await registry.resolve("cursor");
      expect(cursor?.provider_id).toBe("cursor");
      expect(loads).toEqual(["cursor"]);

      const again = await registry.resolve("cursor");
      expect(again).toBe(cursor);
      expect(loads).toEqual(["cursor"]);

      expect(await registry.resolve("not-registered")).toBeUndefined();
      expect(loads).toEqual(["cursor"]);
    });

    test("evicts a failed adapter load so the next resolve retries", async () => {
      const registry = new ProviderRegistry();
      let attempts = 0;
      registry.register({
        provider_id: "openai",
        load: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient adapter load failure");
          return fakeAdapter("openai");
        },
      });

      await expect(registry.resolve("openai")).rejects.toThrow("transient adapter load failure");
      const recovered = await registry.resolve("openai");
      expect(recovered?.provider_id).toBe("openai");
      expect(attempts).toBe(2);
    });

    test("resolves authentication, quota, and discovery lazily with single-flight caching", async () => {
      const registry = new ProviderRegistry();
      const calls = { authentication: 0, quota: 0, discovery: 0 };
      registry.register({
        provider_id: "openai",
        load: async () => fakeAdapter("openai"),
        loadAuthentication: async () => {
          calls.authentication += 1;
          return {};
        },
        loadQuotaCollector: async () => {
          calls.quota += 1;
          return async () => ({ source: "openai", plan: null, windows: [], error: null });
        },
        loadModelDiscovery: async () => {
          calls.discovery += 1;
          return async () => [];
        },
      });

      expect(calls).toEqual({ authentication: 0, quota: 0, discovery: 0 });
      const [authentication, quota, discovery] = await Promise.all([
        registry.resolveAuthentication("openai"),
        registry.resolveQuotaCollector("openai"),
        registry.resolveModelDiscovery("openai"),
      ]);
      expect(authentication).toEqual({});
      expect(typeof quota).toBe("function");
      expect(typeof discovery).toBe("function");
      expect(calls).toEqual({ authentication: 1, quota: 1, discovery: 1 });

      await registry.resolveAuthentication("openai");
      expect(calls.authentication).toBe(1);
      expect(await registry.resolveAuthentication("not-registered")).toBeUndefined();
    });

    test("evicts a failed capability load so the next resolve retries", async () => {
      const registry = new ProviderRegistry();
      let attempts = 0;
      registry.register({
        provider_id: "openai",
        load: async () => fakeAdapter("openai"),
        loadQuotaCollector: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient quota load failure");
          return async () => ({ source: "openai", plan: null, windows: [], error: null });
        },
      });

      await expect(registry.resolveQuotaCollector("openai")).rejects.toThrow(
        "transient quota load failure",
      );
      expect(await registry.resolveQuotaCollector("openai")).toBeDefined();
      expect(attempts).toBe(2);
    });

    test("resolve single-flights concurrent loads and rejects identity drift", async () => {
      const registry = new ProviderRegistry();
      let loads = 0;
      registry.register({
        provider_id: "openai",
        load: async () => {
          loads += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return fakeAdapter("openai");
        },
      });

      const [first, second] = await Promise.all([
        registry.resolve("openai"),
        registry.resolve("openai"),
      ]);
      expect(first).toBe(second);
      expect(loads).toBe(1);

      const drifting = new ProviderRegistry();
      drifting.register({
        provider_id: "anthropic",
        load: async () => fakeAdapter("openai"),
      });
      await expect(drifting.resolve("anthropic")).rejects.toThrow();
    });
  });
});

describe("contracts.test.ts", () => {
  describe("provider identity boundary", () => {
    test("reserves every canonical builtin ID case-insensitively", () => {
      for (const providerId of BUNDLED_PROVIDER_IDS) {
        expect(isBundledProviderId(providerId)).toBe(true);
        expect(() => parseCustomProviderId(providerId.toUpperCase())).toThrow(
          GatewayError,
        );
        try {
          parseCustomProviderId(providerId.toUpperCase());
        } catch (error: unknown) {
          expect(error).toMatchObject({ code: "slug_reserved", status: 409 });
        }
      }
    });

    test("normalizes custom slugs before persistence", () => {
      expect(String(parseCustomProviderId("  My-Provider "))).toBe("my-provider");
      expect(parseProviderId("OpenAI")).toBe("openai");
    });

    test("rejects malformed provider IDs", () => {
      expect(() => parseProviderId("../escape")).toThrow(GatewayError);
      expect(() => parseProviderId("-starts-with-dash")).toThrow(GatewayError);
      expect(() => parseProviderId("contains_underscore")).toThrow(GatewayError);
    });

  });
});

describe("credential-resolver.test.ts", () => {
  describe("ordered credential resolver", () => {
    test("selects the first usable alternative", () => {
      const result = resolver.resolve("openai", [
        { provider_id: "openai", credential_kind: "api_key", secret: "", usable: false },
        {
          provider_id: "openai",
          credential_kind: "oauth",
          secret: "Bearer oauth-secret",
          token_envelope: "bearer",
        },
      ]);
      expect(result.alternative_index).toBe(1);
      expect(new TextDecoder().decode(result.credential.secret)).toBe("oauth-secret");
      expect(result.credential.credential_kind).toBe("oauth");
    });

    test("supports public no-credential routes without an Authorization secret", () => {
      const result = resolver.resolve("openai", [{ provider_id: "openai", credential_kind: "none" }]);
      expect(result.credential).toEqual({ provider_id: "openai", credential_kind: "none" });
    });

    test("skips an unusable primary and resolves a later API key", () => {
      const result = resolver.resolve("anthropic", [
        { provider_id: "anthropic", credential_kind: "oauth", secret: "oauth", usable: false },
        { provider_id: "anthropic", credential_kind: "api_key", secret: "api-secret" },
      ]);
      expect(result.alternative_index).toBe(1);
      expect(result.credential.credential_kind).toBe("api_key");
    });

    test("strips only an explicit provider token envelope", () => {
      expect(new TextDecoder().decode(unwrapProviderToken("provider:wrapped", "provider"))).toBe(
        "wrapped",
      );
      expect(new TextDecoder().decode(unwrapProviderToken("Bearer wrapped", "bearer"))).toBe(
        "wrapped",
      );
      expect(new TextDecoder().decode(unwrapProviderToken("literal", undefined))).toBe("literal");
    });

    test("does not resolve a credential for a different provider and fails typed", () => {
      expect(() =>
        resolver.resolve("openai", [
          { provider_id: "anthropic", credential_kind: "api_key", secret: "secret" },
        ]),
      ).toThrow(GatewayError);
    });
  });
});
