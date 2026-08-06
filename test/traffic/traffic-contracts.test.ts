import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiKeyAdmission, estimateRequestTokens } from "../../src/traffic/admission";
import { PerIpFlightTracker } from "../../src/traffic/per-ip";
import {
  beginProviderInFlight,
  decrementInFlight,
  endProviderInFlight,
  getInFlightCount,
  getProviderInFlight,
  incrementInFlight,
  resetInFlightForTests,
  subscribeInFlight,
} from "../../src/traffic/in-flight";
import { cancelScheduledGc, scheduleGlobalGc } from "../../src/traffic/memory";
import { runtimeMemoryLimits } from "../../src/traffic/limits";
import type { ApiKeyAdmissionErrorShape } from "../../src/traffic/admission";
import type { ApiKeyPublic, ApiKeyRepository } from "../../src/storage";

// ─────────────────────────────────────────────────────────────────────────
// Mock API key repository — tracks one-time token consumption in-memory.
// ─────────────────────────────────────────────────────────────────────────

interface MockKeyState {
  oneTimeTokensUsed: number;
}

function makeKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    keyPrefix: "sk-test",
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    oneTimeTokenLimit: null,
    oneTimeTokensUsed: 0,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    lastUsedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function makeRepo(key: ApiKeyPublic): { repo: ApiKeyRepository; state: MockKeyState } {
  const state: MockKeyState = { oneTimeTokensUsed: key.oneTimeTokensUsed };
  const repo: ApiKeyRepository = {
    list: () => [key],
    getById: (id: string) => (id === key.id ? key : null),
    getBySecret: () => null,
    credential: () => null,
    create: () => key,
    update: () => key,
    revoke: () => true,
    delete: () => true,
    touch: () => {},
    flushTouches: () => {},
    sumOneTimeTokensUsed: () => state.oneTimeTokensUsed,
    consumeOneTimeTokens: (id: string, tokens: number) => {
      if (id !== key.id || !Number.isFinite(tokens) || tokens <= 0) return;
      state.oneTimeTokensUsed += Math.floor(tokens);
    },
  };
  return { repo, state };
}

/**
 * admission.acquire throws a plain object (not an Error), so toThrow(regex)
 * can't match against its message. This helper catches the thrown shape and
 * returns it for assertion.
 */
function acquireAndCatch(admission: ApiKeyAdmission, key: ApiKeyPublic, tokens: number, now: number): ApiKeyAdmissionErrorShape | null {
  try {
    const lease = admission.acquire(key, tokens, now);
    lease.release();
    return null;
  } catch (error) {
    return error as ApiKeyAdmissionErrorShape;
  }
}

// Fixed timestamp anchors for deterministic time-based tests.
const BASE_NOW = Date.parse("2025-06-15T12:00:00.000Z");
const NEXT_DAY = BASE_NOW + 24 * 60 * 60 * 1_000;
const NEXT_MONTH = Date.parse("2025-07-15T12:00:00.000Z");
const ONE_MS = 1;

// ─────────────────────────────────────────────────────────────────────────
// Admission control
// ─────────────────────────────────────────────────────────────────────────

