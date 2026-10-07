import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { UsageFlushBuffer } from "../../src/persistence/usage-flush";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { Database } from "bun:sqlite";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { apiKeys, tenants } from "../../src/persistence/schema";
import { dbDescribe } from "../helpers/database";

/** Records writes and fails for ids in `failing`, so the buffer's retry is observable. */
function recordingWrite(failing: Set<string> = new Set()) {
  const calls: Array<{ id: string; delta: number }> = [];
  const write = async (_db: CartethyiaDatabase, id: string, delta: number): Promise<void> => {
    if (failing.has(id)) throw new Error("write failed");
    calls.push({ id, delta });
  };
  return { calls, write };
}

const db = {} as CartethyiaDatabase;

test("coalesces many deltas for one key into a single update", async () => {
  const { calls, write } = recordingWrite();
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 10);
  buffer.enqueue("key-1", 5);
  buffer.enqueue("key-2", 3);
  await buffer.flush();
  await buffer.stop();
  expect(calls).toHaveLength(2);
  expect(calls.find((call) => call.id === "key-1")?.delta).toBe(15);
  expect(calls.find((call) => call.id === "key-2")?.delta).toBe(3);
});

test("ignores non-positive deltas", async () => {
  const { calls, write } = recordingWrite();
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 0);
  buffer.enqueue("key-1", -4);
  buffer.enqueue("key-1", Number.NaN);
  await buffer.flush();
  await buffer.stop();
  expect(calls).toHaveLength(0);
});

test("retries a key whose write failed and keeps deltas enqueued during the failure", async () => {
  const failing = new Set(["key-1"]);
  const { calls, write } = recordingWrite(failing);
  const buffer = new UsageFlushBuffer(db, 60_000, write);
  buffer.enqueue("key-1", 7);
  buffer.enqueue("key-2", 2);
  await buffer.flush();
  expect(calls.map((call) => call.id)).toEqual(["key-2"]);
  buffer.enqueue("key-1", 1);
  failing.delete("key-1");
  await buffer.flush();
  await buffer.stop();
  expect(calls.find((call) => call.id === "key-1")?.delta).toBe(8);
});

/**
 * The real flush path, against the embedded backend it exists for.
 *
 * The mocked tests above prove the buffer's bookkeeping; they cannot see the
 * SQL. This one can, and what it pins is the property the buffer is for: the
 * whole batch goes as ONE statement. A flush that fans back out to one UPDATE
 * per key still passes every test above, because `write` is called once per key
 * either way — so without this the regression is invisible until the embedded
 * backend is measured under load.
 *
 * It counts statements by wrapping `exec`, which is what `db.execute` reaches
 * on this backend. A flush that fans back out to one UPDATE per key still
 * passes every mocked test above, so without this count the regression is
 * invisible.
 */
dbDescribe("UsageFlushBuffer on the embedded backend", () => {
  test("one flush of many keys is a single statement, and every delta lands", async () => {
    const previousMode = process.env.CARTETHYIA_DB_MODE;
    process.env.CARTETHYIA_DB_MODE = "lite";
    const sqlite = createSqliteDatabase(":memory:");
    try {
      await applySqliteMigrations(sqlite);
      // The batch statement branches on the mode, and the test environment
      // loads `.env`, which may say `full`. The database under test is
      // SQLite, so the branch must be too — otherwise the flush sends
      // PostgreSQL casts and the fallback hides it by writing per key.
      let statements = 0;
      // `db.execute` reaches `prepare().run()`, not `exec`: a statement with
      // bound parameters cannot go through `exec`, which takes no bindings.
      // Counting prepares counts the flush. The inserts above run first, so
      // the counter starts after them.
      const realPrepare = sqlite.prepare.bind(sqlite);
      sqlite.prepare = ((sql: string) => {
        statements += 1;
        return realPrepare(sql);
      }) as Database["prepare"];

      const { db } = buildSqliteHandle(sqlite);
      const [tenant] = await db
        .insert(tenants)
        .values({ name: "usage-flush-embedded", status: "active" })
        .returning({ id: tenants.id });
      const tenantId = tenant?.id;
      if (!tenantId) throw new Error("tenant insert returned no id");
      const keys = await db
        .insert(apiKeys)
        .values(
          Array.from({ length: 25 }, (_, index) => ({
            tenantId,
            keyMode: "personal" as const,
            keyHash: `usage-flush-${index}`,
            label: `key-${index}`,
            scopes: ["routing:invoke"],
          })),
        )
        .returning({ id: apiKeys.id });

      const buffer = new UsageFlushBuffer(db, 60_000);
      for (const key of keys) buffer.enqueue(key.id, 7);
      // The inserts above prepare their own statements. Only the flush counts.
      statements = 0;
      await buffer.flush();
      await buffer.stop();

      // The flush prepares its UPDATE, then reads changes() to report
      // the affected rows. Two prepares, one write.
      expect(statements).toBe(2);
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
      const total = rows.reduce((sum, row) => sum + Number(row.lifetimeTokensConsumed ?? 0), 0);
      expect(total).toBe(keys.length * 7);
    } finally {
      if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
      else process.env.CARTETHYIA_DB_MODE = previousMode;
      sqlite.close();
    }
  });

  test("a bad key cannot cost the others their delta", async () => {
    const sqlite = createSqliteDatabase(":memory:");
    try {
      await applySqliteMigrations(sqlite);
      const { db } = buildSqliteHandle(sqlite);
      const [tenant] = await db
        .insert(tenants)
        .values({ name: "usage-flush-fallback", status: "active" })
        .returning({ id: tenants.id });
      const tenantId = tenant?.id;
      if (!tenantId) throw new Error("tenant insert returned no id");
      const keys = await db
        .insert(apiKeys)
        .values(
          Array.from({ length: 3 }, (_, index) => ({
            tenantId,
            keyMode: "personal" as const,
            keyHash: `usage-flush-fb-${index}`,
            label: `key-${index}`,
            scopes: ["routing:invoke"],
          })),
        )
        .returning({ id: apiKeys.id });

      // A value that is not a uuid is refused before it reaches SQL, so the
      // batch statement throws; the per-key fallback must still persist the
      // real keys rather than returning them all to pending.
      const buffer = new UsageFlushBuffer(db, 60_000);
      buffer.enqueue("not-a-uuid", 7);
      for (const key of keys) buffer.enqueue(key.id, 7);
      await buffer.flush();
      await buffer.stop();

      const rows = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
      const total = rows.reduce((sum, row) => sum + Number(row.lifetimeTokensConsumed ?? 0), 0);
      expect(total).toBe(keys.length * 7);
    } finally {
      sqlite.close();
    }
  });
});
