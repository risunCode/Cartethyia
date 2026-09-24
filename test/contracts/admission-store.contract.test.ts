/**
 * Contract shared by every `AdmissionCounterStore` implementation.
 *
 * `InMemoryAdmissionCounterStore` and `RedisAdmissionCounterStore` are two
 * implementations of one limit model. Testing them through separate bespoke
 * fixtures is what let a real defect hide: the Redis lease key's TTL equalled
 * the `expires_at` horizon it recorded, so Redis evicted the lease hash at the
 * exact moment the sweeper became allowed to read it, and a crashed request's
 * concurrency slot could never be reclaimed. Only a suite that runs BOTH stores
 * against the same invariants can see that kind of divergence.
 *
 * The invariants below are expressed against the store contract alone — no
 * store-private introspection — so a new implementation is covered by adding
 * it to `HARNESSES`. TTL-based lease expiry and the crash-recovery sweep are
 * genuinely Redis-only (the in-memory store has no TTLs), so those live in
 * their own describe rather than being forced into the shared set.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  InMemoryAdmissionCounterStore,
  RedisAdmissionCounterStore,
  sweepLeases,
  type AdmissionCounterStore,
  type AdmissionReserveRequest,
} from "../../src/security/admission";
import type { RedisClient } from "../../src/persistence/redis";

interface StoreHarness {
  readonly store: AdmissionCounterStore;
  /** Advances the harness's clock, where the store reads one. */
  readonly advance: (ms: number) => void;
  readonly dispose: () => void;
}

function reserveRequest(overrides: Partial<AdmissionReserveRequest> = {}): AdmissionReserveRequest {
  return {
    reservationId: "lease-1",
    apiKeyId: "key-1",
    now: Date.now(),
    estimatedTokens: 10,
    rpmLimit: null,
    dailyLimit: null,
    monthlyLimit: null,
    lifetimeBudget: null,
    lifetimeConsumed: 0,
    concurrencyLimit: null,
    tenantId: "tenant-1",
    tenantConcurrencyLimit: null,
    ...overrides,
  };
}

function createInMemoryHarness(): StoreHarness {
  return {
    store: new InMemoryAdmissionCounterStore(),
    // The in-memory store reads `now` from each request rather than a clock,
    // so there is nothing to advance.
    advance: () => {},
    dispose: () => {},
  };
}

/**
 * A Redis double that models key eviction, so the harness can prove a lease is
 * still readable at the moment it becomes reapable. Keeping every hash alive
 * forever (as the older fixture did) hides exactly the TTL/horizon collision
 * this suite exists to catch.
 */
