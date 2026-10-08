/**
 * Cross-handle portability: the JSON backup is the Lite→Full vehicle, so an
 * export taken on one backend must restore byte-identically on the other.
 *
 * pg → PGlite with a representative config set (tenant, key, alias, combo),
 * then PGlite → pg with a second tenant to prove the mirror direction and
 * tenant isolation. Telemetry uses the append contract: re-importing the same
 * payload skips duplicates instead of duplicating or deleting.
 */
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { exportBackup, applyRestore } from "../../src/console/backup/store";
import { tablesForSection } from "../../src/console/backup/contracts";
import { restoreOrder, validateRestorePayload } from "../../src/console/backup/validate";
import {
  applyPgliteMigrations,
  buildPgliteHandle,
  createPgliteClient,
} from "../../src/persistence/db-pglite";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { getDb } from "../../src/persistence/postgres";
import {
  modelAliases,
  modelCombos,
  providers,
  tenants,
  telemetryEvents,
} from "../../src/persistence/schema";
import { dbDescribe } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

function sortedRows(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

dbDescribe("backup portability across backends", () => {
  let world: GatewayWorld;
  let liteClient: PGlite | undefined;
  let liteDb: CartethyiaDatabase | undefined;

  afterAll(async () => {
    await world?.cleanup();
    await liteClient?.close().catch(() => undefined);
  });

  test("pg export restores identically on PGlite", async () => {
    world = await createWorld();
    const db = getDb();
    await db.insert(modelAliases).values({
      tenantId: world.tenantId,
      alias: "portable-alias",
      targetModel: world.modelId,
    });
    await db.insert(modelCombos).values({
      tenantId: world.tenantId,
      name: "portable-combo",
      members: [world.modelId],
    });

    const tables = [...tablesForSection("config"), ...tablesForSection("telemetry")];
    const { payload } = await exportBackup(db, tables, world.tenantId);
    // The vehicle is JSON text: prove the payload survives serialization.
    const wire = JSON.parse(JSON.stringify(payload)) as typeof payload;

    liteClient = await createPgliteClient("memory://");
    await applyPgliteMigrations(liteClient);
    liteDb = buildPgliteHandle(liteClient).db;

    // Shared catalog is not carried by a tenant backup (the build supplies
    // it): plant every provider the payload's models hang off, exactly as a
    // seeded target database would already have them.
    const modelRows = (wire.sections.config?.["models"] ?? []) as Array<Record<string, unknown>>;
    const providerIds = [...new Set(modelRows.map((row) => String(row["provider_id"])))];
    for (const providerId of providerIds) {
      await liteDb.insert(providers).values({ id: providerId }).onConflictDoNothing();
    }

    const validation = validateRestorePayload(wire, world.tenantId);
    if (!validation.ok) throw new Error(validation.error);
    const result = await applyRestore(liteDb, validation.value, restoreOrder(), world.tenantId);
    expect(result.restored["model_aliases"]).toBe(1);
    expect(result.restored["model_combos"]).toBe(1);

    const { payload: litePayload } = await exportBackup(liteDb, tables, world.tenantId);
    for (const [section, pgSection] of Object.entries(wire.sections)) {
      const liteSection = (litePayload.sections as Record<string, Record<string, unknown[]>>)[section];
      if (!liteSection) throw new Error(`lite export is missing section ${section}`);
      for (const [table, pgRows] of Object.entries(pgSection as Record<string, unknown[]>)) {
        expect(sortedRows((liteSection[table] ?? []) as Record<string, unknown>[])).toEqual(
          sortedRows(pgRows as Record<string, unknown>[]),
        );
      }
    }
  });

  test("telemetry re-import skips instead of duplicating", async () => {
    if (!liteDb || !world) throw new Error("pg→lite test must run first");
    const createdAt = new Date("2026-10-05T00:00:00.000Z");
    const requestId = "11111111-1111-4111-8111-111111111111";
    await liteDb.insert(telemetryEvents).values({
      tenantId: world.tenantId,
      requestId,
      createdAt,
    });

    const tables = [...tablesForSection("config"), ...tablesForSection("telemetry")];
    const { payload } = await exportBackup(liteDb, tables, world.tenantId);
    const first = validateRestorePayload(payload, world.tenantId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    await applyRestore(liteDb, first.value, restoreOrder(), world.tenantId);

    const second = validateRestorePayload(payload, world.tenantId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    const repeated = await applyRestore(liteDb, second.value, restoreOrder(), world.tenantId);
    expect(repeated.skipped["telemetry_events"]).toBe(1);

    const rows = await liteDb.select().from(telemetryEvents);
    expect(rows.filter((row) => row.requestId === requestId)).toHaveLength(1);
  });

  test("PGlite export restores into pg without touching other tenants", async () => {
    if (!liteDb || !world) throw new Error("pg→lite test must run first");
    const db = getDb();
    const tenantB = await db
      .insert(tenants)
      .values({ name: "portable-b", status: "active" })
      .returning({ id: tenants.id });
    const tenantBId = tenantB[0]?.id;
    if (!tenantBId) throw new Error("tenant B insert returned no id");
    try {
      await liteDb.insert(tenants).values({ id: tenantBId, name: "portable-b", status: "active" });
      await liteDb.insert(modelAliases).values({
        tenantId: tenantBId,
        alias: "mirror-alias",
        targetModel: world.modelId,
      });

      const tables = [...tablesForSection("config"), ...tablesForSection("telemetry")];
      const { payload } = await exportBackup(liteDb, tables, tenantBId);
      const validation = validateRestorePayload(payload, tenantBId);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.error);
      const result = await applyRestore(db, validation.value, restoreOrder(), tenantBId);
      expect(result.restored["model_aliases"]).toBe(1);

      const mirrored = await db
        .select()
        .from(modelAliases)
        .where(eq(modelAliases.tenantId, tenantBId));
      expect(mirrored.map((row) => row.alias)).toEqual(["mirror-alias"]);

      const untouched = await db
        .select()
        .from(modelAliases)
        .where(eq(modelAliases.tenantId, world.tenantId));
      expect(untouched.map((row) => row.alias)).toEqual(["portable-alias"]);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, tenantBId));
      if (liteDb) await liteDb.delete(tenants).where(eq(tenants.id, tenantBId));
    }
  });
});
