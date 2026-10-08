/**
 * The payload sweep deletes through `db.execute(sql`...`)`, and that path
 * renders Drizzle chunks by hand. A table or column chunk rendered as a
 * bound parameter reaches SQLite as `DELETE FROM ?`, which fails with
 * `near "?": syntax error` and the sweep logs it every pass. This runs the
 * real statement against a migrated file.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { DrizzleTelemetryStore } from "../../src/persistence/stores/telemetry-store";
import { telemetryPayloads, tenants } from "../../src/persistence/schema";

test("the payload sweep deletes expired rows on the sqlite backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-sweep-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "sweep", status: "active" })
      .returning({ id: tenants.id });
    if (tenant === undefined) throw new Error("tenant insert returned no row");
    const frame = {
      tenantId: tenant.id,
      storage: "jsonl-file",
      file: "frames.jsonl",
      offset: 0,
      length: 4,
      checksum: "abcd",
      version: 1,
    };
    await db.insert(telemetryPayloads).values([
      { ...frame, expiresAt: new Date(Date.now() - 60_000) },
      { ...frame, offset: 4, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);

const store = new DrizzleTelemetryStore(db);
    const deleted = await store.deleteExpiredPayloads();
    

    expect(deleted).toBe(1);
    const left = await db.select({ id: telemetryPayloads.id }).from(telemetryPayloads);
    expect(left).toHaveLength(1);
  } finally {
    sqlite.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
    }
  }
});