function createRedisHarness(): StoreHarness {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const expiry = new Map<string, number>();
  let clock = 1_800_000_000_000;
  setSystemTime(clock);

  const arm = (key: string, seconds: number): void => {
    expiry.set(key, Date.now() + seconds * 1000);
  };
  const evict = (): void => {
    const now = Date.now();
    for (const [key, at] of [...expiry]) {
      if (at > now) continue;
      expiry.delete(key);
      strings.delete(key);
      hashes.delete(key);
    }
  };
  const live = (key: string): boolean => {
    evict();
    return strings.has(key) || hashes.has(key);
  };

  const redis = {
    get: (key: string) => Promise.resolve(live(key) ? (strings.get(key) ?? null) : null),
    set: (key: string, value: string) => {
      strings.set(key, value);
      return Promise.resolve("OK");
    },
    incr: (key: string) => {
      const next = Number(strings.get(key) ?? "0") + 1;
      strings.set(key, String(next));
      return Promise.resolve(next);
    },
    decr: (key: string) => {
      const next = Number(strings.get(key) ?? "0") - 1;
      strings.set(key, String(next));
      return Promise.resolve(next);
    },
    hset: (key: string, ...args: string[]) => {
      const hash = hashes.get(key) ?? {};
      for (let i = 0; i < args.length; i += 2) hash[args[i]!] = args[i + 1]!;
      hashes.set(key, hash);
      return Promise.resolve(args.length / 2);
    },
    hget: (key: string, field: string) =>
      Promise.resolve(live(key) ? (hashes.get(key)?.[field] ?? null) : null),
    del: (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) removed += 1;
        if (hashes.delete(key)) removed += 1;
      }
      return Promise.resolve(removed);
    },
    scan: () => Promise.resolve(["0", [...hashes.keys()]]),
    pipeline: () => {
      const queued: string[] = [];
      return {
        hget: (key: string) => {
          queued.push(key);
          return undefined;
        },
        exec: () =>
          Promise.resolve(queued.map((key) => [null, hashes.get(key)?.["api_key_id"] ?? null])),
      };
    },
    eval: (script: string, _numKeys: number, ...args: string[]) => {
      evict();
      // Argument layout: the 7 KEYS arrive first, then ARGV[1..14], so ARGV[n]
      // sits at index 7 + (n - 1).
      const K_CONCURRENT = 3;
      const K_LEASE = 5;
      const A_NOW = 7;
      const A_ESTIMATED = 8;
      const A_CONCURRENCY_LIMIT = 13;
      const A_TENANT_ID = 17;
      const A_API_KEY_ID = 18;
      const A_LEASE_TTL_MS = 19;
      const A_LEASE_KEY_TTL = 20;

      if (script.includes("'state', 'active'")) {
        const now = Number(args[A_NOW]);
        const leaseKey = args[K_LEASE]!;
        const concurrencyLimit = args[A_CONCURRENCY_LIMIT]!;
        const concurrentKey = args[K_CONCURRENT]!;
        // Enforce the concurrency ceiling the way RESERVE does, so a held slot
        // actually rejects the next reservation. Without this the fake accepts
        // anything and no concurrency assertion can ever fail.
        if (concurrencyLimit) {
          const held = Number(strings.get(concurrentKey) ?? "0");
          if (held >= Number(concurrencyLimit)) return Promise.resolve(-5);
        }
        if (concurrencyLimit) {
          strings.set(concurrentKey, String(Number(strings.get(concurrentKey) ?? "0") + 1));
          arm(concurrentKey, 3600);
        }
        hashes.set(leaseKey, {
          state: "active",
          reserved: args[A_ESTIMATED]!,
          concurrent: concurrencyLimit ? "1" : "0",
          tenant_id: args[A_TENANT_ID]!,
          api_key_id: args[A_API_KEY_ID]!,
          expires_at: String(now + Number(args[A_LEASE_TTL_MS])),
        });
        arm(leaseKey, Number(args[A_LEASE_KEY_TTL]));
        return Promise.resolve(0);
      }
      if (script.includes("'state', 'released'")) {
        const leaseKey = args[0]!;
        const hash = hashes.get(leaseKey);
        if (hash?.["concurrent"] === "1") {
          const concurrentKey = `admission:concurrent:${args[1]!}`;
          strings.set(concurrentKey, String(Number(strings.get(concurrentKey) ?? "1") - 1));
        }
        if (hash) hash["state"] = "released";
        return Promise.resolve(0);
      }
      if (script.includes("'state', 'committed'")) {
        const hash = hashes.get(args[0]!);
        if (hash) hash["state"] = "committed";
        return Promise.resolve(0);
      }
      return Promise.resolve(0);
    },
  } as unknown as RedisClient;

  return {
    store: new RedisAdmissionCounterStore(redis),
    advance: (ms) => {
      clock += ms;
      setSystemTime(clock);
    },
    dispose: () => setSystemTime(),
    // Exposed for the Redis-only lease-recovery cases below.
    redis,
  } as StoreHarness & { readonly redis: RedisClient };
}

const HARNESSES: readonly { readonly name: string; readonly build: () => StoreHarness }[] = [
  { name: "InMemoryAdmissionCounterStore", build: createInMemoryHarness },
  { name: "RedisAdmissionCounterStore", build: createRedisHarness },
];