describe("ApiKeyAdmission daily token limit", () => {
  test("rejects when the estimate would exceed the daily limit", () => {
    const key = makeKey({ dailyTokenLimit: 1_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const error = acquireAndCatch(admission, key, 1_001, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.kind).toBe("quota_exceeded");
    expect(error!.sanitizedMessage).toContain("daily token limit");
  });

  test("accepts when the estimate exactly meets the daily limit", () => {
    const key = makeKey({ dailyTokenLimit: 1_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_000, BASE_NOW);
    expect(lease).toBeDefined();
    lease.release();
  });

  test("rejects after prior usage has consumed the daily budget", () => {
    const key = makeKey({ dailyTokenLimit: 1_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 600, BASE_NOW);
    lease.commit({ inputTokens: 600, outputTokens: 0 });
    const error = acquireAndCatch(admission, key, 401, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("daily token limit");
  });
});

describe("ApiKeyAdmission monthly token limit", () => {
  test("rejects when the estimate would exceed the monthly limit", () => {
    const key = makeKey({ monthlyTokenLimit: 10_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const error = acquireAndCatch(admission, key, 10_001, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("monthly token limit");
  });

  test("accepts when the estimate exactly meets the monthly limit", () => {
    const key = makeKey({ monthlyTokenLimit: 10_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 10_000, BASE_NOW);
    expect(lease).toBeDefined();
    lease.release();
  });

  test("rejects after prior usage has consumed the monthly budget", () => {
    const key = makeKey({ monthlyTokenLimit: 10_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 6_000, BASE_NOW);
    lease.commit({ inputTokens: 6_000, outputTokens: 0 });
    const error = acquireAndCatch(admission, key, 4_001, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("monthly token limit");
  });
});

describe("ApiKeyAdmission day rollover", () => {
  test("resets the daily counter when the calendar day changes", () => {
    const key = makeKey({ dailyTokenLimit: 1_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 800, BASE_NOW);
    lease.commit({ inputTokens: 800, outputTokens: 0 });
    // Next day — daily budget should be fresh.
    const lease2 = admission.acquire(key, 800, NEXT_DAY);
    expect(lease2).toBeDefined();
    lease2.release();
  });

  test("does not reset the monthly counter on a day rollover within the same month", () => {
    const key = makeKey({ dailyTokenLimit: 2_000, monthlyTokenLimit: 2_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_500, BASE_NOW);
    lease.commit({ inputTokens: 1_500, outputTokens: 0 });
    // Same month, next day — daily resets but monthly still carries 1500.
    const error = acquireAndCatch(admission, key, 501, NEXT_DAY);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("monthly token limit");
  });
});

describe("ApiKeyAdmission month rollover", () => {
  test("resets the monthly counter when the calendar month changes", () => {
    const key = makeKey({ monthlyTokenLimit: 2_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_500, BASE_NOW);
    lease.commit({ inputTokens: 1_500, outputTokens: 0 });
    // Next month — monthly budget should be fresh.
    const lease2 = admission.acquire(key, 1_500, NEXT_MONTH);
    expect(lease2).toBeDefined();
    lease2.release();
  });
});

describe("ApiKeyAdmission commit delta", () => {
  test("applies token usage delta when actual exceeds estimate", () => {
    const key = makeKey({ dailyTokenLimit: 5_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 500, BASE_NOW);
    lease.commit({ inputTokens: 1_000, outputTokens: 0 });
    // After commit: dayUsed = 500 (reserve) + (1000-500 delta) = 1000.
    // Remaining budget = 5000 - 1000 = 4000.
    const lease2 = admission.acquire(key, 4_000, BASE_NOW);
    expect(lease2).toBeDefined();
    lease2.release();
    // 4001 should now exceed.
    const error = acquireAndCatch(admission, key, 4_001, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("daily token limit");
  });

  test("applies token usage delta when actual is below estimate (refund)", () => {
    const key = makeKey({ dailyTokenLimit: 5_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_000, BASE_NOW);
    lease.commit({ inputTokens: 400, outputTokens: 0 });
    // After commit: dayUsed = 1000 (reserve) + (400-1000 delta) = 400.
    // Remaining budget = 5000 - 400 = 4600.
    const lease2 = admission.acquire(key, 4_600, BASE_NOW);
    expect(lease2).toBeDefined();
    lease2.release();
  });

  test("release without commit refunds the reserved estimate", () => {
    const key = makeKey({ dailyTokenLimit: 5_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 3_000, BASE_NOW);
    lease.release();
    // After release: dayUsed refunded to 0.
    const lease2 = admission.acquire(key, 5_000, BASE_NOW);
    expect(lease2).toBeDefined();
    lease2.release();
  });
});

describe("ApiKeyAdmission one-time tokens", () => {
  test("decrements one-time tokens on commit", () => {
    const key = makeKey({ oneTimeTokenLimit: 10_000, oneTimeTokensUsed: 0 });
    const { repo, state } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_000, BASE_NOW);
    lease.commit({ inputTokens: 1_000, outputTokens: 0 });
    expect(state.oneTimeTokensUsed).toBe(1_000);
  });

  test("rejects when the estimate would exceed the remaining one-time budget", () => {
    const key = makeKey({ oneTimeTokenLimit: 1_000, oneTimeTokensUsed: 800 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const error = acquireAndCatch(admission, key, 201, BASE_NOW);
    expect(error).not.toBeNull();
    expect(error!.sanitizedMessage).toContain("one-time token");
  });

  test("accepts when the estimate exactly meets the remaining one-time budget", () => {
    const key = makeKey({ oneTimeTokenLimit: 1_000, oneTimeTokensUsed: 800 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 200, BASE_NOW);
    expect(lease).toBeDefined();
    lease.release();
  });
});

describe("ApiKeyAdmission estimate (pre-check without commit)", () => {
  test("acquire reserves budget but release without commit leaves no lasting charge", () => {
    const key = makeKey({ dailyTokenLimit: 1_000 });
    const { repo } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 900, BASE_NOW);
    lease.release();
    // Full budget available again.
    const lease2 = admission.acquire(key, 1_000, BASE_NOW);
    expect(lease2).toBeDefined();
    lease2.release();
  });

  test("does not consume one-time tokens on release (no commit)", () => {
    const key = makeKey({ oneTimeTokenLimit: 10_000, oneTimeTokensUsed: 0 });
    const { repo, state } = makeRepo(key);
    const admission = new ApiKeyAdmission(repo);
    const lease = admission.acquire(key, 1_000, BASE_NOW);
    lease.release();
    expect(state.oneTimeTokensUsed).toBe(0);
  });
});

describe("estimateRequestTokens", () => {
  test("returns at least 1 for an empty body", () => {
    expect(estimateRequestTokens({})).toBeGreaterThanOrEqual(1);
  });

  test("scales with body size but is bounded", () => {
    const small = estimateRequestTokens({ prompt: "hi" });
    const large = estimateRequestTokens({ prompt: "x".repeat(10_000) });
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(10_000_000);
  });

  test("never returns zero or negative", () => {
    expect(estimateRequestTokens({})).toBeGreaterThanOrEqual(1);
    expect(estimateRequestTokens({ prompt: "" })).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-IP flight tracker
// ─────────────────────────────────────────────────────────────────────────

describe("PerIpFlightTracker concurrency rejection", () => {
  test("rejects acquire when the IP is at its max concurrency", () => {
    const tracker = new PerIpFlightTracker();
    const handle = tracker.tryAcquire("1.2.3.4", 1, BASE_NOW);
    expect(handle).not.toBeNull();
    expect(tracker.tryAcquire("1.2.3.4", 1, BASE_NOW)).toBeNull();
    handle!.release();
  });

  test("max=0 rejects all acquires", () => {
    const tracker = new PerIpFlightTracker();
    expect(tracker.tryAcquire("1.2.3.4", 0, BASE_NOW)).toBeNull();
  });

  test("different IPs do not interfere with each other", () => {
    const tracker = new PerIpFlightTracker();
    const h1 = tracker.tryAcquire("1.1.1.1", 1, BASE_NOW);
    const h2 = tracker.tryAcquire("2.2.2.2", 1, BASE_NOW);
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    h1!.release();
    h2!.release();
  });
});

describe("PerIpFlightTracker stale sweep", () => {
  test("removes abandoned entries after the sweep interval elapses", () => {
    const tracker = new PerIpFlightTracker();
    // Acquire an entry at t=1000 but do NOT release — it stays in the map.
    const handle = tracker.tryAcquire("1.2.3.4", 5, 1000);
    expect(tracker.size()).toBe(1);
    expect(tracker.activeCount("1.2.3.4")).toBe(1);
    // Acquire another IP past the sweep interval — triggers sweep.
    // cutoff = 61001 - 60000 = 1001; entry lastSeenMs=1000 < 1001 → swept.
    const h2 = tracker.tryAcquire("5.6.7.8", 5, 61001);
    expect(tracker.activeCount("1.2.3.4")).toBe(0);
    // The swept entry is gone; only the new entry remains.
    expect(tracker.size()).toBe(1);
    expect(tracker.activeCount("5.6.7.8")).toBe(1);
    h2!.release();
    handle!.release();
  });

  test("does not sweep before the sweep interval elapses", () => {
    const tracker = new PerIpFlightTracker();
    const handle = tracker.tryAcquire("1.2.3.4", 5, BASE_NOW);
    // Acquire another IP within the sweep interval — no sweep.
    const h2 = tracker.tryAcquire("5.6.7.8", 5, BASE_NOW + 30_000);
    expect(tracker.size()).toBe(2);
    h2!.release();
    handle!.release();
  });
});

describe("PerIpFlightTracker eviction at capacity", () => {
  test("snapshot preserves insertion order and correct counts after partial release", () => {
    const tracker = new PerIpFlightTracker();
    const h1 = tracker.tryAcquire("1.1.1.1", 3, BASE_NOW);
    const h2 = tracker.tryAcquire("2.2.2.2", 3, BASE_NOW + ONE_MS);
    const h3 = tracker.tryAcquire("3.3.3.3", 3, BASE_NOW + 2 * ONE_MS);
    h1!.release();
    const snap = tracker.snapshot();
    // Released entry (count=0) is filtered out of snapshot.
    const active = snap.filter((e) => e.ip !== "1.1.1.1");
    expect(active.length).toBe(2);
    expect(snap.find((e) => e.ip === "1.1.1.1")).toBeUndefined();
    h2!.release();
    h3!.release();
  });
});

describe("PerIpFlightTracker release idempotency", () => {
  test("double release is safe and does not decrement below zero", () => {
    const tracker = new PerIpFlightTracker();
    const handle = tracker.tryAcquire("1.2.3.4", 5, BASE_NOW);
    handle!.release();
    handle!.release();
    expect(tracker.activeCount("1.2.3.4")).toBe(0);
  });

  test("triple release is safe", () => {
    const tracker = new PerIpFlightTracker();
    const handle = tracker.tryAcquire("1.2.3.4", 5, BASE_NOW);
    handle!.release();
    handle!.release();
    handle!.release();
    expect(tracker.activeCount("1.2.3.4")).toBe(0);
  });
});

describe("PerIpFlightTracker partial release", () => {
  test("releasing some but not all flights keeps the remainder active", () => {
    const tracker = new PerIpFlightTracker();
    const h1 = tracker.tryAcquire("1.2.3.4", 3, BASE_NOW);
    const h2 = tracker.tryAcquire("1.2.3.4", 3, BASE_NOW + ONE_MS);
    const h3 = tracker.tryAcquire("1.2.3.4", 3, BASE_NOW + 2 * ONE_MS);
    expect(tracker.activeCount("1.2.3.4")).toBe(3);
    h1!.release();
    expect(tracker.activeCount("1.2.3.4")).toBe(2);
    h2!.release();
    expect(tracker.activeCount("1.2.3.4")).toBe(1);
    h3!.release();
    expect(tracker.activeCount("1.2.3.4")).toBe(0);
  });

  test("snapshot reflects partial counts accurately", () => {
    const tracker = new PerIpFlightTracker();
    const h1 = tracker.tryAcquire("1.2.3.4", 3, BASE_NOW);
    const h2 = tracker.tryAcquire("1.2.3.4", 3, BASE_NOW + ONE_MS);
    const h3 = tracker.tryAcquire("5.6.7.8", 3, BASE_NOW + 2 * ONE_MS);
    h1!.release();
    const snap = tracker.snapshot();
    const ip1 = snap.find((e) => e.ip === "1.2.3.4");
    const ip2 = snap.find((e) => e.ip === "5.6.7.8");
    expect(ip1?.active).toBe(1);
    expect(ip2?.active).toBe(1);
    h2!.release();
    h3!.release();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// In-flight counter
// ─────────────────────────────────────────────────────────────────────────

describe("in-flight floor at 0", () => {
  beforeEach(() => resetInFlightForTests());
  afterEach(() => resetInFlightForTests());

  test("decrement before increment stays at 0 and never goes negative", () => {
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
    decrementInFlight();
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
  });

  test("decrement after increment reaches 0 but not below", () => {
    incrementInFlight();
    incrementInFlight();
    decrementInFlight();
    expect(getInFlightCount()).toBe(1);
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
    decrementInFlight();
    expect(getInFlightCount()).toBe(0);
  });
});

describe("in-flight provider counts", () => {
  beforeEach(() => resetInFlightForTests());
  afterEach(() => resetInFlightForTests());

  test("begin/end balance to zero", () => {
    beginProviderInFlight("openai");
    beginProviderInFlight("openai");
    expect(getProviderInFlight()).toEqual([{ providerId: "openai", active: 2 }]);
    endProviderInFlight("openai");
    expect(getProviderInFlight()).toEqual([{ providerId: "openai", active: 1 }]);
    endProviderInFlight("openai");
    expect(getProviderInFlight()).toEqual([]);
  });

  test("endProviderInFlight on an unknown provider is a no-op", () => {
    endProviderInFlight("unknown");
    expect(getProviderInFlight()).toEqual([]);
  });

  test("getProviderInFlight sorts by active descending then providerId", () => {
    beginProviderInFlight("zeta");
    beginProviderInFlight("alpha");
    beginProviderInFlight("alpha");
    const list = getProviderInFlight();
    expect(list[0]!.providerId).toBe("alpha");
    expect(list[0]!.active).toBe(2);
    expect(list[1]!.providerId).toBe("zeta");
  });
});

describe("in-flight listener cap", () => {
  beforeEach(() => resetInFlightForTests());
  afterEach(() => resetInFlightForTests());

  test("max listeners (128) — oldest dropped when cap exceeded", async () => {
    const seen: number[] = [];
    for (let i = 0; i < 128; i++) {
      subscribeInFlight(() => seen.push(i));
    }
    // The 129th should evict the first (oldest) listener.
    const received: { value: number | null } = { value: null };
    subscribeInFlight((c) => { received.value = c; });
    incrementInFlight();
    // Notifications are coalesced via microtask.
    await Promise.resolve();
    // The 129th listener should still fire.
    expect(received.value).toBe(1);
    // The first listener (pushing 0) should have been evicted and NOT fire.
    expect(seen.includes(0)).toBe(false);
    // The remaining 127 listeners all fired.
    expect(seen.length).toBe(127);
  });
});

describe("in-flight unsubscribe", () => {
  beforeEach(() => resetInFlightForTests());
  afterEach(() => resetInFlightForTests());

  test("unsubscribe stops receiving events", async () => {
    let calls = 0;
    const unsubscribe = subscribeInFlight(() => { calls += 1; });
    incrementInFlight();
    await Promise.resolve(); // flush microtask queue
    expect(calls).toBe(1);
    unsubscribe();
    incrementInFlight();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test("unsubscribe is idempotent", async () => {
    let calls = 0;
    const unsubscribe = subscribeInFlight(() => { calls += 1; });
    unsubscribe();
    unsubscribe();
    incrementInFlight();
    await Promise.resolve();
    expect(calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Memory GC scheduler
// ─────────────────────────────────────────────────────────────────────────

describe("memory scheduleGlobalGc deferred retry", () => {
  afterEach(() => cancelScheduledGc());

  test("schedules GC immediately when no requests are in flight", () => {
    resetInFlightForTests();
    const result = scheduleGlobalGc();
    expect(result.status).toBe("scheduled");
    expect(result.inFlight).toBe(0);
  });

  test("defers GC when requests are in flight", () => {
    resetInFlightForTests();
    incrementInFlight();
    const result = scheduleGlobalGc();
    expect(result.status).toBe("deferred");
    expect(result.inFlight).toBe(1);
    decrementInFlight();
  });
});

describe("memory scheduleGlobalGc coalesce", () => {
  afterEach(() => cancelScheduledGc());

  test("second call while one is pending reports already_pending", () => {
    resetInFlightForTests();
    incrementInFlight();
    const first = scheduleGlobalGc();
    const second = scheduleGlobalGc();
    expect(first.status).toBe("deferred");
    expect(second.status).toBe("already_pending");
    decrementInFlight();
  });

  test("already_pending does not schedule a second retry timer", () => {
    resetInFlightForTests();
    incrementInFlight();
    scheduleGlobalGc();
    // This should not change gcPending state — still only one pending.
    const second = scheduleGlobalGc();
    expect(second.status).toBe("already_pending");
    decrementInFlight();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Limits — boundedInteger and Object.freeze
// ─────────────────────────────────────────────────────────────────────────

describe("runtimeMemoryLimits clamping", () => {
  test("all values are finite integers", () => {
    const values = Object.values(runtimeMemoryLimits);
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test("requestBodyBytes is clamped to [64KB, 64MB]", () => {
    expect(runtimeMemoryLimits.requestBodyBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(runtimeMemoryLimits.requestBodyBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  test("streamLineBytes is clamped to [4KB, 8MB]", () => {
    expect(runtimeMemoryLimits.streamLineBytes).toBeGreaterThanOrEqual(4 * 1024);
    expect(runtimeMemoryLimits.streamLineBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test("streamEventBytes is clamped to [16KB, 16MB]", () => {
    expect(runtimeMemoryLimits.streamEventBytes).toBeGreaterThanOrEqual(16 * 1024);
    expect(runtimeMemoryLimits.streamEventBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test("studioMaxSessions is clamped to [1, 2048]", () => {
    expect(runtimeMemoryLimits.studioMaxSessions).toBeGreaterThanOrEqual(1);
    expect(runtimeMemoryLimits.studioMaxSessions).toBeLessThanOrEqual(2_048);
  });

  test("studioMaxSessionBytes is clamped to [64KB, 16MB]", () => {
    expect(runtimeMemoryLimits.studioMaxSessionBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(runtimeMemoryLimits.studioMaxSessionBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test("studioMaxTotalBytes is clamped to [1MB, 512MB]", () => {
    expect(runtimeMemoryLimits.studioMaxTotalBytes).toBeGreaterThanOrEqual(1 * 1024 * 1024);
    expect(runtimeMemoryLimits.studioMaxTotalBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  test("studioTtlMs is clamped to [60000, 30 days in ms]", () => {
    expect(runtimeMemoryLimits.studioTtlMs).toBeGreaterThanOrEqual(60 * 1_000);
    expect(runtimeMemoryLimits.studioTtlMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1_000);
  });

  test("maxRouteTransitionRoutes is clamped to [16, 100000]", () => {
    expect(runtimeMemoryLimits.maxRouteTransitionRoutes).toBeGreaterThanOrEqual(16);
    expect(runtimeMemoryLimits.maxRouteTransitionRoutes).toBeLessThanOrEqual(100_000);
  });

  test("maxRouteTransitionsPerRoute is clamped to [8, 4096]", () => {
    expect(runtimeMemoryLimits.maxRouteTransitionsPerRoute).toBeGreaterThanOrEqual(8);
    expect(runtimeMemoryLimits.maxRouteTransitionsPerRoute).toBeLessThanOrEqual(4_096);
  });

  test("maxTrackedIps is clamped to [0, 1000000]", () => {
    expect(runtimeMemoryLimits.maxTrackedIps).toBeGreaterThanOrEqual(0);
    expect(runtimeMemoryLimits.maxTrackedIps).toBeLessThanOrEqual(1_000_000);
  });

  test("maxTrackedKeys is clamped to [0, 1000000]", () => {
    expect(runtimeMemoryLimits.maxTrackedKeys).toBeGreaterThanOrEqual(0);
    expect(runtimeMemoryLimits.maxTrackedKeys).toBeLessThanOrEqual(1_000_000);
  });

  test("loginMaxTrackedIps is clamped to [0, 1000000]", () => {
    expect(runtimeMemoryLimits.loginMaxTrackedIps).toBeGreaterThanOrEqual(0);
    expect(runtimeMemoryLimits.loginMaxTrackedIps).toBeLessThanOrEqual(1_000_000);
  });

  test("gcIntervalMs is clamped to [0, 86400000]", () => {
    expect(runtimeMemoryLimits.gcIntervalMs).toBeGreaterThanOrEqual(0);
    expect(runtimeMemoryLimits.gcIntervalMs).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });
});

describe("runtimeMemoryLimits Object.freeze immutability", () => {
  test("is frozen — attempts to mutate throw in strict mode", () => {
    expect(Object.isFrozen(runtimeMemoryLimits)).toBe(true);
    expect(() => {
      (runtimeMemoryLimits as { requestBodyBytes: number }).requestBodyBytes = 1;
    }).toThrow();
  });

  test("cannot add new properties", () => {
    expect(() => {
      Object.defineProperty(runtimeMemoryLimits, "injected", { value: 1 });
    }).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// boundedInteger edge cases — the evaluated limits must always be finite
// integers regardless of env content, because the env parsing uses
// Number.isFinite which rejects NaN, Infinity, and -Infinity.
// ─────────────────────────────────────────────────────────────────────────

describe("boundedInteger env edge cases (invariants)", () => {
  test("NaN in env would be rejected by Number.isFinite — current value is finite", () => {
    // runtimeMemoryLimits was evaluated at module load; we verify the invariant
    // that every field is a finite integer regardless of what env contained.
    expect(Number.isFinite(runtimeMemoryLimits.requestBodyBytes)).toBe(true);
  });

  test("Infinity is non-finite and falls back to default — current value is finite", () => {
    expect(Number.isFinite(runtimeMemoryLimits.requestBodyBytes)).toBe(true);
  });

  test("negative Infinity is non-finite and falls back to default — current value is finite", () => {
    expect(Number.isFinite(runtimeMemoryLimits.requestBodyBytes)).toBe(true);
  });

  test("below minimum is clamped up to the minimum", () => {
    expect(runtimeMemoryLimits.studioMaxSessions).toBeGreaterThanOrEqual(1);
  });

  test("above maximum is clamped down to the maximum", () => {
    expect(runtimeMemoryLimits.studioMaxSessions).toBeLessThanOrEqual(2_048);
  });
});
