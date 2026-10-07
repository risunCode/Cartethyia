import { describe, expect, test } from "bun:test";
import {
  MAX_LEASE_REAPS_PER_PASS,
  MAX_LEASE_SCAN_ITERATIONS,
  sweepLeases,
} from "../../src/security/admission/lease-sweep";
import type { RedisClient } from "../../src/persistence/redis";

/**
 * The lease sweep used to follow the SCAN cursor until it wrapped and reap
 * every expired lease it found. Both have to be bounded: a keyspace that has
 * grown for months must not turn one 30-second tick into an unbounded pass.
 */

/**
 * A cursor that never wraps, handing back a fixed page of expired leases each
 * call. Against the old loop this runs forever; against the bounded one it
 * stops at the cap.
 */
function neverEndingRedis(pageSize: number): RedisClient & {
  readonly scans: () => number;
  readonly releases: () => number;
} {
  let scans = 0;
  let releases = 0;
  const client = {
    scans: () => scans,
    releases: () => releases,
    scan: async () => {
      scans += 1;
      const keys = Array.from({ length: pageSize }, (_, index) => `admission:lease:${scans}-${index}`);
      return [String(scans), keys] as [string, string[]];
    },
    hget: async (_key: string, field: string) => {
      if (field === "state") return "active";
      // Expired long ago, and a present api_key_id so the release proceeds
      // instead of throwing before it can be counted.
      if (field === "expires_at") return "0";
      return "key-1";
    },
    // `releaseAdmissionLease` ends on an EVAL. Counting it counts releases.
    eval: async () => {
      releases += 1;
      return 1;
    },
  };
  return client as unknown as RedisClient & {
    readonly scans: () => number;
    readonly releases: () => number;
  };
}

describe("sweepLeases — one pass is bounded", () => {
  test("a cursor that never wraps stops at the scan cap", async () => {
    const redis = neverEndingRedis(1);
    await sweepLeases(redis);
    expect(redis.scans()).toBeLessThanOrEqual(MAX_LEASE_SCAN_ITERATIONS);
    expect(redis.scans()).toBeGreaterThan(0);
  });

  test("a page of expired leases stops at the reap cap", async () => {
    const redis = neverEndingRedis(100);
    await sweepLeases(redis);
    expect(redis.releases()).toBeLessThanOrEqual(MAX_LEASE_REAPS_PER_PASS);
    expect(redis.releases()).toBeGreaterThan(0);
  });
});
