import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../../src/transport/gateway-error";
import { ProviderRegistry, parseProviderId } from "../../../src/providers/provider-registry";
import { BUNDLED_PROVIDER_MODULES } from "../../../src/providers/default-registry";
import {
  bundledModelCatalog,
  seedBundledProviders,
  registerByokProviders,
  syncByokProvider,
} from "../../../src/providers/operations/provider-catalog-service";
import { defineModel } from "../../../src/providers/model-definition";
import { resolveByokWireProfile } from "../../../src/providers/operations/byok-wire-profile";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { providers } from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";

describe("provider-registry.test.ts", () => {
interface ByokRow {
  id: string;
  baseUrl: string | null;
  enabled: boolean;
  compatibilityProfile: unknown;
}

/**
 * Mirrors the real query: `base_url IS NOT NULL AND enabled = true`. Returning
 * every row regardless would let a disabled BYOK provider keep resolving.
 */
function fakeDb(rows: ByokRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows.filter((row) => row.baseUrl !== null && row.enabled),
      }),
    }),
  };
}

describe("registerByokProviders", () => {
  test("selects protocol-aware default ports (80 http, 443 https)", async () => {
    const registry = new ProviderRegistry();
    const hosts = await registerByokProviders(
      registry,
      fakeDb([
        { id: "acme-http", baseUrl: "http://proxy.acme.test", enabled: true, compatibilityProfile: null },
        { id: "acme-https", baseUrl: "https://api.acme.test", enabled: true, compatibilityProfile: null },
      ]) as never,
    );
    expect(hosts.get("acme-http")).toMatchObject({ hostname: "proxy.acme.test", port: 80 });
    expect(hosts.get("acme-https")).toMatchObject({ hostname: "api.acme.test", port: 443 });
  });

  test("normalizes provider IDs before registration", async () => {
    const registry = new ProviderRegistry();
    const hosts = await registerByokProviders(
      registry,
      fakeDb([
        { id: "  Acme-Custom ", baseUrl: "https://api.acme.test", enabled: true, compatibilityProfile: null },
      ]) as never,
    );
    expect([...hosts.keys()]).toEqual(["acme-custom"]);
  });

  test("converts malformed URLs to typed 400 errors", async () => {
    const registry = new ProviderRegistry();
    const failure = await registerByokProviders(
      registry,
      fakeDb([{ id: "acme-bad", baseUrl: "ftp://files.acme.test", enabled: true, compatibilityProfile: null }]) as never,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("invalid_request");
    expect((failure as GatewayError).status).toBe(400);
  });

  test("rejects IDs colliding with built-ins", async () => {
    const registry = new ProviderRegistry();
    const failure = await registerByokProviders(
      registry,
      fakeDb([{ id: "openai", baseUrl: "https://evil.test", enabled: true, compatibilityProfile: null }]) as never,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(409);
  });

  test("re-registration replaces the adapter instead of rejecting", async () => {
    const rows: ByokRow[] = [
      { id: "acme-repeat", baseUrl: "https://api.acme.test", enabled: true, compatibilityProfile: null },
    ];
    const first = new ProviderRegistry();
    await registerByokProviders(first, fakeDb(rows) as never);
    const second = new ProviderRegistry();
    const hosts = await registerByokProviders(second, fakeDb(rows) as never);
    expect(hosts.get("acme-repeat")).toBeDefined();

    // An operator editing the base URL used to hit a 409 "conflicting
    // configuration" on the next registration pass; it must now replace the
    // registration so the edit takes effect without a restart.
    rows[0] = { id: "acme-repeat", baseUrl: "https://other.acme.test", enabled: true, compatibilityProfile: null };
    const third = new ProviderRegistry();
    await registerByokProviders(third, fakeDb(rows) as never);
    const conflict = await registerByokProviders(third, fakeDb(rows) as never).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(conflict).toBeUndefined();
    const adapter = await third.resolve("acme-repeat");
    expect(adapter).toBeDefined();
    expect(adapter?.provider_id).toBe(parseProviderId("acme-repeat"));
  });

  test("a row that stops qualifying is dropped, not left stale", async () => {
    const rows: ByokRow[] = [
      { id: "acme-gone", baseUrl: "https://api.acme.test", enabled: true, compatibilityProfile: null },
    ];
    const registry = new ProviderRegistry();
    await registerByokProviders(registry, fakeDb(rows) as never);
    expect(await registry.resolve("acme-gone")).toBeDefined();

    rows[0] = { ...rows[0]!, enabled: false };
    const host = await syncByokProvider(registry, fakeDb(rows) as never, "acme-gone");
    expect(host).toBeUndefined();
    expect(await registry.resolve("acme-gone")).toBeUndefined();
  });

  test("an Anthropic-wire custom provider dispatches to /v1/messages with x-api-key", async () => {
    const rows: ByokRow[] = [
      {
        id: "acme-anthropic",
        baseUrl: "https://anthropic.example.com",
        enabled: true,
        compatibilityProfile: null,
      },
    ];
    // The real query projects `wire_family_default`; the shared fakeDb shape
    // omits it, so route the row through a select that adds the column.
    const database = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(
              rows.map((row) => ({
                id: row.id,
                baseUrl: row.baseUrl,
                enabled: row.enabled,
                wireFamilyDefault: "messages",
                compatibilityProfile: row.compatibilityProfile,
              })),
            ),
        }),
      }),
    };
    const registry = new ProviderRegistry();
    const hosts = await registerByokProviders(registry, database as never);
    expect(hosts.get("acme-anthropic")).toBeDefined();
    const adapter = (await registry.resolve("acme-anthropic")) as unknown as {
      config: {
        authentication_header_shape: string;
        endpoint_paths_by_wire_family: Record<string, string>;
      };
    };
    expect(adapter).toBeDefined();
    // The derived adapter contract is what dispatch uses: x-api-key for the
    // Messages wire, `/v1/messages` for the endpoint. The wire-family set is
    // derived alongside it by `resolveByokWireProfile`, which the dashboard
    // reads for its Add-Model selector — asserted at that source below.
    expect(adapter.config.authentication_header_shape).toBe("x_api_key");
    expect(adapter.config.endpoint_paths_by_wire_family.messages).toBe("/v1/messages");
    expect(resolveByokWireProfile("messages", null).supportedWireFamilies).toEqual(["messages"]);
  });
});

describe("bundledModelCatalog", () => {
  test("rejects a static definition whose endpoint contradicts the registration map", async () => {
    const registry = new ProviderRegistry();
    registry.upsert({
      provider_id: parseProviderId("acme-conflict"),
      load: async () => ({ provider_id: parseProviderId("acme-conflict") }) as never,
      loadModels: async () => [
        defineModel({ id: "acme-model", wireFamily: "chat", endpoint: "/v1/chat/completions" }),
      ],
      endpoint_paths_by_wire_family: { chat: "/v2/chat/completions" },
    });

    const failure = await bundledModelCatalog(registry).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Conflicting endpoint paths for acme-conflict/chat");
  });
});
});

dbDescribe("seedBundledProviders", () => {
  test("materializes every manifest provider and remains idempotent", async () => {
    const db = getDb();
    await seedBundledProviders(db);
    await seedBundledProviders(db);
    const rows = await db
      .select({ id: providers.id, enabled: providers.enabled })
      .from(providers)
      .where(inArray(providers.id, BUNDLED_PROVIDER_MODULES.map((provider) => provider.id)));

    expect(rows).toHaveLength(BUNDLED_PROVIDER_MODULES.length);
    expect(rows.every((row) => row.enabled)).toBe(true);
  });
});
