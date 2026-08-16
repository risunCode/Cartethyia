import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const connectMock = vi.fn();
const endMock = vi.fn(async () => undefined);
const onMock = vi.fn();

vi.mock("pg", () => {
  class Pool {
    totalCount = 3;
    idleCount = 1;
    waitingCount = 0;
    connect = connectMock;
    end = endMock;
    on = onMock;
  }
  return { Pool };
});

type PostgresModule = typeof import("../../src/lib/postgres");

async function loadPostgres(): Promise<PostgresModule> {
  vi.resetModules();
  return import("../../src/lib/postgres");
}

function fakeClient(overrides: Partial<{ query: ReturnType<typeof vi.fn> }> = {}): {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: overrides.query ?? vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
}

describe("createPgPool", () => {
  beforeEach(() => {
    connectMock.mockReset();
    endMock.mockClear();
    onMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("query() returns rows on the happy path", async () => {
    const { createPgPool } = await loadPostgres();
    const client = fakeClient({ query: vi.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 })) });
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool({ maxRetries: 0 });
    const result = await handle.query("SELECT 1");

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("query() retries on a retryable SQLSTATE then succeeds", async () => {
    const { createPgPool } = await loadPostgres();
    const transientErr = Object.assign(new Error("connection failure"), { code: "08006" });
    const failingClient = fakeClient({ query: vi.fn(async () => { throw transientErr; }) });
    const okClient = fakeClient({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) });
    connectMock.mockResolvedValueOnce(failingClient).mockResolvedValueOnce(okClient);

    const handle = createPgPool({ maxRetries: 1, retryBackoffMillis: 1 });
    const result = await handle.query("SELECT 1");

    expect(result.rows).toEqual([]);
    expect(handle.stats().retryCount).toBe(1);
  });

  test("query() does not retry a non-retryable error", async () => {
    const { createPgPool } = await loadPostgres();
    const fatalErr = Object.assign(new Error("syntax error"), { code: "42601" });
    const client = fakeClient({ query: vi.fn(async () => { throw fatalErr; }) });
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool({ maxRetries: 3 });

    await expect(handle.query("SELECT bogus")).rejects.toThrow("syntax error");
    expect(connectMock).toHaveBeenCalledOnce();
  });

  test("query() rejects with PgResultTooLargeError when rows exceed the cap", async () => {
    const { createPgPool, PgResultTooLargeError } = await loadPostgres();
    const client = fakeClient({
      query: vi.fn(async () => ({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 })),
    });
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool({ maxResultRows: 1, maxRetries: 0 });

    await expect(handle.query("SELECT * FROM huge")).rejects.toBeInstanceOf(PgResultTooLargeError);
  });

  test("withTransaction() commits and returns the handler's result", async () => {
    const { createPgPool } = await loadPostgres();
    const client = fakeClient();
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool();
    const result = await handle.withTransaction(async () => "done");

    expect(result).toBe("done");
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("withTransaction() rolls back and rethrows when the handler throws", async () => {
    const { createPgPool } = await loadPostgres();
    const client = fakeClient();
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool();
    const boom = new Error("handler failed");

    await expect(
      handle.withTransaction(async () => {
        throw boom;
      }),
    ).rejects.toThrow("handler failed");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("close() delegates to pool.end()", async () => {
    const { createPgPool } = await loadPostgres();
    const handle = createPgPool();

    await handle.close();

    expect(endMock).toHaveBeenCalledOnce();
  });

  test("stats() reports pool + telemetry counters", async () => {
    const { createPgPool } = await loadPostgres();
    const client = fakeClient();
    connectMock.mockResolvedValueOnce(client);

    const handle = createPgPool({ maxRetries: 0 });
    await handle.query("SELECT 1");
    const stats = handle.stats();

    expect(stats.totalCount).toBe(3);
    expect(stats.idleCount).toBe(1);
    expect(stats.queryCount).toBe(1);
    expect(stats.releaseCount).toBe(1);
  });
});

describe("getPgPool / closePgPool singleton", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  test("getPgPool() memoizes a single handle across calls", async () => {
    const { getPgPool, __resetPgPoolForTests } = await loadPostgres();
    __resetPgPoolForTests();

    const first = getPgPool();
    const second = getPgPool();

    expect(first).toBe(second);
  });

  test("closePgPool() closes and clears the singleton so the next call rebuilds it", async () => {
    const { getPgPool, closePgPool, __resetPgPoolForTests } = await loadPostgres();
    __resetPgPoolForTests();

    const first = getPgPool();
    await closePgPool();
    const second = getPgPool();

    expect(endMock).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });
});
