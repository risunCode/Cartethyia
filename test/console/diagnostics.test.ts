import { afterEach, describe, expect, test } from "bun:test";
import { ConsoleDiagnostics } from "../../src/console/diagnostics";
import { ProviderRegistry } from "../../src/providers/registry";
import { cancelScheduledGc } from "../../src/traffic/memory";

afterEach(() => cancelScheduledGc());

function makeDiagnostics(overrides: { repositories?: Partial<Record<string, unknown>>; services?: Partial<Record<string, unknown>> } = {}): ConsoleDiagnostics {
  const registry = new ProviderRegistry();
  const repositories = {
    routing: {
      listAliases: async () => [],
      listCombos: async () => [],
    },
    providerConfig: { get: async () => null },
    customProviders: { get: async () => null },
    accounts: { list: async () => [] },
    proxies: { list: async () => [] },
    ...overrides.repositories,
  } as never;
  const services = {
    shares: { resolve: async () => ({ status: "not_found", keyId: null, key: null, createdAt: null, usage: null }) },
    ...overrides.services,
  } as never;
  return new ConsoleDiagnostics({ services, repositories, registry, prefixes: new Map() });
}

describe("ConsoleDiagnostics — status & metrics (no repositories needed)", () => {
  test("status reports the package version, a positive uptime, and the current time", () => {
    const diag = makeDiagnostics();
    const status = diag.status();
    expect(status.version).toMatch(/^\d+\.\d+\./);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.now).toBeGreaterThan(0);
    expect(status.startedAt).toBeGreaterThan(0);
  });

  test("metrics reports non-negative memory and heap figures with a core count", () => {
    const diag = makeDiagnostics();
    const metrics = diag.metrics();
    expect(metrics.memoryUsedMb).toBeGreaterThanOrEqual(0);
    expect(metrics.heapUsedMb).toBeGreaterThanOrEqual(0);
    expect(metrics.coreCount).toBeGreaterThanOrEqual(1);
    expect(metrics.pid).toBe(process.pid);
  });

  test("gc returns before/after metrics and a gc schedule result", () => {
    const diag = makeDiagnostics();
    const result = diag.gc();
    expect(result.before.memoryUsedMb).toBeGreaterThanOrEqual(0);
    expect(result.after.memoryUsedMb).toBeGreaterThanOrEqual(0);
    expect(result.gc.inFlight).toBeGreaterThanOrEqual(0);
  });

  test("localIps returns a string array (possibly empty on restricted hosts)", () => {
    const diag = makeDiagnostics();
    const ips = diag.localIps();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) expect(typeof ip).toBe("string");
  });
});

describe("ConsoleDiagnostics — resolvePreview", () => {
  test("rejects a non-string or empty model name", async () => {
    const diag = makeDiagnostics();
    const result = await diag.resolvePreview(123 as never);
    expect(result.ok).toBe(false);
    expect(result.trace).toContain("model name is required");
  });

  test("reports an unresolved model when no alias/combo matches", async () => {
    const diag = makeDiagnostics();
    const result = await diag.resolvePreview("no-such-model");
    expect(result.ok).toBe(false);
    expect(result.resolved.kind).toBe("unresolved");
  });

  test("resolves a provider-qualified model reference", async () => {
    const diag = new ConsoleDiagnostics({
      services: { shares: { resolve: async () => ({ status: "not_found", keyId: null, key: null, createdAt: null, usage: null }) } } as never,
      repositories: { routing: { listAliases: async () => [], listCombos: async () => [] } } as never,
      registry: new ProviderRegistry(),
      prefixes: new Map([["openai", "openai"]]),
    });
    const result = await diag.resolvePreview("openai/gpt-4o");
    expect(result.ok).toBe(true);
    expect(result.resolved.kind).toBe("qualified");
  });
});
