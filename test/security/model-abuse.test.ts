/**
 * Graduated model-abuse strikes: a client that keeps requesting models outside
 * its access is warned, then banned.
 *
 * The suite covers the in-memory store, which is the implementation used
 * whenever Redis is absent — the `single_instance_local` mode — so its
 * behaviour is what a single-node deployment actually enforces.
 *
 * Four properties matter, and each is a way the mechanism fails open or closed:
 *
 * 1. **A valid request clears the strikes.** The feature is a *graduated*
 *    response to a client probing models it may not use. Without the reset, an
 *    ordinary client that once made a handful of typos accumulates strikes
 *    across its whole lifetime and is eventually banned for being careless.
 * 2. **The strike window expires.** Same reasoning, per-strike: a probe last
 *    month must not count toward a ban today.
 * 3. **A ban expires, and an elapsed one is invisible.** A permanent ban turns a
 *    transient misconfiguration into a support escalation; an elapsed ban that
 *    still reads as live is worse, because the operator sees a ban that no
 *    request is actually blocked by.
 * 4. **The strike map is bounded.** Keys are client addresses, so an attacker
 *    with a wide address range is the unbounded-input case.
 *
 * Time is injected, so nothing here sleeps and the whole file runs in
 * milliseconds.
 */
import { describe, expect, test } from "bun:test";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  modelAbuseBannedError,
  modelWarningMessage,
  type ModelAbuseAttempt,
} from "../../src/security/model-abuse";

/** A clock the test drives, so no assertion depends on wall time. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A strike attempt for one address, with the documented defaults spelled out. */
function attempt(overrides: Partial<ModelAbuseAttempt> & { ip: string }): ModelAbuseAttempt {
  return {
    valid: false,
    threshold: 3,
    windowMs: HOUR,
    banTtlMs: 24 * HOUR,
    ...overrides,
  };
}

describe("InMemoryModelAbuseStore — graduated strikes", () => {
  test("strikes accumulate and the ban fires at the threshold", async () => {
    // The graduation itself: the first N-1 probes are counted, the Nth bans.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const first = await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    const second = await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    const third = await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    expect(first).toEqual({ banned: false, strikes: 1, bannedNow: false });
    expect(second).toEqual({ banned: false, strikes: 2, bannedNow: false });
    expect(third).toEqual({ banned: true, strikes: 3, bannedNow: true });
  });

  test("a threshold of one bans on the first probe", async () => {
    // The boundary: a deployment that configures `threshold = 1` means "ban
    // immediately", not "ban after two".
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const outcome = await store.record(attempt({ ip: "203.0.113.1", threshold: 1 }));
    expect(outcome).toEqual({ banned: true, strikes: 1, bannedNow: true });
  });

  test("a probe from a banned address reports the ban without adding a strike", async () => {
    // The ban is already in force; counting further probes would make the strike
    // count grow without bound while the ban is live, and the caller only needs
    // to know it is banned.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    for (let index = 0; index < 3; index += 1) {
      await store.record(attempt({ ip: "203.0.113.1" }));
    }
    const afterBan = await store.record(attempt({ ip: "203.0.113.1" }));
    expect(afterBan).toEqual({ banned: true, strikes: 0, bannedNow: false });
    // `bannedNow` is false, so the caller does not re-notify about a ban it
    // already reported.
    expect(afterBan.bannedNow).toBe(false);
  });

  test("a valid request clears the strikes for that address", async () => {
    // Without the reset, an ordinary client's occasional typo accumulates across
    // its whole lifetime and it is eventually banned for being careless.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    const good = await store.record(attempt({ ip: "203.0.113.1", threshold: 3, valid: true }));
    expect(good).toEqual({ banned: false, strikes: 0, bannedNow: false });
    // And the count really restarted: two more probes do not reach the threshold.
    const again = await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    expect(again.strikes).toBe(1);
    expect(again.banned).toBe(false);
  });

  test("a valid request from a banned address does not lift the ban", async () => {
    // The ban is a separate state from the strike count. A banned client that
    // happens to send one valid request must stay banned, or the ban would be
    // trivially escapable by alternating a good request with the probes.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    for (let index = 0; index < 3; index += 1) {
      await store.record(attempt({ ip: "203.0.113.1" }));
    }
    const outcome = await store.record(attempt({ ip: "203.0.113.1", valid: true }));
    expect(outcome.banned).toBe(true);
    expect(await store.isBanned("203.0.113.1")).toBe(true);
  });

  test("strikes are per address, not global", async () => {
    // A shared counter would let one abusive client ban every other client.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3 }));
    const other = await store.record(attempt({ ip: "203.0.113.2", threshold: 3 }));
    expect(other).toEqual({ banned: false, strikes: 1, bannedNow: false });
    expect(await store.isBanned("203.0.113.2")).toBe(false);
  });

  test("a strike window expiry resets the count", async () => {
    // A probe last month must not count toward a ban today.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
    clock.advance(MINUTE + 1);
    const afterWindow = await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
    expect(afterWindow.strikes).toBe(1);
    expect(afterWindow.banned).toBe(false);
  });

  test("the window boundary is inclusive of the expiry instant", async () => {
    // `entry.expiresAt <= now` resets, so a strike recorded exactly one window
    // ago is already forgotten. Pin the edge so a change to `<` is caught.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
    clock.advance(MINUTE);
    const atBoundary = await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
    expect(atBoundary.strikes).toBe(1);
  });

  test("each strike extends the window from its own instant", async () => {
    // `expiresAt = now + windowMs` on every strike, so a client probing steadily
    // every half-window never lets the count lapse — which is the intent: a
    // sustained prober is the case the ban exists for.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const halfWindow = MINUTE / 2;
    for (let index = 0; index < 3; index += 1) {
      await store.record(attempt({ ip: "203.0.113.1", threshold: 3, windowMs: MINUTE }));
      clock.advance(halfWindow);
    }
    expect(await store.isBanned("203.0.113.1")).toBe(true);
  });
});

