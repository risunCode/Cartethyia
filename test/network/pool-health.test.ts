/**
 * Network-pool dispatch health: which outcomes park a pool, and which do not.
 *
 * A pool is an operator's egress proxy. When it cannot carry traffic the pool
 * must leave rotation — otherwise every request keeps routing through a proxy
 * that fails, and the failure is attributed to the provider instead. This
 * module owns that decision, and it was, measured before this file existed,
 * entirely uncovered: nothing asserted that a network failure parks a pool, nor
 * that an upstream's own error does *not*.
 *
 * That distinction is the whole point of the classifier. A pool is blamed only
 * for failures produced at the proxy/network boundary; an upstream that
 * answered `500` answered through a working pool, and parking the pool for it
 * would take a healthy egress route out of service. So the tests below are
 * organised around that line rather than around the happy path.
 *
 * The suite that motivated this file: `handleProviderProxyRequest`'s stream
 * error path built its completion context by hand and omitted `networkPoolId`,
 * so a pool that failed a *stream* was never parked. The recording function was
 * correct; nothing proved it was reached. These tests pin the function, and the
 * gateway-level tests in `streaming-contract.test.ts` pin that the field
 * reaches it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/persistence/postgres";
import { networkPools } from "../../src/persistence/schema";
import { recordPoolDispatchOutcome } from "../../src/network/pool-health-machine";
import { getTestPool, dbDescribe } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

/** A pool row an outcome can be recorded against. */
interface PoolFixture {
  readonly id: string;
  readonly cleanup: () => Promise<void>;
}

async function createPool(world: GatewayWorld): Promise<PoolFixture> {
  const pool = await getTestPool();
  const client = await pool.connect();
  const id = crypto.randomUUID();
  try {
    // `endpoint_config` is the pool's transport descriptor; the recorder never
    // reads it, so the minimal valid shape is enough to satisfy the column.
    await client.query(
      `insert into network_pools
         (id, tenant_id, kind, endpoint_config, status, consecutive_failures, weight, max_inflight, created_at)
       values ($1, $2, 'http', $3::jsonb, 'active', 0, 100, 10, now())`,
      [id, world.tenantId, JSON.stringify({ url: "http://127.0.0.1:1" })],
    );
  } finally {
    client.release();
  }
  return {
    id,
    cleanup: async () => {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query("delete from network_pools where id = $1", [id]);
      } finally {
        cleanupClient.release();
      }
    },
  };
}

/** The pool row as stored, or undefined when the fixture was removed. */
async function readPool(id: string) {
  const rows = await getDb().select().from(networkPools).where(eq(networkPools.id, id)).limit(1);
  return rows[0];
}

dbDescribe("network pool dispatch health", () => {
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  describe("a failure at the network boundary parks the pool", () => {
    test("a network-origin error moves the pool to cooldown", async () => {
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: new Error("connect ECONNREFUSED 127.0.0.1:8080"),
          errorOrigin: "network",
        });
        const row = await readPool(pool.id);
        expect(row?.status).toBe("cooldown");
        expect(row?.consecutiveFailures).toBe(1);
        expect(row?.lastErrorCategory).toBe("proxy_unreachable");
        expect(row?.cooldownUntil).not.toBeNull();
      } finally {
        await pool.cleanup();
      }
    });

    test("a typed proxy fault code is recorded as its own category", async () => {
      // A tunnel that could not be set up is not the same fault as an
      // unreachable proxy, and the console surfaces the category.
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: Object.assign(new Error("tunnel setup failed"), { code: "tunnel_setup_failed" }),
          errorOrigin: "network",
        });
        expect((await readPool(pool.id))?.lastErrorCategory).toBe("tunnel_setup_failed");
      } finally {
        await pool.cleanup();
      }
    });

    test("a gateway error whose code is a transport fault parks the pool", async () => {
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: Object.assign(new Error("transport closed"), { code: "transport_unavailable" }),
        });
        expect((await readPool(pool.id))?.status).toBe("cooldown");
      } finally {
        await pool.cleanup();
      }
    });
  });

  describe("an upstream's own failure leaves the pool alone", () => {
    test("an upstream-origin error does not park the pool", async () => {
      // The pool carried the request successfully; the provider answered with
      // an error. Taking the pool out of rotation would remove a working egress
      // route because a provider was broken.
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: new Error("upstream returned 500"),
          errorOrigin: "upstream",
        });
        const row = await readPool(pool.id);
        expect(row?.status).toBe("active");
        expect(row?.consecutiveFailures).toBe(0);
        expect(row?.lastErrorCategory).toBeNull();
      } finally {
        await pool.cleanup();
      }
    });

    test("an unclassified failure with no origin does not park the pool", async () => {
      // No evidence that the network was at fault means no evidence for
      // parking a pool an operator may depend on.
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: new Error("something went wrong"),
        });
        expect((await readPool(pool.id))?.status).toBe("active");
      } finally {
        await pool.cleanup();
      }
    });
  });

  describe("a success restores the pool", () => {
    test("a success resets the failure count and returns the pool to active", async () => {
      const pool = await createPool(world);
      try {
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: new Error("connect ECONNREFUSED"),
          errorOrigin: "network",
        });
        expect((await readPool(pool.id))?.status).toBe("cooldown");

        await recordPoolDispatchOutcome(getDb(), pool.id, { succeeded: true });
        const row = await readPool(pool.id);
        expect(row?.status).toBe("active");
        expect(row?.consecutiveFailures).toBe(0);
        expect(row?.cooldownUntil).toBeNull();
        expect(row?.lastError).toBeNull();
        expect(row?.lastErrorCategory).toBeNull();
        expect(row?.lastSuccessAt).not.toBeNull();
      } finally {
        await pool.cleanup();
      }
    });
  });

  describe("a disabled pool is never touched", () => {
    test("an outcome against a disabled pool changes nothing", async () => {
      // `disabled` is an operator decision; an automatic failure must not
      // silently re-enable it, and a success must not either.
      const pool = await createPool(world);
      try {
        const pgPool = await getTestPool();
        const client = await pgPool.connect();
        try {
          await client.query("update network_pools set status = 'disabled' where id = $1", [pool.id]);
        } finally {
          client.release();
        }
        await recordPoolDispatchOutcome(getDb(), pool.id, {
          succeeded: false,
          error: new Error("connect ECONNREFUSED"),
          errorOrigin: "network",
        });
        expect((await readPool(pool.id))?.status).toBe("disabled");
        expect((await readPool(pool.id))?.consecutiveFailures).toBe(0);

        await recordPoolDispatchOutcome(getDb(), pool.id, { succeeded: true });
        expect((await readPool(pool.id))?.status).toBe("disabled");
      } finally {
        await pool.cleanup();
      }
    });
  });

  describe("an unknown pool is not an error", () => {
    test("recording against a pool that no longer exists is a no-op", async () => {
      // The pool may have been deleted between dispatch and finalize; the
      // recorder must not throw into the completion path for that.
      const absent = crypto.randomUUID();
      await recordPoolDispatchOutcome(getDb(), absent, {
        succeeded: false,
        error: new Error("connect ECONNREFUSED"),
        errorOrigin: "network",
      });
      expect(await readPool(absent)).toBeUndefined();
    });
  });
});
