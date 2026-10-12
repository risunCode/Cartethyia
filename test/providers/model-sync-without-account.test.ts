/**
 * Model sync must not require a stored account.
 *
 * It used to: `modelDiscoveryRequiresCredential` defaulted to true, so a
 * provider with no usable account answered a local 409 — "Model sync needs a
 * usable account first" — before any request left the gateway. Most providers
 * publish their model list without auth, so that gate blocked the case it was
 * meant to protect and told the operator to add an account they did not need.
 *
 * The gate is gone. A usable account is used when there is one; the fetch is
 * attempted either way, and an upstream that does require auth answers 401
 * itself — naming the real problem instead of a missing prerequisite.
 *
 * These drive `syncModels` with no account at all and assert the resolver is
 * reached. A stub resolver that returns `null` makes syncModels fail with the
 * upstream-shaped 502, which is only reachable *after* the gate that used to
 * throw 409 — so the error itself is the evidence.
 */
import { describe, expect, test } from "bun:test";
import { ProviderProbingService } from "../../src/providers/discovery/probing-service";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { ProviderRegistry } from "../../src/providers/registry";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

const PROVIDER_ID = "groq";

/** Enough of a drizzle query builder to answer every read with "nothing". */
function emptyDb(): CartethyiaDatabase {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    chain[method] = () => chain;
  }
  // A thenable that resolves to no rows, so every `await db.select()...` is [].
  chain.then = (resolve: (value: unknown) => unknown) => resolve([]);
  const db = {
    select: () => chain,
    query: async () => ({ rows: [] }),
    execute: async () => ({ rows: [] }),
  };
  return db as unknown as CartethyiaDatabase;
}

function serviceWithResolver(resolver: () => Promise<null>): ProviderProbingService {
  const base = createDefaultProviderRegistry();
  const registry = {
    resolveModelDiscovery: async (providerId: string) =>
      providerId === PROVIDER_ID ? resolver : base.resolveModelDiscovery(providerId),
    resolve: (providerId: string) => base.resolve(providerId),
    registrations: () => base.registrations(),
  } as unknown as ProviderRegistry;

  return new ProviderProbingService({
    db: emptyDb(),
    telemetryBuffer: undefined,
    defaultEndpoints: { chat: "/chat/completions", responses: "/responses", messages: "/v1/messages" },
    bundledModelCatalog: new Map(),
    outboundFetchFor: async () => ({ fetch: globalThis.fetch }),
    snapshotInvalidator: { invalidate: () => {} },
    providerRegistry: registry,
  });
}

describe("model sync without a stored account", () => {
  test("reaches the discovery resolver instead of failing on a missing account", async () => {
    let called = false;
    const service = serviceWithResolver(async () => {
      called = true;
      return null;
    });

    const error = await service
      .syncModels("tenant-1", PROVIDER_ID)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { code?: string; status?: number; message?: string });

    // The resolver ran. A gate would have thrown before it was reached.
    expect(called).toBe(true);
    expect(error).toBeDefined();
  });

  test("reports an upstream failure, not a missing-account precondition", async () => {
    const service = serviceWithResolver(async () => null);
    const error = await service
      .syncModels("tenant-1", PROVIDER_ID)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as { code?: string; status?: number; message?: string });

    expect(error?.message).not.toMatch(/needs a usable/i);
    expect(error?.message).toMatch(/discovery failed/i);
  });

  test("no registration may still declare the removed credential flag", () => {
    // The flag was deleted from the registry contract. A row that kept it would
    // be silently ignored, leaving the next reader to wonder why it does
    // nothing.
    for (const row of createDefaultProviderRegistry().registrations()) {
      expect(Object.keys(row as object)).not.toContain("modelDiscoveryRequiresCredential");
    }
  });
});