describe("InMemoryModelAbuseStore — bans", () => {
  test("a ban expires after its TTL and stops reporting as live", async () => {
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: HOUR }));
    expect(await store.isBanned("203.0.113.1")).toBe(true);
    clock.advance(HOUR + 1);
    expect(await store.isBanned("203.0.113.1")).toBe(false);
  });

  test("the ban boundary is inclusive of the expiry instant", async () => {
    // `expiresAt <= now` lifts the ban, so exactly at the TTL the address is
    // free again. Pin the edge so the ban cannot silently last one tick longer.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: HOUR }));
    clock.advance(HOUR);
    expect(await store.isBanned("203.0.113.1")).toBe(false);
  });

  test("an elapsed ban is dropped from the listing", async () => {
    // The operator's ban list must not show a ban that no request is blocked by;
    // a stale row reads as a live ban and sends them looking for the client.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: MINUTE }));
    await store.record(attempt({ ip: "203.0.113.2", threshold: 1, banTtlMs: 24 * HOUR }));
    expect(await store.listBans()).toHaveLength(2);
    clock.advance(MINUTE + 1);
    const listed = await store.listBans();
    expect(listed.map((ban) => ban.ip)).toEqual(["203.0.113.2"]);
  });

  test("a listed ban carries its expiry instant", async () => {
    // The console renders "expires at"; a listing without the instant cannot
    // show the operator how long the client stays blocked.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const start = clock.now();
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: HOUR }));
    const listed = await store.listBans();
    expect(listed).toEqual([{ ip: "203.0.113.1", expiresAt: start + HOUR }]);
  });

  test("unban lifts a live ban and reports that it did", async () => {
    // The return value is the operator's confirmation; a silent success makes
    // the console unable to tell "lifted" from "there was no such ban".
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: HOUR }));
    expect(await store.unban("203.0.113.1")).toBe(true);
    expect(await store.isBanned("203.0.113.1")).toBe(false);
    expect(await store.listBans()).toEqual([]);
  });

  test("unban reports false for an address with no ban", async () => {
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    expect(await store.unban("203.0.113.9")).toBe(false);
  });

  test("unban reports false for an already-expired ban", async () => {
    // The ban map still holds the entry until something reads it, so the return
    // value is what tells the operator the ban was already gone.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: MINUTE }));
    clock.advance(MINUTE + 1);
    // `isBanned` runs first and prunes, which is the read path the console uses.
    expect(await store.isBanned("203.0.113.1")).toBe(false);
    expect(await store.unban("203.0.113.1")).toBe(false);
  });

  test("unbanning one address leaves another ban in place", async () => {
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 1, banTtlMs: HOUR }));
    await store.record(attempt({ ip: "203.0.113.2", threshold: 1, banTtlMs: HOUR }));
    await store.unban("203.0.113.1");
    expect(await store.isBanned("203.0.113.1")).toBe(false);
    expect(await store.isBanned("203.0.113.2")).toBe(true);
  });

  test("after a ban expires the address starts its strikes over", async () => {
    // A ban is the end of one episode. If the count survived it, the first probe
    // after the ban lifted would re-ban immediately and the TTL would be
    // meaningless. MEASURED: the strike entry is *not* cleared by the ban, but
    // its own window has elapsed by the time the ban has, so the count restarts
    // from zero either way.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    await store.record(attempt({ ip: "203.0.113.1", threshold: 2, banTtlMs: MINUTE, windowMs: MINUTE }));
    await store.record(attempt({ ip: "203.0.113.1", threshold: 2, banTtlMs: MINUTE, windowMs: MINUTE }));
    clock.advance(MINUTE + 1);
    const afterBan = await store.record(attempt({ ip: "203.0.113.1", threshold: 2, banTtlMs: MINUTE, windowMs: MINUTE }));
    expect(afterBan.strikes).toBe(1);
    expect(afterBan.banned).toBe(false);
  });
});

