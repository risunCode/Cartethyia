import { describe, expect, test } from "bun:test";
import { createShareRouter } from "../../../src/console/share/share-router";
import { hashShareToken, type ShareApiKeyRow, type ShareLinkStore } from "../../../src/persistence/share-store";
import type { CartethyiaDatabase } from "../../../src/persistence/postgres";
import type { ShareUsagePort } from "../../../src/console/share/share-usage";

/** A share-link fixture: the bearer token plus the key row it resolves to. */
interface ShareFixture {
  readonly token: string;
  readonly row: ShareApiKeyRow;
}

/**
 * In-memory share store keyed by token hash. Mirrors the Drizzle store's
 * observable contract: monitor links stay active, setup links are consumed
 * exactly once.
 */
function fakeStore(fixtures: readonly ShareFixture[]) {
  const byHash = new Map(fixtures.map((f) => [hashShareToken(f.token), f.row]));
  const consumed = new Set<string>();
  const store: ShareLinkStore & { touched: string[] } = {
    touched: [],
    async create() {
      throw new Error("not used");
    },
    async getApiKeyByShareToken(tokenHash) {
      return byHash.get(tokenHash) ?? null;
    },
    async consumeSetupToken(tokenHash) {
      if (consumed.has(tokenHash)) return null;
      const row = byHash.get(tokenHash);
      if (!row) return null;
      consumed.add(tokenHash);
      return row;
    },
    async touchView(tokenHash) {
      store.touched.push(tokenHash);
    },
    async listForApiKey() {
      return [];
    },
    async revoke() {
      return false;
    },
  };
  return store;
}

function shareRow(overrides: Partial<ShareApiKeyRow> = {}): ShareApiKeyRow {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    name: "shared-key",
    keyPrefix: "rk_",
    keyEncrypted: null,
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    lifetimeTokensConsumed: 0,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    shareCreatedAt: "2026-01-02T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

const EMPTY_USAGE: ShareUsagePort = {
  async getApiKeyTotals() {
    return {
      totalTokens: 0,
      totalRequests: 0,
      dailyTokens: 0,
      monthlyTokens: 0,
      successCount: 0,
      errorCount: 0,
      lastUsedAt: null,
    };
  },
};

const noopDb = {} as unknown as CartethyiaDatabase;

const VALID_TOKEN = "a".repeat(43);

describe("public share router", () => {
  test("serves monitor data for a valid token and marks the view", async () => {
    const store = fakeStore([
      {
        token: VALID_TOKEN,
        row: shareRow({
          modelAllowlist: ["anthropic/", "openai/gpt-5"],
          notesTitle: "Bansos Token",
        }),
      },
    ]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      usage: EMPTY_USAGE,
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "shared-key",
      active: true,
      modelAllowlist: ["anthropic/", "openai/gpt-5"],
      notes: { title: "Bansos Token", subtitle: null, body: null },
    });
    expect(store.touched).toEqual([hashShareToken(VALID_TOKEN)]);
  });

  test("never advertises a loopback origin when the OAuth origin is loopback", async () => {
    // `CARTETHYIA_PUBLIC_ORIGIN` is the fixed OAuth redirect host; in a local
    // deployment it is a loopback address. A share page reached through a
    // tunnel would otherwise tell its recipient to call 127.0.0.1. The payload
    // must not carry an origin at all — the browser supplies its own.
    //
    // A configured allowlist keeps this on the success path: the unrestricted
    // fallback enumerates the catalog and needs a real database, which would
    // turn the response into a 500 whose error body contains no origin and
    // make the assertions below pass without testing anything.
    const original = process.env.CARTETHYIA_PUBLIC_ORIGIN;
    process.env.CARTETHYIA_PUBLIC_ORIGIN = "http://127.0.0.1:12800";
    try {
      const router = createShareRouter({
        db: noopDb,
        shareStore: fakeStore([
          { token: VALID_TOKEN, row: shareRow({ modelAllowlist: ["anthropic/"] }) },
        ]),
        usage: EMPTY_USAGE,
      });
      const response = await router.handle(
        new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["baseUrl"]).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    } finally {
      if (original === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
      else process.env.CARTETHYIA_PUBLIC_ORIGIN = original;
    }
  });

  test("never returns the raw key when only the hash is stored", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([
        { token: VALID_TOKEN, row: shareRow({ keyEncrypted: null, modelAllowlist: ["anthropic/"] }) },
      ]),
      usage: EMPTY_USAGE,
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    const body = (await response.json()) as { apiKey: { key: string | null } };
    expect(body.apiKey.key).toBeNull();
  });

  test("rejects unknown and short tokens with a JSON 404", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([]),
      usage: EMPTY_USAGE,
    });

    for (const token of ["short", "b".repeat(43)]) {
      const response = await router.handle(
        new Request(`http://internal.test/share/${token}/data`),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain("<html");
    }
  });

  test("consumes a setup token exactly once", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([{ token: VALID_TOKEN, row: shareRow() }]),
      usage: EMPTY_USAGE,
    });

    const first = await router.handle(
      new Request(`http://internal.test/share/setup/${VALID_TOKEN}/data`),
    );
    expect(first.status).toBe(200);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "shared-key", key: null });

    const second = await router.handle(
      new Request(`http://internal.test/share/setup/${VALID_TOKEN}/data`),
    );
    expect(second.status).toBe(404);
  });
});
