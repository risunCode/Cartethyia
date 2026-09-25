import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import {
  apiKeys,
  modelAliases,
  models,
  providerAccounts,
  providers,
  shareLinks,
  telemetryUsageTotals,
  telemetryEvents,
  tenants,
} from "../../../src/persistence/schema";
import {
  CONFIG_TABLES,
  TELEMETRY_TABLES,
  TENANT_TABLE,
  tableName,
} from "../../../src/console/backup/contracts";
import { applyRestore, exportBackup } from "../../../src/console/backup/store";
import { createBackupRoutes } from "../../../src/console/backup/routes";
import { restoreOrder, validateRestorePayload } from "../../../src/console/backup/validate";

/**
 * Export → restore round trip against a real database.
 *
 * These assert the contract an operator depends on: a backup taken today can be
 * restored tomorrow, byte-for-byte on the values that matter, and importing the
 * same file twice does not double-count history. The column encoding (dates,
 * `bytea`) is exercised on real rows rather than fixtures, because the failure
 * mode it guards against — a `Buffer` stringified into `{type,data}` — only
 * appears with a real driver.
 */
function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected a backup object");
  return value as Record<string, unknown>;
}

dbDescribe("backup export/restore round trip", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const providerId = `backup-test-${randomUUID().slice(0, 8)}`;
  const keyId = randomUUID();
  const shareParentId = randomUUID();
  const shareChildId = randomUUID();
  const shareIpNumber = Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const shareClientIp = [
    (shareIpNumber >>> 24) & 255,
    (shareIpNumber >>> 16) & 255,
    (shareIpNumber >>> 8) & 255,
    shareIpNumber & 255,
  ].join(".");
  const shareClientIpKey = `v4:${shareIpNumber}`;
  const requestId = randomUUID();
  const credential = Buffer.from("super-secret-credential-value", "utf8");

  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants).values({ id: tenantId, name: "backup-roundtrip", status: "active" });
    await db.insert(providers).values({
      id: providerId,
      tenantId,
      enabled: true,
      requiresAccount: true,
      baseUrl: "https://roundtrip.test/v1",
    });
    await db.insert(models).values({
      providerId,
      modelId: "roundtrip-model",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      contextLimit: 123_456,
      outputLimit: 7_890,
      modalities: { input: ["text", "image"], output: ["text"] },
      enabled: true,
    });
    await db.insert(providerAccounts).values({
      id: randomUUID(),
      providerId,
      tenantId,
      label: "roundtrip account",
      credentialCiphertext: credential,
      credentialKind: "api_key",
      status: "active",
    });
    await db.insert(apiKeys).values({
      id: keyId,
      tenantId,
      keyHash: "roundtrip-hash",
      label: "roundtrip key",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      modelAllowlist: ["roundtrip-model"],
    });
    await db.insert(apiKeys).values({
      id: shareParentId,
      tenantId,
      keyHash: null,
      keyMode: "share",
      label: "share template",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      keyEncrypted: null,
    });
    await db.insert(apiKeys).values({
      id: shareChildId,
      tenantId,
      keyHash: "b".repeat(64),
      keyMode: "share",
      parentKeyId: shareParentId,
      issuedClientIp: shareClientIp,
      issuedClientIpKey: shareClientIpKey,
      label: "shared child",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      keyEncrypted: null,
    });
    await db.insert(shareLinks).values({
      apiKeyId: shareParentId,
      tokenHash: "c".repeat(64),
      kind: "enroll",
      active: true,
    });
    await db.insert(modelAliases).values({ tenantId, alias: "rt-alias", targetModel: "roundtrip-model" });
    await db.insert(telemetryEvents).values({
      tenantId,
      requestId,
      apiKeyId: keyId,
      status: "completed",
      sourceSurface: "chat",
      requestedModel: "roundtrip-model",
      inputTokens: 11,
      outputTokens: 22,
    });
    await db.insert(telemetryUsageTotals).values({
      tenantId,
      identityType: "api_key",
      entityId: keyId,
      requests: 1,
      errors: 0,
      inputTokens: 11,
      outputTokens: 22,
      lastUsedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(telemetryEvents).where(eq(telemetryEvents.tenantId, tenantId));
    await db.delete(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));
    await db.delete(providerAccounts).where(eq(providerAccounts.tenantId, tenantId));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("restores config and telemetry with values intact", async () => {
    const tables = [...CONFIG_TABLES, TENANT_TABLE, ...TELEMETRY_TABLES];
    const { payload, counts } = await exportBackup(db, tables, tenantId);

    expect(counts["providers"]).toBeGreaterThan(0);
    expect(counts["telemetry_events"]).toBeGreaterThan(0);
    expect(counts["telemetry_usage_totals"]).toBe(1);
    expect(counts["share_links"]).toBe(1);

    // JSON round trip, exactly as a downloaded file would be read back.
    const reparsed = JSON.parse(JSON.stringify(payload)) as unknown;
    const sections = objectRecord(objectRecord(reparsed)["sections"]);
    const config = objectRecord(sections["config"]);
    const keyRows = config["api_keys"];
    if (!Array.isArray(keyRows)) throw new Error("backup has no API-key rows");
    if (!keyRows.some((row) => objectRecord(row)["id"] === shareParentId))
      throw new Error("backup is missing the share parent");
    const childIndex = keyRows.findIndex(
      (row) => objectRecord(row)["id"] === shareChildId,
    );
    if (childIndex < 0) throw new Error("backup is missing the share child");
    const [childRow] = keyRows.splice(childIndex, 1);
    if (childRow === undefined) throw new Error("share child row could not be reordered");
    keyRows.unshift(childRow);
    const validation = validateRestorePayload(reparsed, tenantId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    await applyRestore(db, validation.value, restoreOrder(), tenantId);

    // The provider row survived with its URL, and the account's encrypted
    // credential is the same bytes — the check that would fail if `bytea` had
    // been JSON-stringified into `{type,data}`.
    const [provider] = await db.select().from(providers).where(eq(providers.id, providerId));
    expect(provider?.baseUrl).toBe("https://roundtrip.test/v1");
    expect(provider?.enabled).toBe(true);

    const [account] = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.providerId, providerId));
    expect(Buffer.from(account!.credentialCiphertext!).equals(credential)).toBe(true);

    // The model kept its limits and its nested jsonb modalities.
    const [model] = await db
      .select()
      .from(models)
      .where(eq(models.providerId, providerId));
    expect(model?.contextLimit).toBe(123_456);
    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });

    // The API key kept its allowlist (jsonb) and its created_at (a date that
    // must not come back as a string).
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
    expect(key?.modelAllowlist).toEqual(["roundtrip-model"]);
    expect(key?.createdAt).toBeInstanceOf(Date);
    const [shareChild] = await db.select().from(apiKeys).where(eq(apiKeys.id, shareChildId));
    expect(shareChild?.parentKeyId).toBe(shareParentId);
    expect(shareChild?.issuedClientIpKey).toBe(shareClientIpKey);
    const [enrollment] = await db.select().from(shareLinks).where(eq(shareLinks.apiKeyId, shareParentId));
    expect(enrollment).toMatchObject({ kind: "enroll", active: true });

    const [event] = await db
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.requestId, requestId));
    expect(event?.inputTokens).toBe(11);
    expect(event?.outputTokens).toBe(22);
    expect(event?.createdAt).toBeInstanceOf(Date);
    const [totals] = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.entityId, keyId));
    expect(totals).toMatchObject({
      identityType: "api_key",
      requests: 1,
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  test("importing the same telemetry twice does not duplicate history", async () => {
    const tables = [...CONFIG_TABLES, TENANT_TABLE, ...TELEMETRY_TABLES];
    const { payload } = await exportBackup(db, tables, tenantId);
    const validation = validateRestorePayload(JSON.parse(JSON.stringify(payload)), tenantId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(telemetryEvents)
      .where(eq(telemetryEvents.tenantId, tenantId));

    await applyRestore(db, validation.value, restoreOrder(), tenantId);

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(telemetryEvents)
      .where(eq(telemetryEvents.tenantId, tenantId));

    // Config was replaced; telemetry was merged. The tenant's own event count is
    // therefore unchanged, which is the whole point of append mode.
    expect(after[0]?.n).toBe(before[0]?.n);
    const [totals] = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.entityId, keyId));
    expect(totals?.requests).toBe(1);
  });

  test("a telemetry-only restore leaves configuration untouched", async () => {
    const { payload } = await exportBackup(db, [...TELEMETRY_TABLES], tenantId);
    const validation = validateRestorePayload(JSON.parse(JSON.stringify(payload)), tenantId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    await applyRestore(db, validation.value, restoreOrder(), tenantId);

    const [provider] = await db.select().from(providers).where(eq(providers.id, providerId));
    expect(provider?.baseUrl).toBe("https://roundtrip.test/v1");
    const [model] = await db.select().from(models).where(eq(models.providerId, providerId));
    expect(model?.contextLimit).toBe(123_456);
  });

  test("a restored tenant row does not cascade away telemetry", async () => {
    // `tenants` is upserted, never replaced. Deleting it would cascade into
    // telemetry_events and erase the history this feature exists to keep.
    const tables = [...CONFIG_TABLES, TENANT_TABLE];
    const { payload } = await exportBackup(db, tables, tenantId);
    const validation = validateRestorePayload(JSON.parse(JSON.stringify(payload)), tenantId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    await applyRestore(db, validation.value, restoreOrder(), tenantId);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(telemetryEvents)
      .where(eq(telemetryEvents.tenantId, tenantId));
    expect(row?.n).toBeGreaterThan(0);
  });

  test("an empty table in the payload does not clear the tenant's rows", async () => {
    // The regression this test exists for: a payload that names a table and
    // declares it empty used to `DELETE` the tenant's rows in that table before
    // inserting nothing, so a config-only file carrying `provider_accounts: []`
    // — a router export with no connections, an export taken before any account
    // existed — silently wiped every account. An empty array describes nothing,
    // so it must not be read as "delete everything here".
    const accounts = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(providerAccounts)
      .where(eq(providerAccounts.tenantId, tenantId));
    const before = accounts[0]?.n ?? 0;
    expect(before).toBeGreaterThan(0);

    const validation = validateRestorePayload(
      {
        app: "cartethyia",
        version: 1,
        exportedAt: new Date().toISOString(),
        sections: { config: { provider_accounts: [] } },
      },
      tenantId,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    await applyRestore(db, validation.value, restoreOrder(), tenantId);

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(providerAccounts)
      .where(eq(providerAccounts.tenantId, tenantId));
    expect(after[0]?.n).toBe(before);
  });
});

/**
 * A restore is a routing-visible write: it replaces providers, models, aliases,
 * and combos. The cached route snapshot must be dropped once it commits, or the
 * data plane keeps dispatching the pre-restore catalog — an edited combo keeps
 * resolving its old members — until some unrelated console write invalidates.
 *
 * These run without a database: the route boundary is what is under test, so
 * the service is a stub that records that a restore was requested.
 */
describe("backup restore invalidates the route snapshot", () => {
  const tenantId = "00000000-0000-0000-0000-0000000000aa";
  const sessionAccess = {
    id: "operator",
    tenantId,
    scopes: ["dashboard:write"] as const,
    admissionIdentity: "operator",
  };

  function routesWith(invalidations: { count: number }, restore: () => Promise<unknown>) {
    return createBackupRoutes({
      accessResolver: () => sessionAccess,
      backupFor: () =>
        ({
          restore,
        }) as never,
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations.count += 1;
          return invalidations.count;
        },
      },
    });
  }

  test("a committed restore invalidates exactly once", async () => {
    const invalidations = { count: 0 };
    const app = routesWith(invalidations, async () => ({ restored: {}, skipped: {} }));
    const res = await app.handle(
      new Request("http://localhost/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "pw", backup: { app: "cartethyia" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(invalidations.count).toBe(1);
  });

  test("a failed restore does not invalidate", async () => {
    const invalidations = { count: 0 };
    const app = routesWith(invalidations, async () => {
      throw new Error("restore rolled back");
    });
    const res = await app.handle(
      new Request("http://localhost/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "pw", backup: { app: "cartethyia" } }),
      }),
    );
    expect(res.status).toBe(500);
    expect(invalidations.count).toBe(0);
  });
});

dbDescribe("backup validation", () => {
  // Any stable id: these cases never reach the database, they assert what the
  // validator refuses before a write is attempted.
  const tenantId = "00000000-0000-0000-0000-0000000000ff";

  test("rejects an unknown column instead of writing it", () => {
    const result = validateRestorePayload({
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { config: { providers: [{ id: "x", not_a_column: 1 }] } },
    }, tenantId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not_a_column");
  });

  test("rejects an unknown table", () => {
    const result = validateRestorePayload({
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { config: { pg_shadow: [] } },
    }, tenantId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pg_shadow");
  });

  test("rejects a backup from a different application, naming it", () => {
    const result = validateRestorePayload({
      app: "some-other-router",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {},
    }, tenantId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("some-other-router");
  });

  test("rejects a version it does not understand", () => {
    const result = validateRestorePayload({
      app: "cartethyia",
      version: 99,
      exportedAt: new Date().toISOString(),
      sections: {},
    }, tenantId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("99");
  });

  test("accepts a json column carrying a nested object", () => {
    const result = validateRestorePayload({
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { config: { models: [{ provider_id: "p", model_id: "m", modalities: { input: ["text"] } }] } },
    }, tenantId);
    expect(result.ok).toBe(true);
  });

  test("rejects a nested object on a scalar column", () => {
    const result = validateRestorePayload({
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: { config: { providers: [{ id: "x", base_url: { nested: true } }] } },
    }, tenantId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("base_url");
  });

  test("every config table name resolves, so an export is always importable", async () => {
    // A table added to the schema but not to CONFIG_TABLES would still export
    // fine and then fail on import with "unknown table" — this catches that.
    for (const table of CONFIG_TABLES) {
      const result = validateRestorePayload({
        app: "cartethyia",
        version: 1,
        exportedAt: new Date().toISOString(),
        sections: { config: { [tableName(table)]: [] } },
      }, tenantId);
      expect(result.ok).toBe(true);
    }
  });
});