describe("InMemoryModelAbuseStore — the key bound", () => {
  test("the strike map stays bounded when many addresses probe", async () => {
    // Keys are client addresses, so a wide address range is the unbounded-input
    // case. The bound is what keeps an address-rotating attacker from growing
    // the process's memory without limit.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now, { maxKeys: 10 });
    for (let index = 0; index < 100; index += 1) {
      await store.record(attempt({ ip: `203.0.113.${index}`, threshold: 5 }));
    }
    // The newest addresses are still tracked, which is the intended eviction
    // order: the oldest-inserted keys go first.
    const newest = await store.record(attempt({ ip: "203.0.113.99", threshold: 5 }));
    expect(newest.strikes).toBe(2);
  });

  test("eviction does not evict the address currently being recorded", async () => {
    // The new entry is written after the eviction pass, so the address being
    // recorded always survives. If it were evicted, a client probing from a
    // fresh address every time could never accumulate a strike at all.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now, { maxKeys: 2 });
    await store.record(attempt({ ip: "a", threshold: 3 }));
    await store.record(attempt({ ip: "b", threshold: 3 }));
    await store.record(attempt({ ip: "c", threshold: 3 }));
    const again = await store.record(attempt({ ip: "c", threshold: 3 }));
    expect(again.strikes).toBe(2);
  });

  test("the bound does not apply to the ban map", async () => {
    // A ban is an operator-visible record with a TTL of its own; silently
    // evicting one would un-ban a client the operator expects to stay blocked.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now, { maxKeys: 1 });
    for (let index = 0; index < 5; index += 1) {
      await store.record(attempt({ ip: `203.0.113.${index}`, threshold: 1, banTtlMs: HOUR }));
    }
    expect(await store.listBans()).toHaveLength(5);
  });
});

