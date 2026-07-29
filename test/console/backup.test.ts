/** Backup export/restore tests (REQ-5): export gated, round-trip, invalid rollback. */

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { listAuditEvents } from "../../src/console/db/repos/audit";
import { BACKUP_APP, BACKUP_VERSION } from "../../src/console/backup/export";
import { validateRestorePayload } from "../../src/console/backup/restore";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

beforeEach(() => {
  useIsolatedDataDir();
});

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

function validPayload(tables: Record<string, unknown>): Record<string, unknown> {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

describe("backup payload validation", () => {
  test("accepts a well-formed payload", () => {
    const result = validateRestorePayload(validPayload({ settings: {}, api_keys: [] }));
    expect(result.ok).toBe(true);
  });

  test("rejects wrong app / version / tables shape", () => {
    const wrongApp = validateRestorePayload(validPayload({}) as unknown);
    expect(wrongApp.ok).toBe(true); // empty tables object is fine
    const bad = validateRestorePayload({ ...validPayload({}), app: "not-cartethyia" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("app");

    const badVersion = validateRestorePayload({ ...validPayload({}), version: 999 });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error).toContain("version");

    const badTables = validateRestorePayload({ ...validPayload({}), tables: [] });
    expect(badTables.ok).toBe(false);
  });

  test("rejects unknown tables and unknown columns", () => {
    const unknownTable = validateRestorePayload(validPayload({ nope_table: [] }));
    expect(unknownTable.ok).toBe(false);
    if (!unknownTable.ok) expect(unknownTable.error).toContain("unknown table");

    const unknownCol = validateRestorePayload(validPayload({ api_keys: [{ id: "x", evil_col: 1 }] }));
    expect(unknownCol.ok).toBe(false);
    if (!unknownCol.ok) expect(unknownCol.error).toContain("not a known column");
  });

  test("rejects non-primitive cell values", () => {
    const nested = validateRestorePayload(validPayload({ api_keys: [{ id: "x", name: { deep: true } }] }));
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error).toContain("primitive");
  });

  test("accepts custom provider headers from current backups", () => {
    const result = validateRestorePayload(validPayload({
      custom_providers: [{ id: "awok", slug: "awok", name: "Awok", type: "openai-compatible", base_url: "https://example.com/v1", credential_enc: "enc", timeout_seconds: 30, models_json: "[]", headers_json: "{}", created_at: "2026-01-01", updated_at: "2026-01-01" }],
    }));
    expect(result.ok).toBe(true);
  });

  test("settings may be a single object or an array", () => {
    const asObject = validateRestorePayload(validPayload({ settings: { id: 1, password_version: 1, settings_json: "{}" } }));
    expect(asObject.ok).toBe(true);
    const asArray = validateRestorePayload(validPayload({ settings: [{ id: 1, password_version: 1, settings_json: "{}" }] }));
    expect(asArray.ok).toBe(true);
  });
});

describe("backup export API", () => {
  test("export without X-Console-Password is 401 + audited", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(authed("/console/api/settings/backup", cookie));
    expect(res.status).toBe(401);
    expect(listAuditEvents().filter((event) => event.type === "backup.export.denied")).toHaveLength(1);
  });

  test("export with wrong password is 401", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      new Request("http://localhost/console/api/settings/backup", { headers: { cookie, "x-console-password": "nope" } })
    );
    expect(res.status).toBe(401);
  });

  test("export returns configuration tables only", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      new Request("http://localhost/console/api/settings/backup", { headers: { cookie, "x-console-password": "carte1234" } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition") ?? "").toContain("attachment");
    const data = (await res.json()) as { app: string; version: number; tables: Record<string, unknown> };
    expect(data.app).toBe(BACKUP_APP);
    expect(data.version).toBe(BACKUP_VERSION);
    expect(Array.isArray(data.tables.settings)).toBe(false); // single-row → object
    expect(Array.isArray(data.tables.api_keys)).toBe(true);
    expect(data.tables.usage_history).toBeUndefined();

  });

  test("settings in backup keep login state (hash + jwt_secret present)", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      new Request("http://localhost/console/api/settings/backup", { headers: { cookie, "x-console-password": "carte1234" } })
    );
    const data = (await res.json()) as { tables: { settings: Record<string, unknown> } };
    expect(typeof data.tables.settings.password_hash).toBe("string");
    expect(typeof data.tables.settings.jwt_secret).toBe("string");
  });
});

