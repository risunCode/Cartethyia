import { describe, expect, test } from "bun:test";
import { CONFIG_TABLES, droppedColumns, ownershipOf, tableName, tablesForSection } from "../../src/console/backup/contracts";
import { DELETE_ALL_SCOPES, type DeleteAllScope } from "../../src/console/backup/store";
import { validateRestorePayload } from "../../src/console/backup/validate";

describe("backup contract coverage", () => {
  test("includes tenant-owned studio sessions in configuration", () => {
    expect(tablesForSection("config").map(tableName)).toContain("studio_sessions");
  });

  test("every config table has an ownership rule", () => {
    for (const table of CONFIG_TABLES) expect(() => ownershipOf(table)).not.toThrow();
  });

  test("delete scopes are represented as a narrow runtime union", () => {
    const scopes: readonly DeleteAllScope[] = DELETE_ALL_SCOPES;
    expect(scopes).toEqual(["providers", "proxies", "configuration"]);
  });
});

describe("legacy dropped columns on restore", () => {
  test("provider_accounts.max_inflight is accepted and skipped", () => {
    const table = tablesForSection("config").find((t) => tableName(t) === "provider_accounts");
    expect(table).toBeDefined();
    expect(droppedColumns(table!)).toContain("max_inflight");

    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          provider_accounts: [
            { id: "00000000-0000-0000-0000-000000000001", label: "x", credential_kind: "static", max_inflight: 10 },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
  });

  test("a still-unknown column is rejected with the same message", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          provider_accounts: [
            { id: "00000000-0000-0000-0000-000000000001", label: "x", credential_kind: "static", not_a_column: 1 },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("is not a column");
  });
});