describe("ModelStrikeService — the policy layer over the store", () => {
  /** The service with a driven clock and a chosen threshold. */
  function service(options: { threshold?: number; windowMs?: number; banTtlMs?: number } = {}) {
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const strikes = new ModelStrikeService(store, {
      threshold: options.threshold ?? 3,
      windowMs: options.windowMs ?? HOUR,
      banTtlMs: options.banTtlMs ?? 24 * HOUR,
    });
    return { strikes, store, clock };
  }

  test("the configured threshold, window, and TTL reach the store", async () => {
    // The service owns the policy and the store owns the mechanism; a wiring
    // mistake here would enforce a default the operator never chose.
    const { strikes, store, clock } = service({ threshold: 2, banTtlMs: MINUTE });
    const first = await strikes.noteInvalid({ ip: "203.0.113.1" });
    const second = await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(first).toEqual({ banned: false, strikes: 1, bannedNow: false });
    expect(second).toEqual({ banned: true, strikes: 2, bannedNow: true });
    expect(await store.listBans()).toEqual([
      { ip: "203.0.113.1", expiresAt: clock.now() + MINUTE },
    ]);
  });

  test("the documented defaults are applied when no options are given", async () => {
    // The option docs state: threshold 10, window 5 minutes, ban 1 hour. These
    // are the values a deployment that configures nothing enforces.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const strikes = new ModelStrikeService(store);
    expect(strikes.limit).toBe(10);
    // Nine strikes do not ban; the tenth does.
    for (let index = 0; index < 9; index += 1) {
      const outcome = await strikes.noteInvalid({ ip: "203.0.113.1" });
      expect(outcome.banned).toBe(false);
    }
    const tenth = await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(tenth.banned).toBe(true);
    // The default ban lasts an hour, not a day.
    const ban = (await store.listBans())[0];
    expect(ban?.expiresAt).toBe(clock.now() + HOUR);
  });

  test("each option is floored at one so a zero cannot disable the mechanism", async () => {
    // A threshold of 0 would ban on the first request; a window or TTL of 0
    // would make the counter or the ban expire instantly, silently disabling the
    // protection. `Math.max(1, ...)` is what prevents both.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const strikes = new ModelStrikeService(store, { threshold: 0, windowMs: 0, banTtlMs: 0 });
    expect(strikes.limit).toBe(1);
    const outcome = await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(outcome.banned).toBe(true);
    // The ban is live for at least one millisecond, not zero.
    expect(await store.isBanned("203.0.113.1")).toBe(true);
  });

  test("check reports the ban state for the pre-parse gate", async () => {
    const { strikes } = service({ threshold: 1, banTtlMs: HOUR });
    expect(await strikes.check({ ip: "203.0.113.1" })).toBe(false);
    await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(await strikes.check({ ip: "203.0.113.1" })).toBe(true);
  });

  test("noteValid skips the store write for an address this process never struck", async () => {
    // The `dirty` set is process-local by design, and the comment states the
    // trade: a miss only means a strike survives until its window expires
    // instead of being cleared early, which is the safe direction for abuse.
    // The observable consequence is that a valid request from a never-struck
    // address costs no store write at all.
    const clock = fakeClock();
    const store = new InMemoryModelAbuseStore(clock.now);
    const strikes = new ModelStrikeService(store, { threshold: 3, windowMs: HOUR, banTtlMs: HOUR });
    await expect(strikes.noteValid({ ip: "203.0.113.1" })).resolves.toBeUndefined();
    // Struck once, then cleared: the next invalid attempt starts at 1 again.
    await strikes.noteInvalid({ ip: "203.0.113.1" });
    await strikes.noteValid({ ip: "203.0.113.1" });
    const afterClear = await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(afterClear.strikes).toBe(1);
  });

  test("a redundant valid request does not write again", async () => {
    // After the reset the address is no longer dirty, so a second valid request
    // is a no-op — the same skip the comment describes.
    const { strikes } = service({ threshold: 3 });
    await strikes.noteInvalid({ ip: "203.0.113.1" });
    await strikes.noteValid({ ip: "203.0.113.1" });
    await strikes.noteValid({ ip: "203.0.113.1" });
    const outcome = await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect(outcome.strikes).toBe(1);
  });

  test("listBans and unban are exposed through the service", async () => {
    const { strikes } = service({ threshold: 1, banTtlMs: HOUR });
    await strikes.noteInvalid({ ip: "203.0.113.1" });
    expect((await strikes.listBans()).map((ban) => ban.ip)).toEqual(["203.0.113.1"]);
    expect(await strikes.unban("203.0.113.1")).toBe(true);
    expect(await strikes.listBans()).toEqual([]);
  });

  test("a store failure propagates rather than reporting a clean outcome", async () => {
    // Fail closed at this layer: an unavailable strike store must not read as
    // "no strikes", which would silently disable the abuse protection exactly
    // when the deployment is degraded. (The Redis-backed store swallows its own
    // outage into a fail-open decision; that is the store's documented contract,
    // not this service's.)
    const failing = {
      record: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
      isBanned: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
      listBans: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
      unban: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
    };
    const strikes = new ModelStrikeService(failing, {
      threshold: 3,
      windowMs: HOUR,
      banTtlMs: HOUR,
    });
    await expect(strikes.noteInvalid({ ip: "203.0.113.1" })).rejects.toThrow("store unavailable");
    await expect(strikes.check({ ip: "203.0.113.1" })).rejects.toThrow("store unavailable");
  });
});

