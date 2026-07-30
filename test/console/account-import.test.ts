/** Account import parses pasted credentials off-thread and persists valid entries. */

import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "../../src/console/db/client";
import { importAccountsForProvider } from "../../src/console/import/importAccounts";
import { useIsolatedDataDir } from "./helpers";

afterEach(() => useIsolatedDataDir());

describe("importAccountsForProvider", () => {
  test("imports extracted credentials, skips blank lines, and reports renamed collisions", async () => {
    useIsolatedDataDir();
    const first = await importAccountsForProvider("opencode-free", 'access_token: token-one\n\n{"token":"token-two"}');
    const second = await importAccountsForProvider("opencode-free", "token-three");

    expect(first).toMatchObject({ imported: 2, skipped: [{ line: 2, reason: "blank line" }] });
    expect(second.renamed).toEqual([{ line: 1, name: "Imported 1 (2)" }]);
    const credentials = getDb().query("SELECT credential FROM provider_accounts WHERE provider = ? ORDER BY created_at, name").all("opencode-free") as Array<{ credential: string }>;
    expect(credentials.map((account) => account.credential)).toEqual(["token-one", "token-two", "token-three"]);
  });
});
