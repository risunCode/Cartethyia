/**
 * IP abuse protection: the rate limit, the escalation to a ban, and the
 * measured wait hint.
 *
 * This layer runs on the root `request` hook, ahead of authentication, so it is
 * the gateway's first line against a caller that has decided to hammer it. The
 * behaviors that matter:
 *
 * - **Admission is counted before authentication.** An unauthenticated attempt
 *   must count, or a caller can evade the limit by sending garbage.
 * - **A rejected attempt keeps counting.** Otherwise the escalation to a ban is
 *   unreachable: the caller is refused at the limit forever and never crosses
 *   the threshold.
 * - **The wait hint is measured, not assumed.** A live ban reports its
 *   remaining TTL; a rate-limited window reports when its oldest attempt leaves.
 *   A fixed "1 hour" over-stated every wait and made a client back off far
 *   longer than necessary.
 *
 * Time is an explicit input (`InMemoryIpAbuseStore` takes a clock), so every
 * window and TTL case is exercised by advancing a number rather than sleeping.
 * No test here waits on the wall clock.
 */
import { describe, expect, test } from "bun:test";
import {
  InMemoryIpAbuseStore,
  IpAbuseProtectionService,
} from "../../src/security/abuse";
import { GatewayError } from "../../src/transport/gateway-error";
import type { ClientIdentity } from "../../src/security/abuse";

/** A controllable clock, so a window can be crossed without waiting. */
function createClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Builds the service and its store over one shared clock. */
function createService(options: {
  limit?: number;
  banThreshold?: number;
  banDurationMs?: number;
  windowMs?: number;
}) {
  const clock = createClock();
  const store = new InMemoryIpAbuseStore({
    windowMs: options.windowMs ?? 60_000,
    clock: clock.now,
  });
  const service = new IpAbuseProtectionService(store, clock.now, {
    ...(options.limit === undefined ? {} : { maxRequestsPerWindow: options.limit }),
    ...(options.banThreshold === undefined ? {} : { banThreshold: options.banThreshold }),
    ...(options.banDurationMs === undefined ? {} : { banDurationMs: options.banDurationMs }),
  });
  return { service, store, clock };
}

/** An identity at one address. */
function identity(address: string): ClientIdentity {
  return { address, source: "tcp-peer" };
}

