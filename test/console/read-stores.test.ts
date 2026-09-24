import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../src/persistence/postgres";
import { dbDescribe } from "../helpers/db-gate";
import { adminAuditLog, consoleUsers, tenants } from "../../src/persistence/schema";
import { DrizzleAuditReadStore } from "../../src/console/domains/audit/store";

describe("audit.test.ts", () => {
async function ensureTenant(id: string): Promise<void> {
  await getDb()
    .insert(tenants)
    .values({ id, name: `audit-test-${id.slice(0, 8)}`, status: "active" })
    .onConflictDoNothing();
}

dbDescribe("DrizzleAuditReadStore — real DB", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleAuditReadStore;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const createdIds: string[] = [];

  beforeAll(() => {
    db = getDb();
    store = new DrizzleAuditReadStore(db);
  });
  afterAll(async () => {
    if (createdIds.length > 0) {
      await db.delete(adminAuditLog).where(inArray(adminAuditLog.id, createdIds));
    }
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  async function insert(row: {
    tenantId: string | null;
    actor?: string;
    action?: string;
    target?: string;
    createdAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    createdIds.push(id);
    await db.insert(adminAuditLog).values({
      id,
      actor: row.actor ?? "admin@example.test",
      tenantId: row.tenantId,
      action: row.action ?? "provider.updated",
      target: row.target ?? `provider:${randomUUID()}`,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    });
    return id;
  }

  test("returns only rows owned by the calling tenant", async () => {
    await ensureTenant(tenantA);
    await ensureTenant(tenantB);
    await insert({ tenantId: tenantA });
    await insert({ tenantId: tenantB });

    const page = await store.list({ tenantId: tenantA, platformAdmin: false, limit: 50 });
    for (const entry of page.entries) {
      expect(entry.tenantId).toBe(tenantA);
    }
  });

  test("platformAdmin caller also sees tenant-null (platform-wide) rows", async () => {
    await ensureTenant(tenantA);
    const platformRow = await insert({ tenantId: null, action: "backup.reset" });

    const regular = await store.list({ tenantId: tenantA, platformAdmin: false, limit: 200 });
    expect(regular.entries.some((e) => e.id === platformRow)).toBe(false);

    const platform = await store.list({ tenantId: tenantA, platformAdmin: true, limit: 200 });
    expect(platform.entries.some((e) => e.id === platformRow)).toBe(true);
  });

  test("cursor pagination walks the full tail without duplicating rows", async () => {
    await ensureTenant(tenantA);
    // Clean the tenant so the fixture drives the whole page count.
    await db
      .delete(adminAuditLog)
      .where(and(eq(adminAuditLog.tenantId, tenantA), eq(adminAuditLog.action, "cursor.walk")));
    const inserted: string[] = [];
    const base = Date.now();
    for (let i = 0; i < 7; i++) {
      inserted.push(
        await insert({
          tenantId: tenantA,
          action: "cursor.walk",
          createdAt: new Date(base - i * 1000),
        }),
      );
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await store.list({
        tenantId: tenantA,
        platformAdmin: false,
        limit: 3,
        action: "cursor.walk",
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) seen.add(entry.id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.size).toBe(7);
    for (const id of inserted) expect(seen.has(id)).toBe(true);
  });

  test("filters by action and actor", async () => {
    await ensureTenant(tenantA);
    const kept = await insert({
      tenantId: tenantA,
      action: "network_pool.updated",
      actor: "ops@example.test",
    });
    await insert({ tenantId: tenantA, action: "provider.updated", actor: "ops@example.test" });
    await insert({
      tenantId: tenantA,
      action: "network_pool.updated",
      actor: "other@example.test",
    });

    const byAction = await store.list({
      tenantId: tenantA,
      platformAdmin: false,
      limit: 200,
      action: "network_pool.updated",
    });
    expect(byAction.entries.every((e) => e.action === "network_pool.updated")).toBe(true);

    const byActor = await store.list({
      tenantId: tenantA,
      platformAdmin: false,
      limit: 200,
      actor: "ops@example.test",
    });
    expect(byActor.entries.every((e) => e.actor === "ops@example.test")).toBe(true);

    const both = await store.list({
      tenantId: tenantA,
      platformAdmin: false,
      limit: 200,
      action: "network_pool.updated",
      actor: "ops@example.test",
    });
    expect(both.entries.some((e) => e.id === kept)).toBe(true);
    expect(
      both.entries.every(
        (e) => e.action === "network_pool.updated" && e.actor === "ops@example.test",
      ),
    ).toBe(true);
  });

  test("rejects malformed cursors without leaking rows or throwing", async () => {
    await ensureTenant(tenantA);
    const page = await store.list({
      tenantId: tenantA,
      platformAdmin: false,
      limit: 5,
      cursor: "!!!not-base64!!!",
    });
    // A bad cursor is treated as "no cursor" — never as an error, never as a
    // silent tenant-wide dump of an unrelated tenant.
    for (const entry of page.entries) expect(entry.tenantId).toBe(tenantA);
  });

  test("resolves actor user ids to human names", async () => {
    await ensureTenant(tenantA);
    const userId = randomUUID();
    const username = `audit-reader-${userId.slice(0, 8)}`;
    await db.insert(consoleUsers).values({
      id: userId,
      tenantId: tenantA,
      username,
      email: `${username}@example.test`,
      passwordHash: "test-hash",
      displayName: "Audit Reader",
    });
    const rowId = await insert({ tenantId: tenantA, actor: userId, action: "provider.updated" });

    const page = await store.list({ tenantId: tenantA, platformAdmin: false, limit: 200 });
    const entry = page.entries.find((e) => e.id === rowId);
    expect(entry?.actor).toBe(userId);
    expect(entry?.actorName).toBe("Audit Reader");

    await db.delete(adminAuditLog).where(eq(adminAuditLog.id, rowId));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
  });

  test("actor filter also matches console usernames", async () => {
    await ensureTenant(tenantA);
    const userId = randomUUID();
    const username = `audit-named-${userId.slice(0, 8)}`;
    await db.insert(consoleUsers).values({
      id: userId,
      tenantId: tenantA,
      username,
      passwordHash: "test-hash",
    });
    const rowId = await insert({ tenantId: tenantA, actor: userId, action: "provider.updated" });

    const page = await store.list({
      tenantId: tenantA,
      platformAdmin: false,
      limit: 200,
      actor: username,
    });
    expect(page.entries.some((e) => e.id === rowId)).toBe(true);

    await db.delete(adminAuditLog).where(eq(adminAuditLog.id, rowId));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
  });
});
});

