import { afterEach, describe, expect, test } from "bun:test";
import {
  PoolAgentResolver,
  ValidatedNetworkBindingFactory,
  type NetworkPoolLoader,
  type NetworkPoolRow,
} from "../../src/network/pool/resolver";
import { PoolBindingError, isProxyAgentPair } from "../../src/network/pool/agent";
import { GatewayError } from "../../src/transport/gateway-error";

/**
 * `PoolAgentResolver` owns the per-pool egress agent cache: single-flight
 * construction, idle reaping, the cardinality ceiling, and the tenant boundary
 * that stops one tenant dialing another's pool. Every one of those is a
 * decision the resolver makes *before* any socket exists, so they are tested
 * against an injected loader and an injected DNS resolver — no network, and no
 * real proxy. The socket-level behavior of the agents themselves lives in
 * `pool-config.test.ts`.
 */

function loaderFor(rows: Map<string, NetworkPoolRow>): NetworkPoolLoader {
  return {
    async load(poolId) {
      return rows.get(poolId);
    },
  };
}

/** A loader that records how many times each pool was actually read. */
function countingLoader(rows: Map<string, NetworkPoolRow>): {
  loader: NetworkPoolLoader;
  loads: string[];
} {
  const loads: string[] = [];
  return {
    loads,
    loader: {
      async load(poolId) {
        loads.push(poolId);
        return rows.get(poolId);
      },
    },
  };
}

const created: PoolAgentResolver[] = [];

function resolverFor(
  rows: Map<string, NetworkPoolRow>,
  deps?: { resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]> },
): PoolAgentResolver {
  const resolver = new PoolAgentResolver(loaderFor(rows), {
    ssrfPolicy: { allowPrivate: true },
    resolveFn: deps?.resolveFn ?? (async () => ["93.184.216.34"]),
  });
  created.push(resolver);
  return resolver;
}

function poolRow(overrides: Partial<NetworkPoolRow> & { id: string }): NetworkPoolRow {
  return {
    kind: "http",
    endpoint: "http://proxy.example:8080",
    tenantId: "tenant-a",
    ...overrides,
  };
}

afterEach(async () => {
  for (const resolver of created.splice(0)) await resolver.closeAll();
});

describe("PoolAgentResolver", () => {
  test("builds a proxy agent pair for a tenant's own pool", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1" })]]);
    const resolver = resolverFor(rows);
    const agent = await resolver.resolveAgent("p1", "tenant-a");
    expect(isProxyAgentPair(agent)).toBe(true);
    expect(resolver.agentCount()).toBe(1);
  });

  test("single-flights concurrent builds so one pool shares one agent", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1" })]]);
    const { loader, loads } = countingLoader(rows);
    const resolver = new PoolAgentResolver(loader, {
      ssrfPolicy: { allowPrivate: true },
      resolveFn: async () => ["93.184.216.34"],
    });
    created.push(resolver);

    const [a, b, c] = await Promise.all([
      resolver.resolveAgent("p1", "tenant-a"),
      resolver.resolveAgent("p1", "tenant-a"),
      resolver.resolveAgent("p1", "tenant-a"),
    ]);
    // One build, not three: the cache holds the build *promise*, so the
    // concurrent callers await the same one.
    expect(loads).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("a failed build evicts itself so the next caller retries", async () => {
    const rows = new Map<string, NetworkPoolRow>();
    const resolver = resolverFor(rows);
    await expect(resolver.resolveAgent("missing", "tenant-a")).rejects.toBeInstanceOf(PoolBindingError);
    // The failed promise must not be cached: a pool created after the failure
    // has to be dialable on the next resolve.
    expect(resolver.agentCount()).toBe(0);
    rows.set("missing", poolRow({ id: "missing" }));
    const agent = await resolver.resolveAgent("missing", "tenant-a");
    expect(isProxyAgentPair(agent)).toBe(true);
  });

  test("refuses a pool that belongs to another tenant", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1", tenantId: "tenant-b" })]]);
    const resolver = resolverFor(rows);
    await expect(resolver.resolveAgent("p1", "tenant-a")).rejects.toThrow(
      /not available to this tenant/,
    );
    expect(resolver.agentCount()).toBe(0);
  });

  test("a hostname resolving to a disallowed address is refused before any socket", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1", endpoint: "http://rebind.example:8080" })]]);
    const resolver = new PoolAgentResolver(loaderFor(rows), {
      // Default policy: private ranges are not allowed.
      ssrfPolicy: {},
      resolveFn: async () => ["127.0.0.1"],
    });
    created.push(resolver);
    await expect(resolver.resolveAgent("p1", "tenant-a")).rejects.toThrow(/disallowed address/);
  });

  test("every resolved address is checked, not just the first", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1", endpoint: "http://multi.example:8080" })]]);
    const resolver = new PoolAgentResolver(loaderFor(rows), {
      ssrfPolicy: {},
      // A public first answer must not mask a private second one — that is
      // exactly the DNS-rebind shape the all-addresses check exists for.
      resolveFn: async () => ["93.184.216.34", "169.254.169.254"],
    });
    created.push(resolver);
    await expect(resolver.resolveAgent("p1", "tenant-a")).rejects.toThrow(/disallowed address/);
  });

  test("a literal IP endpoint is validated without a DNS lookup", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1", endpoint: "http://127.0.0.1:8080" })]]);
    let resolved = false;
    const resolver = new PoolAgentResolver(loaderFor(rows), {
      ssrfPolicy: {},
      resolveFn: async () => {
        resolved = true;
        return ["93.184.216.34"];
      },
    });
    created.push(resolver);
    await expect(resolver.resolveAgent("p1", "tenant-a")).rejects.toThrow(/disallowed address/);
    expect(resolved).toBe(false);
  });

  test("releasePool destroys the cached agent and the next resolve rebuilds", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1" })]]);
    const { loader, loads } = countingLoader(rows);
    const resolver = new PoolAgentResolver(loader, {
      ssrfPolicy: { allowPrivate: true },
      resolveFn: async () => ["93.184.216.34"],
    });
    created.push(resolver);

    await resolver.resolveAgent("p1", "tenant-a");
    expect(resolver.agentCount()).toBe(1);
    await resolver.releasePool("p1", "tenant-a");
    expect(resolver.agentCount()).toBe(0);
    await resolver.resolveAgent("p1", "tenant-a");
    expect(loads).toHaveLength(2);
  });

  test("releasePool on an unknown pool is a no-op", async () => {
    const resolver = resolverFor(new Map());
    await resolver.releasePool("never-built", "tenant-a");
    expect(resolver.agentCount()).toBe(0);
  });

  test("the same pool id under two tenants gets two independent agents", async () => {
    const rows = new Map([["shared-id", poolRow({ id: "shared-id", tenantId: "tenant-a" })]]);
    const resolver = resolverFor(rows);
    const agentA = await resolver.resolveAgent("shared-id", "tenant-a");
    // The cache key is tenant-scoped, so tenant-b's resolve is a distinct
    // entry — and it must fail, because the row belongs to tenant-a.
    await expect(resolver.resolveAgent("shared-id", "tenant-b")).rejects.toBeInstanceOf(
      PoolBindingError,
    );
    expect(resolver.agentCount()).toBe(1);
    expect(await resolver.resolveAgent("shared-id", "tenant-a")).toBe(agentA);
  });

  test("closeAll drains the cache", async () => {
    const rows = new Map([
      ["p1", poolRow({ id: "p1" })],
      ["p2", poolRow({ id: "p2" })],
    ]);
    const resolver = resolverFor(rows);
    await resolver.resolveAgent("p1", "tenant-a");
    await resolver.resolveAgent("p2", "tenant-a");
    expect(resolver.agentCount()).toBe(2);
    await resolver.closeAll();
    expect(resolver.agentCount()).toBe(0);
  });

  test("invalid pool agent config is reported as a binding failure", async () => {
    const rows = new Map([
      ["p1", poolRow({ id: "p1", config: { maxSockets: "not-a-number" } })],
    ]);
    const resolver = resolverFor(rows);
    await expect(resolver.resolveAgent("p1", "tenant-a")).rejects.toThrow(
      /invalid pool agent config/,
    );
  });

  test("a socks5 endpoint without a scheme is normalized and dialed", async () => {
    const rows = new Map([["p1", poolRow({ id: "p1", kind: "socks5", endpoint: "proxy.example:1080" })]]);
    const resolver = resolverFor(rows);
    const agent = await resolver.resolveAgent("p1", "tenant-a");
    expect(isProxyAgentPair(agent)).toBe(true);
  });
});