/** Calls `checkBeforeAccess` and returns the thrown GatewayError, or `null`. */
async function attempt(
  service: IpAbuseProtectionService,
  address: string,
  route = "/v1/chat/completions",
): Promise<GatewayError | null> {
  try {
    await service.checkBeforeAccess({ identity: identity(address), route });
    return null;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
}

describe("ip abuse — rate limiting", () => {
  test("admits requests up to the limit", async () => {
    const { service } = createService({ limit: 3, banThreshold: 10 });
    expect(await attempt(service, "10.0.0.1")).toBeNull();
    expect(await attempt(service, "10.0.0.1")).toBeNull();
    expect(await attempt(service, "10.0.0.1")).toBeNull();
  });

  test("refuses the request past the limit with a 429", async () => {
    const { service } = createService({ limit: 3, banThreshold: 10 });
    for (let index = 0; index < 3; index += 1) await attempt(service, "10.0.0.2");
    const error = await attempt(service, "10.0.0.2");
    expect(error).not.toBeNull();
    expect(error?.status).toBe(429);
    expect(error?.code).toBe("quota_exceeded");
  });

  test("the limit is per address, not global", async () => {
    // One noisy client must not consume another client's allowance.
    const { service } = createService({ limit: 2, banThreshold: 10 });
    await attempt(service, "10.0.0.3");
    await attempt(service, "10.0.0.3");
    expect(await attempt(service, "10.0.0.3")).not.toBeNull();
    expect(await attempt(service, "10.0.0.4")).toBeNull();
  });

  test("the limit is per route for one address", async () => {
    // A client that exhausts one endpoint must still reach another; the
    // per-route window exists so a burst on a cheap endpoint cannot lock the
    // client out of everything.
    const { service } = createService({ limit: 2, banThreshold: 10 });
    await attempt(service, "10.0.0.5", "/v1/chat/completions");
    await attempt(service, "10.0.0.5", "/v1/chat/completions");
    expect(await attempt(service, "10.0.0.5", "/v1/chat/completions")).not.toBeNull();
    expect(await attempt(service, "10.0.0.5", "/v1/models")).toBeNull();
  });

  test("the window slides, so an old attempt stops counting", async () => {
    const { service, clock } = createService({ limit: 2, banThreshold: 100, windowMs: 60_000 });
    await attempt(service, "10.0.0.6");
    await attempt(service, "10.0.0.6");
    expect(await attempt(service, "10.0.0.6")).not.toBeNull();

    // Past the window, the earlier attempts have aged out.
    clock.advance(60_001);
    expect(await attempt(service, "10.0.0.6")).toBeNull();
  });

  test("a rejected attempt keeps counting toward the ban", async () => {
    // Measured sequence for limit=1, banThreshold=3:
    //   attempt 1 admitted, attempts 2-3 refused, attempt 4 bans.
    //
    // Without the rejected attempts being counted the escalation is
    // unreachable: the caller is refused at the limit forever and never crosses
    // the threshold. The one-attempt lag is the store's design — the ban is
    // recorded when the *escalation counter* reaches the threshold, and that
    // counter is read before this attempt is added.
    const { service } = createService({ limit: 1, banThreshold: 3 });
    expect(await attempt(service, "10.0.0.7")).toBeNull(); // admitted
    expect((await attempt(service, "10.0.0.7"))?.status).toBe(429); // refused, counted
    expect((await attempt(service, "10.0.0.7"))?.status).toBe(429); // refused, counted
    const fourth = await attempt(service, "10.0.0.7");
    expect(fourth?.message).toContain("banned");
  });

  test("the ban threshold is clamped above the limit", async () => {
    // Measured sequence for limit=10, banThreshold=2: ten admitted, one
    // refused, then the ban. A threshold at or below the limit is unreachable —
    // the count can never exceed the limit without being refused first — so a
    // misconfigured pair must not disable escalation. The clamp
    // (`Math.max(threshold, limit + 1)`) is what makes the ban land on the
    // attempt after the first refusal rather than never.
    const { service } = createService({ limit: 10, banThreshold: 2 });
    for (let index = 0; index < 10; index += 1) {
      expect(await attempt(service, "10.0.0.8")).toBeNull();
    }
    expect((await attempt(service, "10.0.0.8"))?.status).toBe(429);
    expect((await attempt(service, "10.0.0.8"))?.message).toContain("banned");
  });
});

describe("ip abuse — bans", () => {
  test("a ban refuses every route, not only the one that triggered it", async () => {
    // Otherwise a banned caller simply moves to a different endpoint.
    const { service } = createService({ limit: 1, banThreshold: 2 });
    await attempt(service, "10.0.1.1", "/v1/chat/completions");
    await attempt(service, "10.0.1.1", "/v1/chat/completions");
    await attempt(service, "10.0.1.1", "/v1/chat/completions"); // bans
    const other = await attempt(service, "10.0.1.1", "/v1/models");
    expect(other?.message).toContain("banned");
  });

  test("a banned address reports the ban's remaining lifetime", async () => {
    // Measured, not assumed: the client should back off for exactly as long as
    // the ban lasts, not for a fixed hour that over-states every short ban.
    const { service, clock } = createService({
      limit: 1,
      banThreshold: 2,
      banDurationMs: 60_000,
    });
    await attempt(service, "10.0.1.2");
    await attempt(service, "10.0.1.2");
    const ban = await attempt(service, "10.0.1.2");
    expect(ban?.details.retryAfterMs).toBeGreaterThan(0);
    expect(ban?.details.retryAfterMs).toBeLessThanOrEqual(60_000);

    // Halfway through, the reported remainder has shrunk by about half.
    clock.advance(30_000);
    const midway = await attempt(service, "10.0.1.2");
    expect(midway?.details.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  test("a ban expires once its duration elapses", async () => {
    const { service, clock } = createService({
      limit: 1,
      banThreshold: 2,
      banDurationMs: 60_000,
    });
    await attempt(service, "10.0.1.3");
    await attempt(service, "10.0.1.3");
    await attempt(service, "10.0.1.3"); // bans
    expect((await attempt(service, "10.0.1.3"))?.message).toContain("banned");

    clock.advance(60_001);
    // Admitted again — the ban is gone and the window is empty.
    expect(await attempt(service, "10.0.1.3")).toBeNull();
  });

  test("a ban is scoped to the address that earned it", async () => {
    const { service } = createService({ limit: 1, banThreshold: 2 });
    await attempt(service, "10.0.1.4");
    await attempt(service, "10.0.1.4");
    await attempt(service, "10.0.1.4"); // bans 10.0.1.4
    expect(await attempt(service, "10.0.1.5")).toBeNull();
  });
});

describe("ip abuse — abort and failure handling", () => {
  test("an already-aborted signal is refused without touching the store", async () => {
    // A cancelled request must not consume another client's allowance.
    const { service, store } = createService({ limit: 1, banThreshold: 100 });
    const controller = new AbortController();
    controller.abort();
    const error = await attemptWithSignal(service, "10.0.2.1", controller.signal);
    expect(error?.status).toBe(503);
    expect(store.keyCount()).toBe(0);
  });

  test("a store failure is a 503 admission_unavailable, not a 429", async () => {
    // A broken store must fail closed but must not look like a rate limit —
    // telling a well-behaved client to back off would be a lie.
    const { service, store } = createService({ limit: 5, banThreshold: 100 });
    store.simulateFailure(true);
    const error = await attempt(service, "10.0.2.2");
    expect(error?.status).toBe(503);
    expect(error?.code).toBe("admission_unavailable");
  });

  test("the store recovers when the failure clears", async () => {
    const { service, store } = createService({ limit: 5, banThreshold: 100 });
    store.simulateFailure(true);
    expect(await attempt(service, "10.0.2.3")).not.toBeNull();
    store.simulateFailure(false);
    expect(await attempt(service, "10.0.2.3")).toBeNull();
  });
});

describe("ip abuse — memory bounds", () => {
  test("the tracked-key count stays bounded under a fan-out of unique addresses", async () => {
    // An adversary rotating source addresses is the one input that can actually
    // grow this map, so the bound is a correctness property, not a nicety.
    const clock = createClock();
    const store = new InMemoryIpAbuseStore({
      windowMs: 60_000,
      clock: clock.now,
      maxKeys: 50,
    });
    for (let index = 0; index < 500; index += 1) {
      await store.checkAndRecord({
        identity: `10.9.${Math.floor(index / 256)}.${index % 256}`,
        route: "/v1/chat/completions",
        now: clock.now(),
        limit: 240,
        banThreshold: 480,
        banDurationMs: 60_000,
      });
    }
    expect(store.keyCount()).toBeLessThanOrEqual(50);
  });
});

/** `attempt` with an explicit abort signal. */
async function attemptWithSignal(
  service: IpAbuseProtectionService,
  address: string,
  signal: AbortSignal,
): Promise<GatewayError | null> {
  try {
    await service.checkBeforeAccess({
      identity: identity(address),
      route: "/v1/chat/completions",
      signal,
    });
    return null;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
}
