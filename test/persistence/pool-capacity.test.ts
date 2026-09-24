/**
 * Pool capacity against the server's own connection ceiling.
 *
 * The gateway runs several processes behind `reusePort`, and each opens its own
 * pool of `DATABASE_POOL_MAX` connections. Nothing in one process can see its
 * siblings, so a pool sized for a single process silently becomes a
 * connect-refused failure at the server's `max_connections` once a second
 * process starts. These tests pin the check that makes that arithmetic visible
 * at boot instead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { GatewayError } from "../../src/transport/gateway-error";
import {
  assertPoolFitsServerCapacity,
  closeDb,
  setPoolForTesting,
} from "../../src/persistence/postgres";

function poolReporting(maxConnections: string | null, options: { readonly throws?: boolean } = {}): Pool {
  return {
    query: async () => {
      if (options.throws) throw new Error("permission denied for SHOW");
      return { rows: maxConnections === null ? [] : [{ max_connections: maxConnections }] };
    },
    end: async () => undefined,
  } as unknown as Pool;
}

afterEach(() => {
  void closeDb();
});

describe("assertPoolFitsServerCapacity", () => {
  test("accepts a pool that leaves room for several processes", async () => {
    setPoolForTesting(poolReporting("100"));
    // 100 / 20 = 5 processes, which is the designed multi-process shape.
    await expect(assertPoolFitsServerCapacity(20)).resolves.toBeUndefined();
  });

  test("accepts a single-process deployment but warns", async () => {
    setPoolForTesting(poolReporting("100"));
    // 100 / 60 = 1 process: legitimate, but the operator should know a second
    // one would exhaust the budget. Not an error.
    await expect(assertPoolFitsServerCapacity(60)).resolves.toBeUndefined();
  });

  test("rejects a pool that alone meets the server ceiling", async () => {
    setPoolForTesting(poolReporting("100"));
    // This is the failure that motivated the check: a pool of 100 per process
    // means even ONE process cannot fill it, and the 101st connection is
    // refused by the server with an error the operator never sees in config.
    await expect(assertPoolFitsServerCapacity(100)).rejects.toMatchObject({
      code: "max_connections_exceeded",
    } as unknown as GatewayError);
  });

  test("rejects a pool above the server ceiling", async () => {
    setPoolForTesting(poolReporting("50"));
    await expect(assertPoolFitsServerCapacity(60)).rejects.toMatchObject({
      code: "max_connections_exceeded",
    } as unknown as GatewayError);
  });

  test("reports the ceiling in the error so the operator can act", async () => {
    setPoolForTesting(poolReporting("80"));
    let caught: unknown;
    try {
      await assertPoolFitsServerCapacity(80);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    const details = (caught as GatewayError).details;
    expect(details).toMatchObject({ pool_max: 80, max_connections: 80 });
  });

  test("does not block boot when the server refuses to report its ceiling", async () => {
    // A restricted role cannot run SHOW; capacity is a diagnostic, so the
    // gateway must still serve.
    setPoolForTesting(poolReporting(null, { throws: true }));
    await expect(assertPoolFitsServerCapacity(20)).resolves.toBeUndefined();
  });

  test("ignores a non-numeric ceiling", async () => {
    setPoolForTesting(poolReporting("unlimited"));
    await expect(assertPoolFitsServerCapacity(20)).resolves.toBeUndefined();
  });
});
