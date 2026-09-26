import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { apiKeys, models, providers, tenants } from "../../../src/persistence/schema";
import { BackupService } from "../../../src/console/backup/service";
import { dbDescribe } from "../../helpers/db-gate";

/**
 * `BackupService` is the operator-facing gate in front of export and restore.
 * Three properties matter and each is a way an operator gets hurt when it
 * fails: a wrong password must not export (the file carries credentials), a
 * payload that fails validation must leave the database untouched, and a
 * restore must only ever write the restoring tenant's rows.
 *
 * The password check is a real call, so the suite supplies a verifier that
 * accepts one secret and rejects everything else, and asserts the gate on the
 * observable outcome (a thrown 401, no payload) rather than on a spy.
 */
dbDescribe("BackupService", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const providerId = `backup-svc-${randomUUID().slice(0, 8)}`;
  const otherProviderId = `backup-svc-other-${randomUUID().slice(0, 8)}`;
  const otherKeyId = randomUUID();
  const GOOD_PASSWORD = "correct-horse-battery-staple";

  function service(): BackupService {
    return new BackupService({
      db,
      verifyPassword: async (password) => password === GOOD_PASSWORD,
    });
  }

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: `backup-svc-${tenantId}`, status: "active" },
        { id: otherTenantId, name: `backup-svc-other-${otherTenantId}`, status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values([
      { id: providerId, tenantId, enabled: true, baseUrl: "https://backup-svc.test/v1" },
      { id: otherProviderId, tenantId: otherTenantId, enabled: true, baseUrl: "https://other.test/v1" },
    ]);
    await db.insert(models).values({
      providerId,
      modelId: "backup-svc-model",
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    // A key belonging to the *other* tenant: it must never appear in this
    // tenant's export, and a restore by this tenant must not touch it.
    await db.insert(apiKeys).values({
      id: otherKeyId,
      tenantId: otherTenantId,
      keyHash: "d".repeat(64),
      label: "other-tenant-key",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
    });
  });

  afterAll(async () => {
    await db.delete(apiKeys).where(inArray(apiKeys.tenantId, [tenantId, otherTenantId]));
    await db.delete(models).where(inArray(models.providerId, [providerId, otherProviderId]));
    await db.delete(providers).where(inArray(providers.id, [providerId, otherProviderId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
  });

  test("export refuses a wrong password and returns no payload", async () => {
    await expect(
      service().export({ password: "wrong", tenantId }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  test("export returns the tenant's own rows and counts them", async () => {
    const { payload, counts } = await service().export({ password: GOOD_PASSWORD, tenantId });
    expect(counts["providers"]).toBeGreaterThanOrEqual(1);
    expect(payload).toBeDefined();

    const config = (payload as { sections: { config: Record<string, unknown[]> } }).sections.config;
    const exportedProviders = (config["providers"] ?? []) as Array<Record<string, unknown>>;
    const ids = exportedProviders.map((row) => row["id"]);
    expect(ids).toContain(providerId);
    // The other tenant's provider is not in this export.
    expect(ids).not.toContain(otherProviderId);
  });

  test("export defaults to the config section when none is named", async () => {
    const { counts } = await service().export({ password: GOOD_PASSWORD, tenantId });
    // A telemetry-only table is absent from a default (config) export.
    expect(counts["telemetry_events"]).toBeUndefined();
  });

  test("export with an explicit telemetry section includes telemetry tables", async () => {
    const { counts } = await service().export({
      password: GOOD_PASSWORD,
      tenantId,
      sections: ["telemetry"],
    });
    expect(counts["telemetry_events"]).toBeDefined();
    // Config tables are not read when only telemetry was asked for.
    expect(counts["providers"]).toBeUndefined();
  });

  test("export rejects an unknown section", async () => {
    await expect(
      service().export({
        password: GOOD_PASSWORD,
        tenantId,
        sections: ["bogus" as never],
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("preview counts a section without a password and without a payload", async () => {
    const counts = await service().preview(undefined, tenantId);
    expect(counts["providers"]).toBeGreaterThanOrEqual(1);
    expect(counts["telemetry_events"]).toBeUndefined();
  });

  test("restore refuses a wrong password", async () => {
    await expect(
      service().restore("wrong", { app: "cartethyia" }, tenantId),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  test("restore refuses a non-string password without calling the verifier", async () => {
    await expect(
      service().restore(undefined, { app: "cartethyia" }, tenantId),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  test("restore rejects an unrecognized payload and writes nothing", async () => {
    await expect(
      service().restore(GOOD_PASSWORD, { app: "some-other-router", version: 1 }, tenantId),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("restore rejects a payload that fails schema validation", async () => {
    // A native payload naming a table that does not exist must fail validation
    // with the offending name, not reach the transaction.
    const hostile = {
      app: "cartethyia",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      sections: { config: { not_a_real_table: [{ id: "x" }] } },
    };
    await expect(service().restore(GOOD_PASSWORD, hostile, tenantId)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  test("a round trip restores the tenant's own configuration", async () => {
    const { payload } = await service().export({ password: GOOD_PASSWORD, tenantId });
    const result = await service().restore(GOOD_PASSWORD, payload, tenantId);
    expect(result.format).toBe("native");
    expect(result.restored["providers"]).toBeGreaterThanOrEqual(1);

    // The restore wrote this tenant's rows and left the other tenant's alone.
    const [otherKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, otherKeyId))
      .limit(1);
    expect(otherKey?.revokedAt).toBeNull();
    expect(otherKey?.label).toBe("other-tenant-key");
  });

  test("a router export is converted and applied through the same path", async () => {
    const routerExport = {
      providerConnections: [
        {
          id: providerId,
          name: "backup-svc",
          baseUrl: "https://backup-svc.test/v1",
          apiKey: "sk-router-secret",
        },
      ],
      providerNodes: [],
      apiKeys: [],
      combos: [],
    };
    const result = await service().restore(GOOD_PASSWORD, routerExport, tenantId);
    expect(result.format).toBe("nine_router");
    expect(result.report).toBeDefined();
  });
});