describe("ValidatedNetworkBindingFactory", () => {
  test("without a pool id, fetch uses validated direct egress", () => {
    const stubFetch = (async () =>
      new Response("direct", { status: 200 })) as unknown as typeof fetch;
    const factory = new ValidatedNetworkBindingFactory({ allowPrivate: true }, stubFetch);
    const fetchFn = factory.fetch();
    expect(typeof fetchFn).toBe("function");
  });

  test("a pool binding failure surfaces as a proxy_pool_unhealthy gateway error", async () => {
    const rows = new Map<string, NetworkPoolRow>();
    const resolver = resolverFor(rows);
    const factory = new ValidatedNetworkBindingFactory({ allowPrivate: true }, undefined, resolver);
    const fetchFn = factory.fetch("absent-pool", "tenant-a");
    const error = await fetchFn("http://target.example/").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.code).toBe("proxy_pool_unhealthy");
    expect(gatewayError.status).toBe(503);
    expect(gatewayError.details?.poolId).toBe("absent-pool");
  });

  test("a configured pool is never silently replaced with direct traffic", async () => {
    // The factory holds a resolver, so a pool id means "route through it". A
    // pool that cannot be established must fail the request, not fall back —
    // the operator configured egress for a reason.
    const resolver = resolverFor(new Map());
    let directCalled = false;
    const stubFetch = (async () => {
      directCalled = true;
      return new Response("direct");
    }) as unknown as typeof fetch;
    const factory = new ValidatedNetworkBindingFactory({ allowPrivate: true }, stubFetch, resolver);
    await factory.fetch("absent-pool", "tenant-a")("http://target.example/").catch(() => undefined);
    expect(directCalled).toBe(false);
  });

  test("resolve validates the destination address through the policy", async () => {
    const factory = new ValidatedNetworkBindingFactory({ allowPrivate: true });
    // A literal IP keeps this a unit test: `resolve` is the one-shot
    // resolve+validate entry point, and the address validation — not the DNS
    // lookup — is what it adds over `resolveAllAddresses`.
    const destination = await factory.resolve("93.184.216.34", AbortSignal.timeout(5000), 8443);
    expect(destination.resolvedAddress).toBe("93.184.216.34");
    expect(destination.port).toBe(8443);
  });

  test("resolve rejects a private destination under the default policy", async () => {
    const factory = new ValidatedNetworkBindingFactory({});
    await expect(factory.resolve("127.0.0.1", AbortSignal.timeout(5000))).rejects.toThrow(
      /unsafe upstream address rejected/,
    );
  });
});