describe("backup restore API", () => {
  test("restore with wrong password is 401 and DB is untouched", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(postJson("/console/api/keys", { name: "survivor" }, { cookie }));

    const res = await app.handle(
      postJson("/console/api/settings/restore", { password: "wrong", backup: validPayload({ api_keys: [] }) }, { cookie })
    );
    expect(res.status).toBe(401);

    const listed = await app.handle(authed("/console/api/keys", cookie));
    const items = ((await listed.json()) as { items: unknown[] }).items;
    expect(items.length).toBe(1);
  });

  test("restore with invalid payload is 400 and DB is untouched", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(postJson("/console/api/keys", { name: "still-here" }, { cookie }));

    const res = await app.handle(
      postJson(
        "/console/api/settings/restore",
        { password: "carte1234", backup: validPayload({ api_keys: [{ id: "x", bogus_column: 1 }] }) },
        { cookie }
      )
    );
    expect(res.status).toBe(400);

    const listed = await app.handle(authed("/console/api/keys", cookie));
    const items = ((await listed.json()) as { items: unknown[] }).items;
    expect(items.length).toBe(1);
  });

  test("round-trip: export → mutate → restore brings state back", async () => {
    const cookie = await loginAndGetCookie();

    // Seed state: one key + one provider account.
    const keyRes = await app.handle(postJson("/console/api/keys", { name: "round-trip-key" }, { cookie }));
    expect(keyRes.status).toBe(201);
    const acctRes = await app.handle(
      postJson("/console/api/providers/opencode-free/accounts", { name: "round-trip-acct", credential: "secret-value" }, { cookie })
    );
    expect(acctRes.status).toBe(201);

    // Export.
    const exportRes = await app.handle(
      new Request("http://localhost/console/api/settings/backup", { headers: { cookie, "x-console-password": "carte1234" } })
    );
    expect(exportRes.status).toBe(200);
    const backup = (await exportRes.json()) as Record<string, unknown>;

    // Mutate: add a second key + revoke the first.
    await app.handle(postJson("/console/api/keys", { name: "extra-key" }, { cookie }));
    const keysBefore = await app.handle(authed("/console/api/keys", cookie));
    const beforeItems = ((await keysBefore.json()) as { items: { id: string }[] }).items;
    expect(beforeItems.length).toBe(2);
    const revokeRes = await app.handle(postJson(`/console/api/keys/${beforeItems[0]!.id}/revoke`, {}, { cookie }));
    expect(revokeRes.status).toBe(200);

    // Restore the snapshot.
    const restoreRes = await app.handle(
      postJson("/console/api/settings/restore", { password: "carte1234", backup }, { cookie })
    );
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { ok: boolean; restored: Record<string, number> };
    expect(restored.ok).toBe(true);
    expect(restored.restored.api_keys).toBe(1);
    expect(restored.restored.provider_accounts).toBe(1);

    // Session still works (backup carried the same settings row).
    const keysAfter = await app.handle(authed("/console/api/keys", cookie));
    expect(keysAfter.status).toBe(200);
    const afterItems = ((await keysAfter.json()) as { items: { name: string; active: boolean }[] }).items;
    expect(afterItems.length).toBe(1);
    expect(afterItems[0]!.name).toBe("round-trip-key");
    expect(afterItems[0]!.active).toBe(true);

    // Account credential survived the round-trip (still decryptable).
    const accts = await app.handle(authed("/console/api/providers/opencode-free/accounts", cookie));
    const acctItems = ((await accts.json()) as { items: { name: string }[] }).items;
    expect(acctItems.length).toBe(1);
    expect(acctItems[0]!.name).toBe("round-trip-acct");

    expect(listAuditEvents().filter((event) => event.type === "backup.restored")).toHaveLength(1);
  });
});
