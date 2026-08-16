import { describe, expect, test, vi } from "vitest";

import { handleHealth, handleLogInsert, handleLogRead } from "../../src/server/routes";
import type { PgPoolHandle } from "../../src/lib/postgres";
import type { LogRow, SqliteLogHandle } from "../../src/lib/sqlite";

function fakePg(queryImpl: () => Promise<unknown>): PgPoolHandle {
  return { query: queryImpl } as unknown as PgPoolHandle;
}

function fakeSqlite(overrides: Partial<SqliteLogHandle> = {}): SqliteLogHandle {
  return {
    insertLog: vi.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    readLogs: vi.fn(() => [] as LogRow[]),
    stats: vi.fn(() => ({
      inUse: 0,
      idle: 1,
      acquireCount: 0,
      releaseCount: 0,
      statementHitCount: 0,
      statementMissCount: 0,
      insertCount: 0,
      vacuumCount: 0,
      residentMemoryBytes: 0,
      max: 10,
      filename: ":memory:",
      lastVacuumAt: null,
      lastVacuumDurationMs: 0,
    })),
    ...overrides,
  } as unknown as SqliteLogHandle;
}

describe("handleHealth", () => {
  test("reports postgres ok when the pool resolves", async () => {
    const pg = fakePg(async () => ({ rows: [] }));
    const sqlite = fakeSqlite();

    const res = await handleHealth(pg, sqlite);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.postgres).toBe("ok");
    expect(body.sqlite.filename).toBe(":memory:");
  });

  test("reports postgres error when the pool rejects, without throwing", async () => {
    const pg = fakePg(async () => {
      throw new Error("connection refused");
    });
    const sqlite = fakeSqlite();

    const res = await handleHealth(pg, sqlite);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.postgres).toBe("error");
  });
});

describe("handleLogInsert", () => {
  test("accepts a valid payload and inserts it", async () => {
    const sqlite = fakeSqlite();

    const res = await handleLogInsert(sqlite, { level: "info", message: "hello" });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.id).toBe(1);
    expect(sqlite.insertLog).toHaveBeenCalledWith({ level: "info", message: "hello" });
  });

  test("rejects an invalid level", async () => {
    const sqlite = fakeSqlite();

    const res = await handleLogInsert(sqlite, { level: "verbose", message: "hello" });

    expect(res.status).toBe(400);
    expect(sqlite.insertLog).not.toHaveBeenCalled();
  });

  test("rejects a missing message", async () => {
    const sqlite = fakeSqlite();

    const res = await handleLogInsert(sqlite, { level: "info" });

    expect(res.status).toBe(400);
    expect(sqlite.insertLog).not.toHaveBeenCalled();
  });
});

describe("handleLogRead", () => {
  test("returns rows from readLogs", async () => {
    const rows: LogRow[] = [
      { id: 1, timestamp: 1, level: "info", provider: null, request_id: null, message: "hi", context: null },
    ];
    const sqlite = fakeSqlite({ readLogs: vi.fn(() => rows) });

    const res = await handleLogRead(sqlite, new URL("http://x/internal/logs"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(rows);
    expect(sqlite.readLogs).toHaveBeenCalledWith(undefined, undefined);
  });

  test("passes limit and level query params through", async () => {
    const sqlite = fakeSqlite();

    await handleLogRead(sqlite, new URL("http://x/internal/logs?level=warn&limit=10"));

    expect(sqlite.readLogs).toHaveBeenCalledWith(10, "warn");
  });

  test("rejects an invalid level query param", async () => {
    const sqlite = fakeSqlite();

    const res = await handleLogRead(sqlite, new URL("http://x/internal/logs?level=verbose"));

    expect(res.status).toBe(400);
    expect(sqlite.readLogs).not.toHaveBeenCalled();
  });
});
