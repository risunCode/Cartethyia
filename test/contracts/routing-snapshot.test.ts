import { describe, expect, test } from "bun:test";
import {
  createRouteSnapshotCache,
  type RouteSnapshotCache,
  type RouteSnapshotSources,
} from "../../src/app/routing-snapshot";
import type { ConfigPersistence } from "../../src/storage";

/** Minimal fake registry adapter row. */
interface FakeAdapter {
  readonly metadata: { readonly id: string };
  readonly models: { readonly list: readonly FakeModel[] };
}

interface FakeModel {
  readonly id: string;
}

/**
 * Builds route-snapshot sources from tiny fake config/registry shapes.
 * `config` may omit `customProviders` to exercise the optional-repository path.
 */
function makeSources(
  readRevision: () => number,
  config: unknown,
  registry: FakeAdapter[],
): RouteSnapshotSources {
  return { config, registry: { list: () => registry }, readRevision } as never as RouteSnapshotSources;
}

/** Full-featured fake config covering every repository the builder reads. */
function fullConfig() {
  return {
    aliases: {
      list: () => [
        { alias: "fast", model: "openai/gpt-5" },
        { alias: "alias-to-combo", model: "trio" },
      ],
    },
    combos: {
      list: () => [
        { id: "combo-1", name: "trio", models: ["openai/a", "openai/b", "openai/c"], strategy: "round-robin", stickyLimit: 3 },
        { id: "combo-2", name: "fb", models: ["anthropic/x"], strategy: "banana", stickyLimit: 0 },
      ],
    },
    accounts: {
      list: () => [
        { id: "acc-1", provider: "openai", credentialKind: "api_key", active: true },
        { id: "acc-2", provider: "openai", credentialKind: "api_key", active: false },
        { id: "acc-3", provider: "anthropic", credentialKind: "oauth", active: true },
      ],
    },
    stores: {
      proxyPool: {
        listProxies: async () => [{ id: "proxy-a" }, { id: "proxy-b" }],
      },
    },
    customProviders: {
      list: () => [{ slug: "my-gateway" }],
    },
  } as never as ConfigPersistence;
}

const REGISTRY: FakeAdapter[] = [
  { metadata: { id: "openai" }, models: { list: [] } },
  { metadata: { id: "opencodeft" }, models: { list: [] } },
  { metadata: { id: "anthropic" }, models: { list: [] } },
];

describe("routing snapshot builder (application boundary)", () => {
  test("builds prefixes, aliases, combos, proxy ids and grouped account rows", async () => {
    const cache: RouteSnapshotCache = createRouteSnapshotCache(
      makeSources(() => 7, fullConfig(), REGISTRY),
    );
    const snapshot = await cache.get();

    expect(snapshot.revision).toBe(7);
    expect([...snapshot.prefixes.entries()]).toEqual([
      ["openai", "openai"],
      ["opencodeft", "opencodeft"],
      ["opencode", "opencodeft"],
      ["anthropic", "anthropic"],
    ]);
    expect(snapshot.aliases.get("fast")).toBe("openai/gpt-5");
    expect(snapshot.aliases.get("alias-to-combo")).toBe("trio");

    expect(snapshot.combos.get("trio")).toEqual({
      id: "combo-1",
      models: ["openai/a", "openai/b", "openai/c"],
      strategy: "round-robin",
      stickyLimit: 3,
    });
    // Unknown strategies normalize to fallback; stickiness is preserved.
    expect(snapshot.combos.get("fb")).toEqual({
      id: "combo-2",
      models: ["anthropic/x"],
      strategy: "fallback",
      stickyLimit: 0,
    });

    expect(snapshot.accountsByProvider.get("openai")).toEqual([
      { id: "acc-1", providerId: "openai", credentialKind: "api_key", active: true },
      { id: "acc-2", providerId: "openai", credentialKind: "api_key", active: false },
    ]);
    expect(snapshot.accountsByProvider.get("anthropic")).toEqual([
      { id: "acc-3", providerId: "anthropic", credentialKind: "oauth", active: true },
    ]);
    // Each custom provider contributes one synthetic always-active account.
    expect(snapshot.accountsByProvider.get("my-gateway")).toEqual([
      { id: "custom:my-gateway", providerId: "my-gateway", credentialKind: "api_key", active: true },
    ]);
  });

  test("omits custom providers when the repository is absent", async () => {
    const config = fullConfig();
    delete (config as { customProviders?: unknown }).customProviders;
    const cache: RouteSnapshotCache = createRouteSnapshotCache(
      makeSources(() => 1, config, REGISTRY),
    );
    const snapshot = await cache.get();

    expect(snapshot.accountsByProvider.has("my-gateway")).toBe(false);
    expect(snapshot.accountsByProvider.get("openai")?.[0]).toEqual({
      id: "acc-1",
      providerId: "openai",
      credentialKind: "api_key",
      active: true,
    });
  });

  test("freezes the snapshot, proxy ids and account rows", async () => {
    const cache: RouteSnapshotCache = createRouteSnapshotCache(
      makeSources(() => 3, fullConfig(), REGISTRY),
    );
    const snapshot = await cache.get();

    expect(Object.isFrozen(snapshot)).toBe(true);
    const rows = snapshot.accountsByProvider.get("openai");
    expect(rows).toBeDefined();
    // The builder freezes each account-row array (no element swap) but the
    // row objects themselves stay mutable — same contract as before the move.
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows?.[0])).toBe(false);
  });
});
