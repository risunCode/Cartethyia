import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { telemetryEvents, tenants } from "../../src/persistence/schema";
import { DrizzleTelemetryStore } from "../../src/persistence/telemetry-store";
import { dbDescribe } from "../helpers/db-gate";

/**
 * Retention must prune aged events in bounded batches.
 *
 * `telemetry_events` is the highest-volume table, and the retention sweep used
 * to delete every aged row in one statement. That grows without limit: it holds
 * locks and WAL for the whole sweep, and on a long-lived deployment it can
 * exceed the pool's `statement_timeout` and be cancelled — so the sweep never
 * converges and retention silently stops working. Batching makes each step
 * bounded and independently committed, so progress survives a cancel.
 *
 * The observable contract this pins: one call to `pruneTelemetry` removes aged
 * rows while leaving rows inside the window untouched, and does so without
 * issuing an unbounded statement. The batch bound is asserted by counting the
 * statements the store issues, which is the only way to see "bounded" from
 * outside — a value-only assertion passes for both shapes.
 */

dbDescribe("telemetry retention prunes in bounded batches", () => {
  const tenantId = randomUUID();
  let db: CartethyiaDatabase;
  let store: DrizzleTelemetryStore;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleTelemetryStore(db);
    await db.insert(tenants).values({
      id: tenantId,
      name: `telemetry-prune-${tenantId}`,
      status: "active",
    });
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  /** One telemetry row at an explicit `created_at`. */
  function event(createdAt: Date) {
    return {
      tenantId,
      requestId: randomUUID(),
      sourceSurface: "chat" as const,
      requestedModel: "openai/gpt-5",
      stream: false,
      status: "completed" as const,
      createdAt,
    };
  }

  test("removes aged rows and keeps rows inside the window", async () => {
    const now = Date.now();
    const aged = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const fresh = new Date(now - 1 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);

    await store.insertEvents([event(aged), event(aged), event(fresh)]);

    await store.pruneTelemetry(cutoff);

    const remaining = await db
      .select({ createdAt: telemetryEvents.createdAt })
      .from(telemetryEvents)
      .where(eq(telemetryEvents.tenantId, tenantId));

    // The two aged rows are gone; the fresh one survives the cutoff.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.createdAt.getTime()).toBe(fresh.getTime());
  });

  test("never issues one unbounded delete over the whole aged set", async () => {
    // The batch bound is what makes the sweep bounded, and from outside it is
    // only visible as a `LIMIT` on the statement Postgres receives. A single
    // unbounded DELETE carries none; the batched form carries one per
    // statement. The statement text is therefore the assertion — a value-only
    // check passes for both shapes, which is the trap this guards.
    //
    // Recording happens at the `pg` pool, the last place the SQL is still text:
    // drizzle hands the driver an opaque chunk tree, so a spy above it sees
    // structure, not the query. The pool is built on the same isolated URL the
    // gate routed `DATABASE_URL` to, and closed when this test finishes.
    const statements: string[] = [];
    const spiedPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const originalQuery = spiedPool.query.bind(spiedPool);
    spiedPool.query = ((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string") statements.push(first);
      else if (first && typeof first === "object" && "text" in first) {
        statements.push(String((first as { text: unknown }).text));
      }
      return (originalQuery as (...a: unknown[]) => unknown)(...args);
    }) as typeof spiedPool.query;

    try {
      const spiedStore = new DrizzleTelemetryStore(drizzle(spiedPool));
      const now = Date.now();
      const aged = new Date(now - 40 * 24 * 60 * 60 * 1000);
      const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
      await spiedStore.insertEvents([event(aged)]);

      await spiedStore.pruneTelemetry(cutoff);

      const deletes = statements.filter((s) => s.toLowerCase().includes("delete from"));
      expect(deletes.length).toBeGreaterThan(0);
      for (const statement of deletes) {
        expect(statement.toLowerCase()).toContain("limit");
      }
    } finally {
      await spiedPool.end();
    }
  });
});