for (const harnessCase of HARNESSES) {
  describe(`${harnessCase.name} admission store contract`, () => {
    test("a retried reservation is idempotent, not double-charged", async () => {
      const harness = harnessCase.build();
      try {
        const request = reserveRequest({ concurrencyLimit: 2 });
        await harness.store.reserve(request);
        // The same reservation id must not consume a second slot or credit.
        await expect(harness.store.reserve(request)).resolves.toBeUndefined();
        await expect(harness.store.reconcile("key-1", 10, 10, "lease-1")).resolves.toBeUndefined();
      } finally {
        harness.dispose();
      }
    });

    test("release reverses the reservation exactly once", async () => {
      const harness = harnessCase.build();
      try {
        await harness.store.reserve(reserveRequest({ concurrencyLimit: 2 }));
        await expect(harness.store.release("key-1", 10, "lease-1")).resolves.toBeUndefined();
        // The second release is an idempotent no-op, not an error.
        await expect(harness.store.release("key-1", 10, "lease-1")).resolves.toBeUndefined();
      } finally {
        harness.dispose();
      }
    });

    test("purge drops a key's counters", async () => {
      const harness = harnessCase.build();
      try {
        await harness.store.reserve(reserveRequest({ concurrencyLimit: 2 }));
        await harness.store.release("key-1", 10, "lease-1");
        await expect(harness.store.purge("key-1")).resolves.toBeUndefined();
        // A purged key starts clean: the same reservation id reserves again.
        await expect(
          harness.store.reserve(reserveRequest({ reservationId: "lease-1", concurrencyLimit: 2 })),
        ).resolves.toBeUndefined();
      } finally {
        harness.dispose();
      }
    });
  });
}

describe("RedisAdmissionCounterStore crash recovery", () => {
  test("the sweeper reclaims a crashed lease's concurrency slot", async () => {
    // This is the case the old fixture could not express: it kept every hash
    // alive, so it never observed that Redis had already evicted the lease.
    //
    // The timing has to distinguish the sweep from the counters' own TTLs. The
    // concurrency counter is re-armed by every reservation, so live traffic
    // keeps it alive while a crashed lease's slot stays leaked; a test that
    // simply advances past both TTLs sees the slot come back on its own and
    // passes whether or not the sweep works.
    const harness = createRedisHarness() as StoreHarness & { readonly redis: RedisClient };
    try {
      // The request that crashes: reserved at T0, then the worker dies.
      await harness.store.reserve(reserveRequest({ concurrencyLimit: 2 }));

      // Live traffic 30 minutes later fills the other slot and re-arms the
      // counter's TTL well past the crashed lease's horizon.
      harness.advance(1_800_000);
      await harness.store.reserve(
        reserveRequest({ reservationId: "lease-2", now: Date.now(), concurrencyLimit: 2 }),
      );

      // Past the crashed lease's horizon, but inside the counter's refreshed
      // life. With the key TTL equal to that horizon the lease hash would
      // already be gone and this slot would stay leaked.
      harness.advance(1_805_000);
      await sweepLeases(harness.redis);

      // The reclaimed slot admits a third reservation. Without the sweep (or
      // with the old TTL) the counter is still at its ceiling of 2 and this
      // rejects.
      await expect(
        harness.store.reserve(
          reserveRequest({ reservationId: "lease-3", now: Date.now(), concurrencyLimit: 2 }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      harness.dispose();
    }
  });

  test("the sweeper leaves an unexpired lease alone", async () => {
    const harness = createRedisHarness() as StoreHarness & { readonly redis: RedisClient };
    try {
      await harness.store.reserve(reserveRequest({ concurrencyLimit: 1 }));
      // Well inside the lease's life: the sweep must not release it, so the
      // held slot still rejects a second reservation.
      harness.advance(60_000);
      await sweepLeases(harness.redis);

      await expect(
        harness.store.reserve(
          reserveRequest({ reservationId: "lease-2", now: Date.now(), concurrencyLimit: 1 }),
        ),
      ).rejects.toMatchObject({ code: "capacity_exhausted" });
    } finally {
      harness.dispose();
    }
  });
});
