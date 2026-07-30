/** Bulk import handles a mixed 1,000-line paste in bounded worker chunks. */

import { afterEach, describe, expect, test } from "bun:test";
import { app } from "../../../src/app";
import { getDb } from "../../../src/console/db/client";
import { importAccountsForProvider } from "../../../src/console/import/importAccounts";
import { useIsolatedDataDir } from "../helpers";

afterEach(() => useIsolatedDataDir());

describe("bulk account import", () => {
  test("keeps an unrelated request responsive while workers process a 1,000-line import", async () => {
    useIsolatedDataDir();
    const text = Array.from({ length: 1_000 }, (_, index) => `token-${index}`).join("\n");
    const importing = importAccountsForProvider("opencode-free", text);
    const startedAt = performance.now();
    const health = await app.handle(new Request("http://localhost/health"));

    expect(health.status).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect((await importing).imported).toBe(1_000);
  });

  test("imports valid lines and retains skip reasons for a mixed 1,000-line paste", async () => {
    useIsolatedDataDir();
    const text = Array.from({ length: 1_000 }, (_, index) => index % 100 === 0 ? "" : `token-${index}`).join("\n");
    const startedAt = performance.now();
    const result = await importAccountsForProvider("opencode-free", text);

    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(result.imported).toBe(990);
    expect(result.skipped).toHaveLength(10);
    expect(getDb().query("SELECT COUNT(*) AS count FROM provider_accounts WHERE provider = ?").get("opencode-free")).toEqual({ count: 990 });
  });
});
