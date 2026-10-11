import { describe, expect, test } from "bun:test";
import { CONFIG_TABLES, droppedColumns, ownershipOf, tableName, tablesForSection } from "../../src/console/backup/contracts";
import { DELETE_ALL_SCOPES, type DeleteAllScope } from "../../src/console/backup/store";
import { validateRestorePayload } from "../../src/console/backup/validate";

describe("backup contract coverage", () => {
  test("keeps browser-only studio history out of the backup", () => {
    expect(tablesForSection("config").map(tableName)).not.toContain("studio_sessions");
  });

  test("never carries sign-in accounts, in either direction", () => {
    // A backup is restored *into* an install, not over one: the file's admin
    // username and password hash belong to the install that made it. Restoring
    // them hands the recovering operator a credential they never chose, and a
    // first boot has none to begin with, so the wizard always creates the
    // administrator instead. Pinned in both directions because an export that
    // wrote `console_users` would be the thing that made a restore look
    // reasonable again.
    const config = tablesForSection("config").map(tableName);
    expect(config).not.toContain("console_users");
    expect(config).not.toContain("console_sessions");
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

  test("a still-unknown column is dropped and reported, not fatal", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          providers: [
            { id: "p1", base_url: "https://old.invalid/v1", not_a_column: 1 },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    // Partial by contract: the row still restores, minus the column it cannot
    // carry. Rejecting the file would cost the operator the whole backup.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = tablesForSection("config").find((t) => tableName(t) === "providers")!;
    const rows = result.value.tables.get(table)?.rows;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).not.toHaveProperty("not_a_column");
    expect(rows?.[0]).toMatchObject({ base_url: "https://old.invalid/v1" });
    expect(result.value.warnings).toEqual([
      {
        table: "providers",
        column: "not_a_column",
        reason: `not a column of providers; the column was dropped from every row`,
      },
    ]);
  });

  test("migrates legacy model allow/deny policy into the current single policy", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          api_keys: [
            {
              id: "00000000-0000-0000-0000-000000000002",
              label: "legacy",
              scopes: ["tenant:invoke"],
              model_allowlist: ["alpha"],
              model_denylist: [],
            },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = result.value.tables.get(
        tablesForSection("config").find((table) => tableName(table) === "api_keys")!,
      )?.rows;
      expect(rows?.[0]).toMatchObject({
        model_access_mode: "whitelist",
        model_list: ["alpha"],
      });
      expect(rows?.[0]).not.toHaveProperty("model_allowlist");
      expect(rows?.[0]).not.toHaveProperty("model_denylist");
    }
  });

});

describe("partial restore of an old backup", () => {
  test("an older version is restored, not refused", () => {
    const payload = {
      app: "cartethyia",
      version: 0,
      exportedAt: "2024-01-01T00:00:00.000Z",
      sections: { config: { providers: [{ id: "p1", base_url: "https://old.invalid/v1" }] } },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toEqual({ providers: 1 });
    expect(result.value.warnings.some((w) => w.reason.includes("backup version 0"))).toBe(true);
  });

  test("an unknown table is skipped and reported, while the rest restores", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          legacy_widgets: [{ id: "x" }],
          providers: [{ id: "p1", base_url: "https://old.invalid/v1" }],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toEqual({ providers: 1 });
    expect(result.value.warnings).toContainEqual({
      table: "legacy_widgets",
      reason: 'unknown table in section "config"; skipped',
    });
  });

  test("a row that is not an object is skipped without losing its table", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          providers: ["nope", { id: "p1", base_url: "https://old.invalid/v1" }],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toEqual({ providers: 1 });
    expect(result.value.warnings).toContainEqual({
      table: "providers",
      reason: "row 0 is not an object; skipped",
    });
  });

  test("one warning per column, not one per row", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          providers: [
            { id: "p1", gone_column: 1 },
            { id: "p2", gone_column: 2 },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.filter((w) => w.column === "gone_column")).toHaveLength(1);
    expect(result.value.counts).toEqual({ providers: 2 });
  });

  test("rows are re-assigned to the importing tenant", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: { providers: [{ id: "p1", tenant_id: "someone-else", base_url: "https://x.invalid" }] },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = [...result.value.tables.values()].flatMap((t) => t.rows as Record<string, unknown>[]);
    expect(rows[0]?.tenant_id).toBe("tenant-1");
  });

  test("a file that is not a Cartethyia backup is still refused outright", () => {
    const result = validateRestorePayload({ app: "something-else", version: 1, sections: {} }, "tenant-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("something-else");
  });
});

describe("rows a stale backup cannot complete", () => {
  test("a row missing a required column is skipped, not fatal to the table", () => {
    // `api_keys.scopes` is NOT NULL with no default. A row without it would
    // abort the whole restore transaction, so the row goes and the rest stays.
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          api_keys: [
            { id: "k-stale", label: "no scopes" },
            { id: "k-good", label: "fine", scopes: ["tenant:invoke"] },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = tablesForSection("config").find((t) => tableName(t) === "api_keys")!;
    const rows = result.value.tables.get(table)?.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("k-good");
    expect(result.value.warnings.some((w) => w.reason.includes("scopes"))).toBe(true);
  });

  test("the missing-column warning is reported once per table", () => {
    const payload = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      sections: {
        config: {
          api_keys: [
            { id: "k1", label: "a" },
            { id: "k2", label: "b" },
            { id: "k3", label: "c" },
          ],
        },
      },
    };
    const result = validateRestorePayload(payload, "tenant-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const missing = result.value.warnings.filter((w) => w.reason.includes("required column"));
    expect(missing).toHaveLength(1);
  });
});
