/** Keyset paging remains index-backed with a provider holding 1,000+ accounts. */

import { afterEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { getDb } from "../../src/console/db/client";
import { createAccount, listAccountsPage } from "../../src/console/db/repos/accounts";
import { loginAndGetCookie, useIsolatedDataDir } from "./helpers";

afterEach(() => useIsolatedDataDir());

describe("listAccountsPage", () => {
  test("returns an unchanged response for a matching account version", async () => {
    useIsolatedDataDir();
    createAccount({ provider: "openai", name: "one", credentialKind: "bearer", credential: "token" });
    const cookie = await loginAndGetCookie();
    const first = await app.handle(new Request("http://localhost/console/api/providers/openai/accounts?limit=1", { headers: { cookie } }));
    const payload = await first.json() as { version: string; items: unknown[]; nextCursor: string | null };
    const unchanged = await app.handle(new Request(`http://localhost/console/api/providers/openai/accounts?since=${encodeURIComponent(payload.version)}`, { headers: { cookie } }));

    expect(first.status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect((await unchanged.json()) as unknown).toEqual({ unchanged: true, version: payload.version });
  });

  test("uses a stable keyset cursor and the covering provider index", () => {
    useIsolatedDataDir();
    const db = getDb();
    db.transaction(() => {
      for (let index = 0; index < 1_001; index++) createAccount({ provider: "openai", name: `account-${String(index).padStart(4, "0")}`, credentialKind: "bearer", credential: `token-${index}`, priority: index % 3 });
    })();

    const first = listAccountsPage("openai", 100);
    const second = listAccountsPage("openai", 100, first.nextCursor ?? undefined);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC, id ASC LIMIT ?").all("openai", 101) as Array<{ detail: string }>;

    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeString();
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(first.version).toMatch(/^1001:/);
    expect(plan.some((row) => row.detail.includes("idx_provider_accounts_provider_priority"))).toBeTrue();
  });
});
