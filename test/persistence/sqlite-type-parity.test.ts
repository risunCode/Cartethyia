/**
 * What bun:sqlite hands back is not what the pg-core schema declares, and the
 * handle is where that gap is closed. These pin the read side of every type
 * the schema uses, on a real migrated file, so a Drizzle upgrade or a mapping
 * change that reopens one fails here instead of in a request.
 *
 * Each case states the contract the stores rely on, not an observation: a
 * boolean is a boolean, a timestamp is a `Date`, a numeric keeps its decimal
 * digits as a string, and a bytea comes back as bytes.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { apiKeys, sharePopups, telemetryEvents, tenants } from "../../src/persistence/schema";
import type { Database } from "bun:sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

async function migrated(): Promise<{ sqlite: Database; db: CartethyiaDatabase; dir: string; tenantId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-parity-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db.insert(tenants).values({ name: "parity", status: "active" }).returning({ id: tenants.id });
  const tenantId = tenant?.id;
  if (!tenantId) throw new Error("tenant insert returned no id");
  return { sqlite, db, dir, tenantId };
}

test("a numeric keeps its decimal digits and reads back as a string", async () => {
  const { sqlite, db, dir, tenantId } = await migrated();
  try {
    const id = randomUUID();
    // Bound as a string, the way Drizzle's numeric column binds: the scale is
    // the point. A float would already have rounded 0.000001.
    await db.insert(telemetryEvents).values({
      id,
      tenantId,
      requestId: randomUUID(),
      estimatedCostUsd: "0.000001",
      creditUsed: "2.50",
      tokensPerSec: "999999.99",
    });
    const [row] = await db.select().from(telemetryEvents).where(eq(telemetryEvents.id, id));
    expect(row?.estimatedCostUsd).toBe("0.000001");
    // SQLite stores the value as a real, so trailing zeroes are not kept.
    // What must survive is the value, not the spelling.
    expect(row?.creditUsed).toBe("2.5");
    expect(row?.tokensPerSec).toBe("999999.99");
    for (const value of [row?.estimatedCostUsd, row?.creditUsed, row?.tokensPerSec]) {
      expect(typeof value).toBe("string");
    }
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

test("a null boolean reads back as null, not as 0 or false", async () => {
  const { sqlite, db, dir, tenantId } = await migrated();
  try {
    const id = randomUUID();
    await db.insert(telemetryEvents).values({ id, tenantId, requestId: randomUUID(), stream: null });
    const [row] = await db.select().from(telemetryEvents).where(eq(telemetryEvents.id, id));
    expect(row?.stream).toBeNull();
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

test("a bytea reads back as the same bytes", async () => {
  const { sqlite, db, dir, tenantId } = await migrated();
  try {
    const [key] = await db
      .insert(apiKeys)
      .values({ tenantId, keyMode: "personal", keyHash: "parity-hash", label: "parity", scopes: [] })
      .returning({ id: apiKeys.id });
    const keyId = key?.id;
    if (!keyId) throw new Error("key insert returned no id");
    const image = Buffer.from([0, 1, 2, 255, 10]);
    await db.insert(sharePopups).values({ apiKeyId: keyId, image });
    const [popup] = await db.select().from(sharePopups).where(eq(sharePopups.apiKeyId, keyId));
    // bun:sqlite returns a blob as a Uint8Array, not a Buffer. Both are bytes;
    // the contract is that nothing is dropped or reordered, including a 0 and
    // a 255 that a text round-trip would mangle.
    expect(popup?.image).toBeInstanceOf(Uint8Array);
    expect(Array.from(popup?.image ?? [])).toEqual([0, 1, 2, 255, 10]);
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

test("a timestamp stored as epoch milliseconds reads back as that instant", async () => {
  const { sqlite, db, dir, tenantId } = await migrated();
  try {
    const id = randomUUID();
    const instant = new Date("2026-10-07T06:00:00.000Z");
    await db.insert(telemetryEvents).values({ id, tenantId, requestId: randomUUID() });
    // The writer converts a Date binding to ISO text. A row that arrived
    // another way — a restore, a hand edit — may hold the epoch instead, and
    // the read must still produce a Date rather than throw or return a number.
    sqlite.prepare("UPDATE telemetry_events SET created_at = ? WHERE id = ?").run(instant.getTime(), id);
    const [row] = await db.select().from(telemetryEvents).where(eq(telemetryEvents.id, id));
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.createdAt.getTime()).toBe(instant.getTime());
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

test("a raw execute returns the same types the query builder returns", async () => {
  const { sqlite, db, dir, tenantId } = await migrated();
  try {
    const id = randomUUID();
    await db.insert(telemetryEvents).values({
      id,
      tenantId,
      requestId: randomUUID(),
      stream: true,
      estimatedCostUsd: "0.000001",
    });
    const result = await db.execute(sql`SELECT stream, created_at, estimated_cost_usd FROM telemetry_events WHERE id = ${id}`);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const row = rows[0];
    if (row === undefined) throw new Error("execute returned no row");
    // The backup import reads through execute and compares against rows the
    // builder read. The two paths have to agree, or a re-import doubles history.
    expect(row["stream"]).toBe(true);
    expect(row["created_at"]).toBeInstanceOf(Date);
    expect(row["estimated_cost_usd"]).toBe("0.000001");
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});