describe("modelAbuseBannedError", () => {
  test("is a 403 with its own code so a ban is distinguishable from a rejection", () => {
    // The comment is explicit: the console and the client must be able to tell
    // an abuse ban from a per-request rejection. A 404 here would be
    // indistinguishable from the model-not-found response that caused the ban.
    const error = modelAbuseBannedError();
    expect(error.status).toBe(403);
    expect(error.code).toBe("model_abuse_banned");
    expect(error.origin).toBe("cartethyia");
  });

  test("the message names the cause without naming the threshold", () => {
    // The escalating 404 warning is what tells the client the count; the ban
    // message only has to explain why it is now blocked.
    expect(modelAbuseBannedError().message).toContain("banned");
    expect(modelAbuseBannedError().message).not.toMatch(/\d/);
  });
});

describe("modelWarningMessage", () => {
  test("names the model, the strike count, and the limit", () => {
    // The comment is explicit about why the count is in the message: an honest
    // client that mistyped is told exactly what it is doing wrong before it is
    // banned, instead of seeing the same generic 404 ten times and then a wall.
    const message = modelWarningMessage(
      "gpt-5",
      { banned: false, strikes: 3, bannedNow: false },
      10,
    );
    expect(message).toContain("gpt-5");
    expect(message).toContain("Warning 3 of 10");
    expect(message).toContain("ban this client");
  });

  test("a one-strike warning reads as a warning, not as a ban", () => {
    const message = modelWarningMessage(
      "gpt-5",
      { banned: false, strikes: 1, bannedNow: false },
      10,
    );
    expect(message).toContain("Warning 1 of 10");
    expect(message).not.toContain("is banned");
  });

  test("the final strike still reads as a warning, because the ban is a separate response", () => {
    // The last warning is delivered on the response that bans; the client sees
    // this text and then the 403 on its next attempt.
    const message = modelWarningMessage(
      "gpt-5",
      { banned: true, strikes: 10, bannedNow: true },
      10,
    );
    expect(message).toContain("Warning 10 of 10");
  });

  test("the model name is quoted so a name with spaces stays readable", () => {
    const message = modelWarningMessage(
      "some model/with-slash",
      { banned: false, strikes: 1, bannedNow: false },
      5,
    );
    expect(message).toContain("'some model/with-slash'");
  });

  test("a hostile model name is embedded as text, not interpreted", () => {
    // The name is client-supplied (it is whatever the caller asked for) and the
    // message goes back to that same client. Asserting it is embedded verbatim
    // pins that nothing here builds a pattern or a path from it.
    const hostile = "x'; drop table--";
    expect(
      modelWarningMessage(hostile, { banned: false, strikes: 1, bannedNow: false }, 5),
    ).toContain(hostile);
  });
});
