/**
 * The failure-policy decisions, as units.
 *
 * Everything in `transport/failure-policy.ts` is a pure function over a header
 * map, an error body, a status code, or an abort signal — no database, no
 * socket, and no clock the caller cannot supply. That is exactly why it gets an
 * exhaustive suite: these functions decide whether an account is cooled down,
 * whether a failed attempt is retried on the next candidate, and what the
 * operator's console records. An off-by-one in a status range, or a parser that
 * silently answers `null`, is a routing bug rather than a cosmetic one.
 *
 * A few assertions are marked `test.failing`: they pin defects found while
 * writing this suite. The source is deliberately left alone, so each carries a
 * comment stating the mechanism and the reachable impact. Bun reports an
 * unexpectedly passing `test.failing` as a failure, which is the correct signal
 * once the owning module is repaired.
 *
 * Time-dependent expectations are written as ranges, never exact values, so a
 * slow or busy machine cannot make the suite flake.
 */
import { describe, expect, test } from "bun:test";
import type { GatewayErrorCode } from "../../src/transport/gateway-error";
import { GatewayError } from "../../src/transport/gateway-error";
import {
  classifyTerminalCategory,
  classifyTerminalOutcome,
  classifyUpstreamError,
  classifyUpstreamFailure,
  extractHtmlTitle,
  extractUpstreamMessage,
  fallbackRetryDelayMs,
  isClientCancellation,
  isContextLengthFailure,
  isRetryableFailure,
  parseAbsoluteResetTimestamp,
  parseProviderResetDuration,
  parseRateLimitReset,
  parseResetAfterMs,
  parseRetryAfter,
  parseUpstreamBackoff,
  statusToGatewayErrorCode,
  upstreamErrorIdentifier,
  upstreamProviderCode,
  upstreamRequestId,
} from "../../src/transport/failure-policy";

const MAX_COOLDOWN_MS = 24 * 3600 * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;

/** A `Headers`-shaped stand-in, so a case can state only the headers it means. */
function headerBag(entries: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => entries[name] ?? null };
}

/** An `AbortSignal` already aborted with `reason` (`abort()` defaults to AbortError). */
function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

/** Formats an instant as a provider's `YYYY-MM-DD HH:MM:SS` stamp, in UTC. */
function utcStamp(msFromNow: number): string {
  const at = new Date(Date.now() + msFromNow);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    at.getUTCFullYear(),
    pad(at.getUTCMonth() + 1),
    pad(at.getUTCDate()),
  ].join("-") + ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
}

/**
 * Formats an instant as the same wall-clock stamp the provider would print in
 * the given offset. `+08:00` at `T` reads `T + 8h`, which is what makes an
 * absolute-reset parser testable without freezing the clock.
 */
function stampInOffset(msFromNow: number, offsetMinutes: number): string {
  return utcStamp(msFromNow + offsetMinutes * MINUTE_MS);
}

/** Runs `read` with `Math.random` pinned, so jittered backoff is deterministic. */
function withRandom<T>(value: number, read: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return read();
  } finally {
    Math.random = original;
  }
}

/** Runs `read` with `env` applied, restoring every key afterwards. */
function withEnv<T>(env: Record<string, string>, read: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return read();
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

describe("parseRetryAfter", () => {
  test("treats absent, empty, and whitespace-only values as no evidence", () => {
    // A header the upstream sent empty is not a zero-second instruction.
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  test("reads delay-seconds, scaled to milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(" 30 ")).toBe(30_000);
    expect(parseRetryAfter("1.5")).toBe(1_500);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  test("refuses zero and negative seconds", () => {
    // `0` would mean "retry immediately", which is how a rate limiter is
    // hammered into extending its own ban.
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });

  test("reads an HTTP date as a delay from now", () => {
    const parsed = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());
    expect(parsed).not.toBeNull();
    expect(parsed ?? 0).toBeGreaterThan(58_000);
    expect(parsed ?? 0).toBeLessThanOrEqual(60_000);
  });

  test("refuses an HTTP date already in the past", () => {
    expect(parseRetryAfter("Mon, 01 Jan 1990 00:00:00 GMT")).toBeNull();
  });

  test("caps both forms at one day", () => {
    // The bound exists so a hostile or confused upstream cannot park an account
    // for a week; both the numeric and the date path must honor it.
    expect(parseRetryAfter("86401")).toBe(MAX_COOLDOWN_MS);
    expect(parseRetryAfter("999999999999")).toBe(MAX_COOLDOWN_MS);
    expect(parseRetryAfter("1e30")).toBe(MAX_COOLDOWN_MS);
    expect(parseRetryAfter(new Date(Date.now() + 3 * 24 * HOUR_MS).toUTCString())).toBe(MAX_COOLDOWN_MS);
  });

  test("accepts the one-day bound itself rather than clamping below it", () => {
    expect(parseRetryAfter("86400")).toBe(MAX_COOLDOWN_MS);
  });

  test("refuses a non-finite value that is not also a date", () => {
    // `Number("Infinity")` is finite-checked, and `Date.parse` rejects the word.
    expect(parseRetryAfter("Infinity")).toBeNull();
    expect(parseRetryAfter("NaN")).toBeNull();
    expect(parseRetryAfter("abc")).toBeNull();
  });

  test("returns a fractional delay for a sub-millisecond numeric value", () => {
    // The guard is `> 0`, not `>= 1`, so `0.0001` survives as 0.1ms. Harmless
    // here (callers compare `> 0`), but it is why the floor is not 1ms.
    expect(parseRetryAfter("0.0001")).toBe(0.1);
  });

  test("reads an ISO timestamp, the one unambiguous date form", () => {
    const parsed = parseRetryAfter(new Date(Date.now() + 120_000).toISOString());
    expect(parsed).not.toBeNull();
    expect(parsed ?? 0).toBeGreaterThan(118_000);
    expect(parsed ?? 0).toBeLessThanOrEqual(120_000);
  });

  test("never returns a negative or non-finite delay for any input", () => {
    // The contract every caller relies on: `null` means "no usable evidence",
    // never "already elapsed". This is asserted across the malformed and
    // hostile inputs above as one invariant, because a negative delay would
    // push a stored retry deadline into the past.
    const inputs: readonly (string | null | undefined)[] = [
      null,
      undefined,
      "",
      "   ",
      "0",
      "-5",
      "abc",
      "Infinity",
      "NaN",
      "1e30",
      "999999999999",
      "Mon, 01 Jan 1990 00:00:00 GMT",
      new Date(Date.now() + 3 * 24 * HOUR_MS).toUTCString(),
      utcStamp(2 * HOUR_MS),
    ];
    for (const value of inputs) {
      const parsed = parseRetryAfter(value);
      if (parsed === null) continue;
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThan(0);
      expect(parsed).toBeLessThanOrEqual(MAX_COOLDOWN_MS);
    }
  });
});

describe("parseRateLimitReset", () => {
  test("treats absent, empty, zero, negative, and malformed values as no evidence", () => {
    expect(parseRateLimitReset(null)).toBeNull();
    expect(parseRateLimitReset(undefined)).toBeNull();
    expect(parseRateLimitReset("")).toBeNull();
    expect(parseRateLimitReset("0")).toBeNull();
    expect(parseRateLimitReset("-3")).toBeNull();
    expect(parseRateLimitReset("abc")).toBeNull();
    expect(parseRateLimitReset("Infinity")).toBeNull();
  });

  test("reads a value below 1e9 as a relative delay in seconds", () => {
    expect(parseRateLimitReset("2")).toBe(2_000);
    expect(parseRateLimitReset("60")).toBe(60_000);
    expect(parseRateLimitReset("3600")).toBe(HOUR_MS);
    expect(parseRateLimitReset("1.5")).toBe(1_500);
  });

  test("reads a value at or above 1e9 as epoch seconds", () => {
    // The threshold is the whole disambiguation: 1e9 seconds is 2001, so no
    // live relative delay reaches it and no live epoch falls below it.
    const epochSeconds = Math.floor(Date.now() / 1000) + 120;
    const parsed = parseRateLimitReset(String(epochSeconds));
    expect(parsed).not.toBeNull();
    expect(parsed ?? 0).toBeGreaterThan(118_000);
    expect(parsed ?? 0).toBeLessThanOrEqual(120_000);
  });

  test("caps a relative delay at one day", () => {
    expect(parseRateLimitReset("86400")).toBe(MAX_COOLDOWN_MS);
    expect(parseRateLimitReset("999999999")).toBe(MAX_COOLDOWN_MS);
    expect(parseRateLimitReset("1e30")).toBe(MAX_COOLDOWN_MS);
  });

  test("caps a far-future epoch at one day", () => {
    const threeDaysOut = Math.floor(Date.now() / 1000) + 3 * 86_400;
    expect(parseRateLimitReset(String(threeDaysOut))).toBe(MAX_COOLDOWN_MS);
  });

  test("returns null for an epoch that has already passed", () => {
    // Was "returns zero", on the reading that a stale epoch is evidence of no wait
    // at all. That reading is right about the VALUE but wrong about the SIGNAL:
    // `parseUpstreamBackoff` chains these parsers with `??`, which falls through
    // only on null, so a `0` stopped the chain before the lower-priority headers
    // that carried the real wait — and the `0` then outranked the provider's own
    // message text downstream. `null` says "no evidence here, ask the next source",
    // which is what the elapsed case actually means. `parseRetryAfter` already
    // behaved this way, so this also removes the asymmetry between the two.
    const tenSecondsAgo = Math.floor(Date.now() / 1000) - 10;
    expect(parseRateLimitReset(String(tenSecondsAgo))).toBeNull();
    expect(parseRateLimitReset("1000000000")).toBeNull();
  });

  test("refuses Go-style duration text, which this parser does not read", () => {
    expect(parseRateLimitReset("6m0s")).toBeNull();
    expect(parseRateLimitReset("1s")).toBeNull();
  });
});

describe("parseResetAfterMs", () => {
  test("treats absent, zero, negative, and malformed values as no evidence", () => {
    expect(parseResetAfterMs(null)).toBeNull();
    expect(parseResetAfterMs(undefined)).toBeNull();
    expect(parseResetAfterMs("")).toBeNull();
    expect(parseResetAfterMs("0")).toBeNull();
    expect(parseResetAfterMs("-1")).toBeNull();
    expect(parseResetAfterMs("abc")).toBeNull();
  });

  test("reads a millisecond value verbatim, including one with surrounding space", () => {
    expect(parseResetAfterMs("250")).toBe(250);
    expect(parseResetAfterMs(" 250 ")).toBe(250);
    expect(parseResetAfterMs("1500")).toBe(1500);
  });

  test("rounds a fractional value, and rounds a sub-millisecond one to zero", () => {
    // `0.4` passes the `> 0` guard and then rounds to `0`. Callers treat a
    // falsy delay as "no backoff", so a sub-millisecond hint is a no-op rather
    // than a floor of 1ms.
    expect(parseResetAfterMs("0.4")).toBe(0);
    expect(parseResetAfterMs("0.4999")).toBe(0);
    expect(parseResetAfterMs("0.5")).toBe(1);
    expect(parseResetAfterMs("1500.6")).toBe(1501);
    expect(parseResetAfterMs("2.5")).toBe(3);
  });

  test("caps at one day, inclusive", () => {
    expect(parseResetAfterMs(String(MAX_COOLDOWN_MS))).toBe(MAX_COOLDOWN_MS);
    expect(parseResetAfterMs(String(MAX_COOLDOWN_MS + 1))).toBe(MAX_COOLDOWN_MS);
    expect(parseResetAfterMs("1e30")).toBe(MAX_COOLDOWN_MS);
  });
});

describe("parseUpstreamBackoff", () => {
  test("returns null when no recognized header carries evidence", () => {
    expect(parseUpstreamBackoff(headerBag({}))).toBeNull();
    expect(parseUpstreamBackoff(new Headers())).toBeNull();
  });

  test("prefers retry-after-ms over every other form", () => {
    expect(
      parseUpstreamBackoff(
        headerBag({ "retry-after-ms": "700", "retry-after": "30", "x-ratelimit-reset": "400" }),
      ),
    ).toBe(700);
  });

  test("prefers retry-after over x-ratelimit-reset-ms", () => {
    // Millisecond-first ordering holds *within* a family; the classic
    // retry-after pair still outranks the x-ratelimit pair.
    expect(
      parseUpstreamBackoff(headerBag({ "retry-after": "30", "x-ratelimit-reset-ms": "900" })),
    ).toBe(30_000);
  });

  test("prefers x-ratelimit-reset-ms over x-ratelimit-reset", () => {
    expect(
      parseUpstreamBackoff(headerBag({ "x-ratelimit-reset-ms": "900", "x-ratelimit-reset": "400" })),
    ).toBe(900);
  });

  test("falls back to x-ratelimit-reset-requests", () => {
    expect(parseUpstreamBackoff(headerBag({ "x-ratelimit-reset-requests": "25" }))).toBe(25_000);
  });

  test("skips a malformed higher-priority header instead of failing the whole read", () => {
    // A provider sending `retry-after: soon` beside a usable reset must still
    // yield the reset.
    expect(parseUpstreamBackoff(headerBag({ "retry-after": "soon", "x-ratelimit-reset": "8" }))).toBe(
      8_000,
    );
    expect(
      parseUpstreamBackoff(
        headerBag({
          "retry-after-ms": "nan",
          "retry-after": new Date(Date.now() + 20_000).toUTCString(),
        }),
      ),
    ).toBeGreaterThan(18_000);
  });

  test("returns null when every present header is malformed", () => {
    expect(
      parseUpstreamBackoff(
        headerBag({ "retry-after": "soon", "x-ratelimit-reset": "later", "retry-after-ms": "nan" }),
      ),
    ).toBeNull();
  });

  test("skips a zero-valued header, because zero is not evidence", () => {
    // `parseResetAfterMs("0")` is null, so the next form is consulted rather
    // than the whole read collapsing to a zero delay.
    expect(parseUpstreamBackoff(new Headers({ "retry-after-ms": "0", "retry-after": "7" }))).toBe(7_000);
    expect(parseUpstreamBackoff(new Headers({ "retry-after": "0", "x-ratelimit-reset": "9" }))).toBe(
      9_000,
    );
  });

  test("reads a header case-insensitively through Headers", () => {
    expect(parseUpstreamBackoff(new Headers({ "Retry-After-Ms": "1200" }))).toBe(1200);
  });

  test("does not read a Go-style duration out of the trailing retry-after retry", () => {
    // The final `parseRateLimitReset(retry-after)` is unreachable for anything
    // `parseRetryAfter` could already parse; what reaches it is text both
    // `Date.parse` and `Number` reject.
    expect(parseUpstreamBackoff(headerBag({ "retry-after": "6m0s" }))).toBeNull();
  });

  /**
   * DEFECT — a stale epoch in `x-ratelimit-reset` masks
   * `x-ratelimit-reset-requests` with a zero.
   *
   * `parseRateLimitReset` returns `0` for an epoch that has already passed (the
   * `Math.max(0, target - Date.now())` floor), and `parseUpstreamBackoff`
   * chains with `??`, which falls through only on null. `x-ratelimit-reset`
   * sits *before* `x-ratelimit-reset-requests` in that chain, so when an
   * upstream sends a past epoch there — a cached error body, clock skew, or a
   * stale edge response — the read stops at `0` and never consults the
   * requests header that carried the real wait.
   *
   * Impact: the value is written to `details.retryAfterMs` and read by
   * `classifyAccountError` as `headerCooldown`, which outranks the message text
   * (`headerCooldown ?? messageCooldown`). `0` is not nullish, so a stale epoch
   * discards both the lower-priority header *and* a reset the provider stated
   * in its message, and the account falls back to the generic default cooldown
   * while the provider had parked it for the rest of the window. The sibling
   * `parseRetryAfter` has no such shape — it returns `null` for an elapsed date
   * — and that asymmetry is what makes the zero reachable.
   */
  test("does not let a stale epoch mask a usable lower-priority header", () => {
    const oneMinuteAgo = String(Math.floor(Date.now() / 1000) - 60);
    const resolved = parseUpstreamBackoff(
      new Headers({ "x-ratelimit-reset": oneMinuteAgo, "x-ratelimit-reset-requests": "25" }),
    );
    expect(resolved).toBe(25_000);
  });

  test("lets retry-after win over a stale epoch, because it is consulted first", () => {
    // The counterpart to the defect above: this ordering is why the bug is
    // narrow rather than total — only the headers *after* x-ratelimit-reset are
    // reachable-masked.
    const oneMinuteAgo = String(Math.floor(Date.now() / 1000) - 60);
    expect(
      parseUpstreamBackoff(new Headers({ "x-ratelimit-reset": oneMinuteAgo, "retry-after": "30" })),
    ).toBe(30_000);
  });
});

describe("parseAbsoluteResetTimestamp", () => {
  test("reads the space-separated stamp with a bare UTC offset", () => {
    // This is the form `Date.parse` cannot read, and the reason the parser
    // exists rather than delegating to the engine.
    const parsed = parseAbsoluteResetTimestamp(`reset at ${stampInOffset(2 * HOUR_MS, 480)} UTC+8`);
    expect(parsed).not.toBeNull();
    expect(parsed ?? 0).toBeGreaterThan(2 * HOUR_MS - MINUTE_MS);
    expect(parsed ?? 0).toBeLessThanOrEqual(2 * HOUR_MS);
  });

  test("subtracts a positive offset and adds a negative one", () => {
    // The stamp is the provider's local wall clock, so `UTC+8` names an instant
    // eight hours earlier than the digits alone. Getting the sign backwards
    // shifts the cooldown by 16 hours.
    const plus = parseAbsoluteResetTimestamp(`${stampInOffset(2 * HOUR_MS, 480)} UTC+8`);
    const minus = parseAbsoluteResetTimestamp(`${stampInOffset(2 * HOUR_MS, -300)} UTC-5`);
    expect(plus).not.toBeNull();
    expect(minus).not.toBeNull();
    expect(Math.abs((plus ?? 0) - 2 * HOUR_MS)).toBeLessThan(MINUTE_MS);
    expect(Math.abs((minus ?? 0) - 2 * HOUR_MS)).toBeLessThan(MINUTE_MS);
  });

  test("honors a half-hour offset written as +HH:MM or +HHMM", () => {
    const colon = parseAbsoluteResetTimestamp(`${stampInOffset(2 * HOUR_MS, 510)}+08:30`);
    const compact = parseAbsoluteResetTimestamp(`${stampInOffset(2 * HOUR_MS, 510)}+0830`);
    for (const parsed of [colon, compact]) {
      expect(parsed).not.toBeNull();
      expect(Math.abs((parsed ?? 0) - 2 * HOUR_MS)).toBeLessThan(MINUTE_MS);
    }
  });

  test("reads a missing offset as UTC", () => {
    const parsed = parseAbsoluteResetTimestamp(`reset at ${stampInOffset(2 * HOUR_MS, 0)}`);
    expect(parsed).not.toBeNull();
    expect(Math.abs((parsed ?? 0) - 2 * HOUR_MS)).toBeLessThan(MINUTE_MS);
  });

  test("accepts UTC and GMT labels, and a T separator", () => {
    for (const text of [
      `reset at ${stampInOffset(2 * HOUR_MS, 0)} UTC`,
      `reset at ${stampInOffset(2 * HOUR_MS, 0)} GMT`,
      `reset at ${stampInOffset(2 * HOUR_MS, 0).replace(" ", "T")}`,
    ]) {
      const parsed = parseAbsoluteResetTimestamp(text);
      expect(parsed).not.toBeNull();
      expect(Math.abs((parsed ?? 0) - 2 * HOUR_MS)).toBeLessThan(MINUTE_MS);
    }
  });

  test("returns null for a past stamp rather than a negative delay", () => {
    // Clock skew and stale cached error bodies both produce these, and a
    // negative delay would push the caller's deadline into the past.
    expect(parseAbsoluteResetTimestamp("reset at 1999-01-01 00:00:00 UTC")).toBeNull();
  });

  test("returns null when no stamp is present, or the stamp is incomplete", () => {
    expect(parseAbsoluteResetTimestamp("no timestamp here")).toBeNull();
    expect(parseAbsoluteResetTimestamp("reset at 2030-01-01 00:00")).toBeNull();
    expect(parseAbsoluteResetTimestamp("")).toBeNull();
  });

  test("caps a far-future stamp at one day", () => {
    expect(parseAbsoluteResetTimestamp(`reset at ${utcStamp(3 * 24 * HOUR_MS)} UTC`)).toBe(
      MAX_COOLDOWN_MS,
    );
  });

  test("does not range-check calendar fields, so an impossible date rolls over", () => {
    // `Date.UTC` normalizes month 13 and day 45 instead of rejecting them. In
    // the direction shown the result is still a bounded future delay, but the
    // behavior is pinned so a future range check is a deliberate change.
    expect(parseAbsoluteResetTimestamp("reset at 2030-13-45 99:99:99")).toBe(MAX_COOLDOWN_MS);
    expect(parseAbsoluteResetTimestamp("reset at 2030-02-31 00:00:00")).not.toBeNull();
  });
});

describe("parseProviderResetDuration", () => {
  test("reads a single unit after a reset trigger", () => {
    expect(parseProviderResetDuration("Your quota will reset in 3 hours.")).toBe(3 * HOUR_MS);
    expect(parseProviderResetDuration("Rate limit reached, please try again in 30s")).toBe(30_000);
    expect(parseProviderResetDuration("Please retry after 60 seconds")).toBe(60_000);
  });

  test("reads a decimal amount", () => {
    expect(parseProviderResetDuration("Please try again in 1.5 minutes")).toBe(90_000);
    expect(parseProviderResetDuration("quota will reset in 2.5 hours")).toBe(2.5 * HOUR_MS);
  });

  test("sums a compound duration, with or without a separator", () => {
    // "4h 13m" is the daily-limit shape. Reading only `4h` stored a deadline
    // thirteen minutes earlier than the window the provider stated, so the
    // account re-entered rotation inside it.
    expect(parseProviderResetDuration("quota will reset in 4h 13m")).toBe(
      4 * HOUR_MS + 13 * MINUTE_MS,
    );
    expect(parseProviderResetDuration("resets in 2h30m")).toBe(2 * HOUR_MS + 30 * MINUTE_MS);
    expect(parseProviderResetDuration("quota will reset in 1 hour and 30 minutes")).toBe(
      HOUR_MS + 30 * MINUTE_MS,
    );
    expect(parseProviderResetDuration("quota will reset in 1 hour, 30 minutes")).toBe(
      HOUR_MS + 30 * MINUTE_MS,
    );
  });

  test("stops summing at a gap that does not continue the phrase", () => {
    // A hyphen is tolerated *inside* a pair but is not a continuation, so a
    // hyphen-separated second pair is not absorbed into the total.
    expect(parseProviderResetDuration("quota will reset in 1 hour - 30 minutes")).toBe(HOUR_MS);
  });

  test("does not absorb a number that merely follows in the sentence", () => {
    expect(parseProviderResetDuration("reset in 3 hours. Your balance is 500 tokens")).toBe(
      3 * HOUR_MS,
    );
    expect(parseProviderResetDuration("try again in 45s or contact support")).toBe(45_000);
  });

  test("accepts the unit spellings and the compact trigger forms", () => {
    expect(parseProviderResetDuration("quota will reset in 4 hrs")).toBe(4 * HOUR_MS);
    expect(parseProviderResetDuration("quota will reset in 4hrs")).toBe(4 * HOUR_MS);
    expect(parseProviderResetDuration("quota will reset in 90 mins")).toBe(90 * MINUTE_MS);
    expect(parseProviderResetDuration("quota resets over 5 minutes")).toBe(5 * MINUTE_MS);
    expect(parseProviderResetDuration("retrying over 45s")).toBe(45_000);
    expect(parseProviderResetDuration("try again in a rolling 10 minutes")).toBe(10 * MINUTE_MS);
  });

  test("refuses milliseconds and months, which are not reset durations", () => {
    // `m(?!s|o)` is the guard: `250 ms` must not read as 250 minutes, and a
    // month is not a window the caller can honor as a delay.
    expect(parseProviderResetDuration("reset in 250 ms")).toBeNull();
    expect(parseProviderResetDuration("reset in 3 months")).toBeNull();
    expect(parseProviderResetDuration("reset in 2 mo")).toBeNull();
  });

  test("returns null for zero, negative, and unparseable phrases", () => {
    expect(parseProviderResetDuration("resets in 0 hours")).toBeNull();
    expect(parseProviderResetDuration("resets in -3 hours")).toBeNull();
    expect(parseProviderResetDuration("try again in a moment")).toBeNull();
    expect(parseProviderResetDuration("quota exceeded until tomorrow")).toBeNull();
  });

  test("falls through to the absolute-stamp parser when no duration is present", () => {
    // The two shapes share one entry point because the caller cannot know which
    // one a provider used.
    const parsed = parseProviderResetDuration(
      `your usage will reset at ${stampInOffset(2 * HOUR_MS, 480)} UTC+8`,
    );
    expect(parsed).not.toBeNull();
    expect(Math.abs((parsed ?? 0) - 2 * HOUR_MS)).toBeLessThan(2 * MINUTE_MS);
  });

  test("prefers a stated duration over an absolute stamp later in the message", () => {
    // The trigger wins and the stamp is never consulted, so the shorter of two
    // contradictory statements is what the caller honors.
    const parsed = parseProviderResetDuration(
      `quota will reset in 3 hours (${utcStamp(HOUR_MS)} UTC)`,
    );
    expect(parsed).toBe(3 * HOUR_MS);
  });

  test("caps a stated duration at one day", () => {
    expect(parseProviderResetDuration("reset in 999999 hours")).toBe(MAX_COOLDOWN_MS);
    expect(parseProviderResetDuration(`reset at ${utcStamp(3 * 24 * HOUR_MS)} UTC`)).toBe(
      MAX_COOLDOWN_MS,
    );
  });

  test("reads a trigger that is not at the start of the message", () => {
    expect(parseProviderResetDuration("Quota exceeded. Reset in 3 hours")).toBe(3 * HOUR_MS);
  });

  test("returns null when a trigger is present but the first token is not a duration", () => {
    // `parseCompoundDuration` distinguishes "matched nothing" from "matched
    // zero", so "in a moment" cannot be mistaken for a 0ms reset.
    expect(parseProviderResetDuration("try again in a moment, quota resets in 5 minutes")).toBeNull();
  });
});

describe("extractUpstreamMessage", () => {
  test("returns a plain string body, collapsing newlines and trimming", () => {
    expect(extractUpstreamMessage("plain string")).toBe("plain string");
    expect(extractUpstreamMessage("line1\nline2\r\nline3")).toBe("line1 line2 line3");
    expect(extractUpstreamMessage("   padded   ")).toBe("padded");
    expect(extractUpstreamMessage("a\n\n\nb")).toBe("a b");
  });

  test("returns an empty string for every shape with no usable text", () => {
    // Callers test `length > 0` to decide whether to substitute their own
    // message, so an empty string is the "nothing to say" answer, not null.
    for (const body of [
      "",
      null,
      undefined,
      42,
      true,
      [],
      [1, 2],
      { error: "" },
      { error: "  " },
      { error: { message: 42 } },
      { error: { code: 500 } },
      { error: null },
      { message: null },
      { nested: { deep: "value" } },
      { error: { error: { message: "deep" } } },
      { error: { message: ["a"] } },
    ]) {
      expect(extractUpstreamMessage(body)).toBe("");
    }
  });

  test("reads a string `error` field before any envelope", () => {
    // Cline-style {"error":"Not Found","success":false}: `error` is the text,
    // not a nested envelope.
    expect(extractUpstreamMessage({ error: "Not Found" })).toBe("Not Found");
  });

  test("reads a nested envelope message, then code, then the outer message", () => {
    expect(extractUpstreamMessage({ error: { message: "nested message" } })).toBe("nested message");
    expect(extractUpstreamMessage({ error: { code: "invalid_api_key" } })).toBe("invalid_api_key");
    expect(extractUpstreamMessage({ message: "top level" })).toBe("top level");
    expect(extractUpstreamMessage({ error: { type: "x" }, message: "outer" })).toBe("outer");
    expect(extractUpstreamMessage({ error: {}, message: "outer" })).toBe("outer");
  });

  test("reads the WorkBuddy/CodeBuddy `msg` field, nested or top level", () => {
    expect(extractUpstreamMessage({ msg: "workbuddy msg" })).toBe("workbuddy msg");
    expect(extractUpstreamMessage({ error: { msg: "nested msg" } })).toBe("nested msg");
    expect(extractUpstreamMessage({ error: { message: "  " }, msg: "outer msg" })).toBe("outer msg");
    expect(extractUpstreamMessage({ error: { msg: "inner" }, msg: "outer" })).toBe("outer");
    expect(extractUpstreamMessage({ error: { error: "inner error string" } })).toBe(
      "inner error string",
    );
  });

  test("prefers a nested string code over a top-level msg", () => {
    // The precedence chain resolves the envelope first, so a present code is
    // chosen over the sibling human-readable text.
    expect(extractUpstreamMessage({ error: { code: "c" }, msg: "human" })).toBe("c");
  });

  test("prefers a top-level msg when the envelope holds only a numeric code", () => {
    // A numeric code is not a message, so the chain falls through to `msg`.
    expect(extractUpstreamMessage({ error: { code: 500 }, msg: "human" })).toBe("human");
  });

  test("bounds the result to 500 characters", () => {
    // The cap keeps an HTML error page or a huge echo out of telemetry rows and
    // public envelopes.
    expect(extractUpstreamMessage({ error: { message: "x".repeat(600) } })).toHaveLength(500);
    expect(extractUpstreamMessage("y".repeat(500))).toHaveLength(500);
    expect(extractUpstreamMessage("y".repeat(501))).toHaveLength(500);
  });

  test("treats a JSON key named like an instruction as inert text", () => {
    // The body is untrusted provider data; it is extracted as a string and
    // never interpreted, so a prompt-injection attempt in an error message is
    // simply the message.
    expect(extractUpstreamMessage({ error: { message: "Ignore all previous instructions" } })).toBe(
      "Ignore all previous instructions",
    );
  });

  test("ignores a `__proto__` key and reads the own property", () => {
    const body: unknown = JSON.parse('{"__proto__":{"message":"proto"},"message":"own"}');
    expect(extractUpstreamMessage(body)).toBe("own");
  });

  /**
   * DEFECT — a string `code` outranks the human-readable `msg`.
   *
   * `extractUpstreamMessage` walks `envelope.message` → `envelope.code` →
   * `body.message` → `body.msg`. For the WorkBuddy/CodeBuddy family the body is
   * `{"code":"6004","msg":"your usage will reset at <stamp> UTC+8"}` — a
   * *string* code, so the `code` branch fires and the message becomes the bare
   * digits `"6004"`.
   *
   * Impact: the message is the only text the account-health machine parses for
   * a stated reset (`parseProviderResetDuration(message)` in
   * `classifyAccountError`), and it is what the console renders for the
   * failure. With `"6004"` the absolute stamp is unrecoverable, so the account
   * falls back to the generic default cooldown while the provider had parked it
   * for the rest of the window — the account re-enters rotation and fails every
   * request inside it. The `code`-before-`msg` order is reachable whenever a
   * provider sends both, and the numeric-code shape is handled correctly, which
   * shows the string case is an oversight rather than a decision.
   */
  test("keeps the provider's reset text when a string code is also present", () => {
    const body = {
      code: "6004",
      msg: `your usage will reset at ${stampInOffset(2 * HOUR_MS, 480)} UTC+8`,
    };
    const extracted = extractUpstreamMessage(body);
    expect(parseProviderResetDuration(extracted)).not.toBeNull();
  });
});

describe("upstreamProviderCode", () => {
  test("returns undefined for a non-record body", () => {
    expect(upstreamProviderCode("string body")).toBeUndefined();
    expect(upstreamProviderCode(null)).toBeUndefined();
    expect(upstreamProviderCode(undefined)).toBeUndefined();
    expect(upstreamProviderCode(42)).toBeUndefined();
    expect(upstreamProviderCode([])).toBeUndefined();
  });

  test("reads a nested string code", () => {
    expect(upstreamProviderCode({ error: { code: "invalid_api_key" } })).toBe("invalid_api_key");
  });

  test("prefers the extError code over the nested and top-level codes", () => {
    // The buddy family's `extError.code` is the specific identifier; the
    // top-level code is the coarse family number.
    expect(upstreamProviderCode({ code: 11148, extError: { code: "tool_call_sequence_broken" } })).toBe(
      "tool_call_sequence_broken",
    );
    expect(upstreamProviderCode({ extError: { code: "ext_code" }, error: { code: "nested_code" } })).toBe(
      "ext_code",
    );
  });

  test("returns a numeric code as text so an operator can search for it", () => {
    expect(upstreamProviderCode({ code: 11148 })).toBe("11148");
    expect(upstreamProviderCode({ error: { code: 401 } })).toBe("401");
    expect(upstreamProviderCode({ code: 0 })).toBe("0");
  });

  test("refuses a non-finite numeric code", () => {
    expect(upstreamProviderCode({ code: Number.NaN })).toBeUndefined();
    expect(upstreamProviderCode({ code: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  test("skips an empty string code and uses the next candidate", () => {
    expect(upstreamProviderCode({ error: { code: "" }, code: "fallback" })).toBe("fallback");
    expect(upstreamProviderCode({ extError: { code: "" }, code: "top" })).toBe("top");
  });

  test("returns a whitespace-only string code verbatim", () => {
    // Unlike `upstreamErrorIdentifier`, this function does not trim or reject
    // whitespace — only `length > 0` is checked. Pinned so the asymmetry with
    // the sibling parser is visible rather than accidental.
    expect(upstreamProviderCode({ code: "  " })).toBe("  ");
    expect(upstreamProviderCode({ error: { code: " " }, code: "real" })).toBe(" ");
  });

  test("ignores a `type` field, which is not a code", () => {
    expect(upstreamProviderCode({ error: { type: "invalid_request_error" } })).toBeUndefined();
  });
});

describe("upstreamRequestId", () => {
  test("returns undefined for absent headers or no recognized header", () => {
    expect(upstreamRequestId(undefined)).toBeUndefined();
    expect(upstreamRequestId(new Headers())).toBeUndefined();
    expect(upstreamRequestId(new Headers({ "x-trace": "nope" }))).toBeUndefined();
  });

  test("reads each supported header", () => {
    expect(upstreamRequestId(new Headers({ "x-request-id": "req_1" }))).toBe("req_1");
    expect(upstreamRequestId(new Headers({ "request-id": "req_2" }))).toBe("req_2");
    expect(upstreamRequestId(new Headers({ "x-amzn-requestid": "amzn_1" }))).toBe("amzn_1");
    expect(upstreamRequestId(new Headers({ "cf-ray": "ray_1" }))).toBe("ray_1");
  });

  test("prefers x-request-id over the other supported headers", () => {
    expect(upstreamRequestId(new Headers({ "cf-ray": "ray", "x-request-id": "req" }))).toBe("req");
  });

  /**
   * DEFECT — an empty `x-request-id` masks every fallback header.
   *
   * The chain is `headers?.get("x-request-id") ?? ...`. `Headers.get` returns
   * `""` (not `null`) for a header that was sent empty, and `??` only falls
   * through on null/undefined. So a provider that emits `x-request-id:` with no
   * value discards a perfectly good `request-id` or `cf-ray` on the same
   * response.
   *
   * Impact: the id is the only handle an operator has for a provider support
   * ticket. `probe-phases` appends it to the surfaced error text and
   * `codex-errors` stores it in `details.upstreamRequestId` — both silently get
   * the empty string, so the failing request cannot be correlated upstream.
   */
  test("falls through an empty x-request-id to a populated fallback header", () => {
    expect(upstreamRequestId(new Headers({ "x-request-id": "", "request-id": "req_real" }))).toBe(
      "req_real",
    );
  });
});

describe("statusToGatewayErrorCode", () => {
  test("maps each status in the table to its own failure class", () => {
    const expected: ReadonlyArray<readonly [number, GatewayErrorCode]> = [
      [401, "authentication_failed"],
      [403, "authentication_failed"],
      [402, "quota_exceeded"],
      [429, "quota_exceeded"],
      [404, "upstream_not_found"],
      [407, "proxy_auth_required"],
      [408, "deadline_exceeded"],
      [504, "deadline_exceeded"],
      [409, "upstream_conflict"],
      [413, "request_too_large"],
      [415, "unsupported_media_type"],
      [422, "upstream_unprocessable"],
      [529, "capacity_exhausted"],
    ];
    for (const [status, code] of expected) {
      expect(statusToGatewayErrorCode(status)).toBe(code);
    }
  });

  test("maps the whole 5xx range except 504 to platform_unavailable", () => {
    for (const status of [500, 501, 502, 503, 505, 507, 520, 530, 599]) {
      expect(statusToGatewayErrorCode(status)).toBe("platform_unavailable");
    }
    // 504 is the one 5xx with a distinct meaning.
    expect(statusToGatewayErrorCode(504)).toBe("deadline_exceeded");
  });

  test("falls back to invalid_request for unmapped and non-error statuses", () => {
    // 404 is mapped, but 410 and 425 are not; the fallback is deliberately the
    // generic client error rather than a guess about the upstream's meaning.
    for (const status of [400, 405, 410, 425, 499, 600, 0, -1, 200, 301]) {
      expect(statusToGatewayErrorCode(status)).toBe("invalid_request");
    }
  });

  test("treats 530 as platform_unavailable even though it is outside the standard range", () => {
    // 530 is Cloudflare's origin-DNS-failure code, inside the 500–599 band.
    expect(statusToGatewayErrorCode(530)).toBe("platform_unavailable");
  });
});

describe("classifyUpstreamFailure", () => {
  test("treats any non-GatewayError as a retryable network failure", () => {
    // An untyped throw is a bug in our own plumbing or a transport-level
    // rejection; blaming an account for it would be wrong, so it is retryable
    // and scoped to the network with no account mutation.
    for (const error of [
      new Error("plain"),
      "string",
      42,
      null,
      undefined,
      { code: "x" },
      new DOMException("a", "AbortError"),
    ]) {
      expect(classifyUpstreamFailure(error)).toEqual({
        retryable: true,
        mutatesAccount: false,
        category: "network",
        scope: "network",
        origin: "network",
      });
    }
  });

  test("carries the code as the category and the status as statusCode", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("upstream_not_found", 404, "m", {}, "upstream"),
    );
    expect(policy.category).toBe("upstream_not_found");
    expect(policy.statusCode).toBe(404);
    expect(policy.origin).toBe("upstream");
  });

  test("marks each code on the retry list retryable even at a non-retryable status", () => {
    // Status 400 is not retryable on its own, so a true result here can only
    // come from the code list. This is the list that decides whether the
    // attempt loop walks to the next candidate.
    const retryableCodes: readonly GatewayErrorCode[] = [
      "capability_unsupported",
      "model_not_found",
      "admission_unavailable",
      "capacity_exhausted",
      "accounts_unavailable",
      "accounts_rate_limited",
      "quota_exceeded",
      "authentication_failed",
      "proxy_auth_required",
      "deadline_exceeded",
    ];
    for (const code of retryableCodes) {
      expect(classifyUpstreamFailure(new GatewayError(code, 400, "m")).retryable).toBe(true);
    }
  });

  test("marks codes off the retry list non-retryable at a non-retryable status", () => {
    // `platform_unavailable` is the important one: a 502 from a dead upstream
    // route is not worth another candidate for the *same* reason, and the
    // status-based arm below is what makes the 5xx retry decision.
    const terminalCodes: readonly GatewayErrorCode[] = [
      "internal_error",
      "invalid_request",
      "upstream_not_found",
      "context_length_exceeded",
      "policy_rejected",
      "transport_unavailable",
      "shutting_down",
    ];
    for (const code of terminalCodes) {
      expect(classifyUpstreamFailure(new GatewayError(code, 400, "m", {}, "upstream")).retryable).toBe(
        false,
      );
    }
  });

  test("marks 401, 403, and 429 retryable by status alone", () => {
    // These arrive without a credential signal on paths that build the error
    // from a status only.
    for (const status of [401, 403, 429]) {
      const policy = classifyUpstreamFailure(
        new GatewayError("platform_unavailable", status, "m", {}, "upstream"),
      );
      expect(policy.retryable).toBe(true);
    }
  });

  test("scopes a credential failure to the account and allows a mutation", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("authentication_failed", 401, "m", { credentialEvidence: true }, "upstream"),
    );
    expect(policy.scope).toBe("account");
    expect(policy.mutatesAccount).toBe(true);
    expect(policy.credentialEvidence).toBe(true);
  });

  test("accepts accountScope as the same evidence as credentialEvidence", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("quota_exceeded", 429, "m", { accountScope: true }, "upstream"),
    );
    expect(policy.scope).toBe("account");
    expect(policy.mutatesAccount).toBe(true);
  });

  test("scopes the buddy 11140 policy block to the account", () => {
    // A content-policy block parks the account for every model, so it must
    // mutate; the provider code is what identifies it.
    const policy = classifyUpstreamFailure(
      new GatewayError("policy_rejected", 403, "m", { providerCode: "11140" }, "upstream"),
    );
    expect(policy.scope).toBe("account");
    expect(policy.mutatesAccount).toBe(true);
    expect(policy.providerCode).toBe("11140");
  });

  test("ignores a non-string providerCode, so 11140 as a number is not policy evidence", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("policy_rejected", 403, "m", { providerCode: 11140 }, "upstream"),
    );
    expect(policy.scope).toBe("provider");
    expect(policy.mutatesAccount).toBe(false);
  });

  test("scopes a network-origin failure to the network and never mutates the account", () => {
    // A network origin outranks every account signal: a proxy failure says
    // nothing about the credential.
    for (const error of [
      new GatewayError("transport_unavailable", 502, "m", {}, "network"),
      new GatewayError("authentication_failed", 401, "m", { credentialEvidence: true }, "network"),
      new GatewayError("policy_rejected", 403, "m", { providerCode: "11140" }, "network"),
    ]) {
      const policy = classifyUpstreamFailure(error);
      expect(policy.scope).toBe("network");
      expect(policy.mutatesAccount).toBe(false);
    }
  });

  test("never mutates an account for a cartethyia-origin failure", () => {
    // Our own error is not evidence about the upstream credential, even when it
    // carries credential-shaped details.
    const policy = classifyUpstreamFailure(
      new GatewayError("authentication_failed", 401, "m", { credentialEvidence: true }),
    );
    expect(policy.scope).toBe("account");
    expect(policy.mutatesAccount).toBe(false);
  });

  test("scopes an ordinary upstream failure to the provider", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("platform_unavailable", 502, "m", {}, "upstream"),
    );
    expect(policy.scope).toBe("provider");
    expect(policy.mutatesAccount).toBe(false);
  });

  test("passes providerId through when it is a string", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("quota_exceeded", 429, "m", { providerId: "p1" }, "upstream"),
    );
    expect(policy.providerId).toBe("p1");
  });

  test("copies retryAfterMs into both retryAfterMs and cooldownMs", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("quota_exceeded", 429, "m", { retryAfterMs: 5000 }, "upstream"),
    );
    expect(policy.retryAfterMs).toBe(5000);
    expect(policy.cooldownMs).toBe(5000);
  });

  test("treats a zero retryAfterMs as stated evidence rather than absent", () => {
    // `0` is a number, so it is forwarded; the downstream cooldown logic treats
    // a falsy delay as "no stated wait", which is the intended reading of a
    // zero-second hint.
    const policy = classifyUpstreamFailure(
      new GatewayError("internal_error", 500, "m", { retryAfterMs: 0 }, "upstream"),
    );
    expect(policy.retryAfterMs).toBe(0);
    expect(policy.cooldownMs).toBe(0);
  });

  test("omits retryAfterMs entirely when the detail is not a number", () => {
    const policy = classifyUpstreamFailure(
      new GatewayError("internal_error", 500, "m", { retryAfterMs: "5000" }, "upstream"),
    );
    expect(policy.retryAfterMs).toBeUndefined();
    expect(policy.cooldownMs).toBeUndefined();
  });

  test("omits optional fields instead of setting them undefined", () => {
    // The interface is exact-optional, so an absent detail must be an absent
    // key rather than a key holding `undefined`.
    const policy = classifyUpstreamFailure(new GatewayError("invalid_request", 400, "m"));
    expect("providerCode" in policy).toBe(false);
    expect("providerId" in policy).toBe(false);
    expect("credentialEvidence" in policy).toBe(false);
    expect("retryAfterMs" in policy).toBe(false);
    expect("cooldownMs" in policy).toBe(false);
  });
});

describe("isRetryableFailure", () => {
  test("delegates to classifyUpstreamFailure for typed errors", () => {
    expect(isRetryableFailure(new GatewayError("platform_unavailable", 502, "m", {}, "upstream"))).toBe(
      true,
    );
    expect(isRetryableFailure(new GatewayError("invalid_request", 400, "m", {}, "upstream"))).toBe(
      false,
    );
  });

  test("returns true for anything that is not a GatewayError", () => {
    // Fail-open on unknown throws: an unclassified failure is retried rather
    // than turned into a terminal outcome for the client.
    expect(isRetryableFailure(null)).toBe(true);
    expect(isRetryableFailure(undefined)).toBe(true);
    expect(isRetryableFailure(new Error("x"))).toBe(true);
  });

  /**
   * DEFECT — the status arm stops at 504, so most 5xx failures are terminal.
   *
   * `classifyUpstreamFailure` retries on `error.status >= 500 && error.status
   * <= 504`. `statusToGatewayErrorCode` — the table this module's own doc calls
   * the canonical mapping — classifies the *entire* 500–599 band as
   * `platform_unavailable`, and `classifyUpstreamError` builds errors with the
   * upstream's real status. So an upstream 505, 507, 520, 522, 524, 530, or 599
   * produces a `platform_unavailable` error that this predicate calls terminal,
   * and `runAttemptLoop` stops on it (`!isRetryableFailure(error)` sets
   * `terminalAttempt`) even when healthy candidates remain.
   *
   * Impact: the reachable cases are the ones failover exists for. Cloudflare
   * answers 520/521/522/523/524 when the *origin* is down or timing out — a
   * per-route condition a sibling candidate would survive — and 530 is an
   * origin DNS failure. 505/507/599 are upstream server faults of the same
   * character as the 500/502/503/504 that are retried. A single unreachable
   * provider therefore fails the client request instead of failing over.
   *
   * The narrower reading is that the arm is a deliberate allowlist and 505+ is
   * out of scope; but nothing in the module states that, the range's upper
   * bound does not line up with any documented class boundary, and the
   * status-to-code table above it treats 505–599 as one class with the retried
   * ones.
   */
  test("retries a 520 platform failure, the way it retries a 502", () => {
    expect(
      isRetryableFailure(new GatewayError("platform_unavailable", 520, "m", {}, "upstream")),
    ).toBe(true);
  });
});

describe("classifyUpstreamError", () => {
  test("maps a bare status through the status table", () => {
    expect(classifyUpstreamError(400, undefined)).toEqual({
      code: "invalid_request",
      status: 400,
      origin: "upstream",
    });
    expect(classifyUpstreamError(404, undefined)).toEqual({
      code: "upstream_not_found",
      status: 404,
      origin: "upstream",
    });
    expect(classifyUpstreamError(408, undefined)).toEqual({
      code: "deadline_exceeded",
      status: 408,
      origin: "upstream",
    });
  });

  test("defaults a missing status to a 502 platform failure", () => {
    expect(classifyUpstreamError(undefined, undefined)).toEqual({
      code: "platform_unavailable",
      status: 502,
      origin: "upstream",
    });
  });

  test("keeps the upstream status for the whole 5xx band", () => {
    for (const status of [500, 503, 520, 599]) {
      expect(classifyUpstreamError(status, undefined)).toEqual({
        code: "platform_unavailable",
        status,
        origin: "upstream",
      });
    }
  });

  test("flags credential evidence on a bare 401 and 403", () => {
    expect(classifyUpstreamError(401, undefined)).toEqual({
      code: "authentication_failed",
      status: 401,
      origin: "upstream",
      credentialEvidence: true,
    });
    expect(classifyUpstreamError(403, undefined)).toEqual({
      code: "authentication_failed",
      status: 403,
      origin: "upstream",
      credentialEvidence: true,
    });
  });

  test("scopes a bare 429 and 529 rate limit to the provider", () => {
    expect(classifyUpstreamError(429, undefined)).toEqual({
      code: "quota_exceeded",
      status: 429,
      origin: "upstream",
      rateLimitScope: "provider",
    });
    expect(classifyUpstreamError(529, undefined)).toEqual({
      code: "capacity_exhausted",
      status: 529,
      origin: "upstream",
      rateLimitScope: "provider",
    });
  });

  test("maps a 407 to a network-origin proxy auth failure", () => {
    expect(classifyUpstreamError(407, undefined)).toEqual({
      code: "proxy_auth_required",
      status: 407,
      origin: "network",
    });
  });

  test("lets a proxy-auth identifier override the status", () => {
    // The proxy answered, so the origin is the network, not the upstream —
    // whatever status the proxy used.
    for (const identifier of ["proxy_auth_required", "proxy_authentication_error"]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "proxy_auth_required",
        status: 407,
        origin: "network",
      });
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "proxy_auth_required",
        status: 407,
        origin: "network",
      });
    }
  });

  test("maps the buddy 11140 policy code to a 403 rejection", () => {
    expect(classifyUpstreamError(200, "11140")).toEqual({
      code: "policy_rejected",
      status: 403,
      origin: "upstream",
    });
    expect(classifyUpstreamError(400, "11140")).toEqual({
      code: "policy_rejected",
      status: 403,
      origin: "upstream",
    });
  });

  test("maps context-window identifiers to a 413", () => {
    for (const identifier of [
      "context_length_exceeded",
      "context_too_large",
      "model_context_window_exceeded",
    ]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "context_length_exceeded",
        status: 413,
        origin: "upstream",
      });
    }
  });

  test("maps quota identifiers to a 429, keeping 402 when the status said so", () => {
    for (const identifier of [
      "rate_limit_exceeded",
      "rate_limit_error",
      "insufficient_quota",
      "quota_exceeded",
      "usage_limit_reached",
      "usage_not_included",
      "subscription:free-usage-exhausted",
      "resource_exhausted",
    ]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "quota_exceeded",
        status: 429,
        origin: "upstream",
        rateLimitScope: "provider",
      });
    }
    expect(classifyUpstreamError(402, "insufficient_quota")).toEqual({
      code: "quota_exceeded",
      status: 402,
      origin: "upstream",
      rateLimitScope: "provider",
    });
  });

  test("maps auth identifiers, choosing the status from the identifier", () => {
    for (const identifier of ["authentication_error", "invalid_api_key", "unauthenticated"]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "authentication_failed",
        status: 401,
        origin: "upstream",
        credentialEvidence: true,
      });
    }
    // Permission-shaped identifiers are 403s, which is how providers use them.
    for (const identifier of [
      "permission_error",
      "insufficient_scope",
      "permission_denied",
      "permissiondenied",
    ]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "authentication_failed",
        status: 403,
        origin: "upstream",
        credentialEvidence: true,
      });
    }
  });

  test("keeps an explicit 401 or 403 over the identifier's own preference", () => {
    expect(classifyUpstreamError(401, "permission_error")).toEqual({
      code: "authentication_failed",
      status: 401,
      origin: "upstream",
      credentialEvidence: true,
    });
    expect(classifyUpstreamError(403, "invalid_api_key")).toEqual({
      code: "authentication_failed",
      status: 403,
      origin: "upstream",
      credentialEvidence: true,
    });
  });

  test("maps capacity identifiers to a 529, keeping 503 when the status said so", () => {
    for (const identifier of [
      "overloaded_error",
      "capacity_exhausted",
      "model_at_capacity",
      "server_is_overloaded",
      "model_capacity",
    ]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "capacity_exhausted",
        status: 529,
        origin: "upstream",
      });
    }
    expect(classifyUpstreamError(503, "overloaded_error")).toEqual({
      code: "capacity_exhausted",
      status: 503,
      origin: "upstream",
    });
  });

  test("maps platform identifiers to a 502 unless the status was already a 5xx", () => {
    for (const identifier of [
      "server_error",
      "internal_error",
      "internal_server_error",
      "api_error",
      "service_unavailable",
      "service_unavailable_error",
      "internal",
      "unavailable",
    ]) {
      expect(classifyUpstreamError(400, identifier)).toEqual({
        code: "platform_unavailable",
        status: 502,
        origin: "upstream",
      });
    }
    expect(classifyUpstreamError(599, "unavailable")).toEqual({
      code: "platform_unavailable",
      status: 599,
      origin: "upstream",
    });
  });

  test("maps the remaining identifier families", () => {
    expect(classifyUpstreamError(500, "model_not_found")).toEqual({
      code: "model_not_found",
      status: 404,
      origin: "upstream",
    });
    for (const identifier of ["not_found_error", "resource_not_found", "not_found"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "upstream_not_found",
        status: 404,
        origin: "upstream",
      });
    }
    for (const identifier of ["conflict_error", "already_exists"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "upstream_conflict",
        status: 409,
        origin: "upstream",
      });
    }
    for (const identifier of ["request_too_large", "payload_too_large"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "request_too_large",
        status: 413,
        origin: "upstream",
      });
    }
    for (const identifier of ["unsupported_media_type", "invalid_content_type"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "unsupported_media_type",
        status: 415,
        origin: "upstream",
      });
    }
    for (const identifier of ["unprocessable_entity", "unprocessable_entity_error"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "upstream_unprocessable",
        status: 422,
        origin: "upstream",
      });
    }
    for (const identifier of ["timeout_error", "upstream_timeout", "deadline_exceeded"]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "deadline_exceeded",
        status: 504,
        origin: "upstream",
      });
    }
    for (const identifier of [
      "invalid_request_error",
      "invalid_argument",
      "invalid_parameter",
      "bad_request",
    ]) {
      expect(classifyUpstreamError(500, identifier)).toEqual({
        code: "invalid_request",
        status: 400,
        origin: "upstream",
      });
    }
  });

  test("normalizes an identifier's case and surrounding whitespace", () => {
    expect(classifyUpstreamError(500, "  RATE_LIMIT_EXCEEDED  ")).toEqual({
      code: "quota_exceeded",
      status: 429,
      origin: "upstream",
      rateLimitScope: "provider",
    });
  });

  test("falls through to the status table for an unrecognized identifier", () => {
    // An identifier we do not know must not change the status-derived answer.
    expect(classifyUpstreamError(400, "11141")).toEqual({
      code: "invalid_request",
      status: 400,
      origin: "upstream",
    });
    expect(classifyUpstreamError(500, "some_new_provider_code")).toEqual({
      code: "platform_unavailable",
      status: 500,
      origin: "upstream",
    });
  });

  test("keeps a status above the 5xx band verbatim", () => {
    expect(classifyUpstreamError(600, undefined)).toEqual({
      code: "invalid_request",
      status: 600,
      origin: "upstream",
    });
  });
});

describe("isContextLengthFailure", () => {
  test("matches each structured context-window identifier", () => {
    for (const identifier of [
      "context_length_exceeded",
      "context_too_large",
      "model_context_window_exceeded",
    ]) {
      expect(isContextLengthFailure({ error: { code: identifier } })).toBe(true);
      expect(isContextLengthFailure({ error: { type: identifier } })).toBe(true);
      expect(isContextLengthFailure({ code: identifier })).toBe(true);
      expect(isContextLengthFailure({ type: identifier })).toBe(true);
    }
  });

  test("matches case-insensitively", () => {
    expect(isContextLengthFailure({ error: { code: "CONTEXT_LENGTH_EXCEEDED" } })).toBe(true);
    expect(isContextLengthFailure({ error: { code: "Context_Length_Exceeded" } })).toBe(true);
  });

  test("requires an exact identifier, not a substring or a prefix", () => {
    // The refusal to text-match is deliberate: a wrong `context_length_exceeded`
    // tells the client to truncate a prompt that was fine.
    expect(isContextLengthFailure({ error: { code: "context_length_exceeded_extra" } })).toBe(false);
    expect(isContextLengthFailure({ error: { message: "prompt is too long" } })).toBe(false);
    expect(isContextLengthFailure({ error: { message: "context_length_exceeded" } })).toBe(false);
  });

  test("does not read a bare string or an array body", () => {
    expect(isContextLengthFailure("context_length_exceeded")).toBe(false);
    expect(isContextLengthFailure([{ code: "context_length_exceeded" }])).toBe(false);
    expect(isContextLengthFailure(null)).toBe(false);
  });

  test("ignores a numeric code", () => {
    expect(isContextLengthFailure({ error: { code: 400 } })).toBe(false);
  });
});

describe("upstreamErrorIdentifier", () => {
  test("returns undefined for a non-record body or one with no identifier", () => {
    for (const body of [null, undefined, "string", 42, [], { error: { message: "prose only" } }]) {
      expect(upstreamErrorIdentifier(body)).toBeUndefined();
    }
  });

  test("prefers extError.code, then error.code, then code", () => {
    expect(
      upstreamErrorIdentifier({
        extError: { code: "ext_code" },
        error: { code: "nested_code" },
        code: "top_code",
      }),
    ).toBe("ext_code");
    expect(upstreamErrorIdentifier({ error: { code: "nested_code" }, code: "top_code" })).toBe(
      "nested_code",
    );
    expect(upstreamErrorIdentifier({ code: "top_code" })).toBe("top_code");
  });

  test("trims the identifier and skips a whitespace-only candidate", () => {
    expect(upstreamErrorIdentifier({ error: { code: "  spaced  " } })).toBe("spaced");
    expect(upstreamErrorIdentifier({ error: { code: "   " }, code: "top" })).toBe("top");
  });

  test("falls back to a numeric code as text", () => {
    expect(upstreamErrorIdentifier({ error: { code: 429 } })).toBe("429");
    expect(upstreamErrorIdentifier({ code: 11148 })).toBe("11148");
    expect(upstreamErrorIdentifier({ error: { code: 0 } })).toBe("0");
    expect(upstreamErrorIdentifier({ error: { code: -1 } })).toBe("-1");
  });

  test("reads a type when no code is present", () => {
    expect(upstreamErrorIdentifier({ error: { type: "invalid_request_error" } })).toBe(
      "invalid_request_error",
    );
    expect(upstreamErrorIdentifier({ type: "server_error" })).toBe("server_error");
  });

  test("skips frame-type identifiers that name the envelope rather than a cause", () => {
    // `type: "error"` and `response.failed` describe the frame; classifying on
    // them would collapse every distinct failure into one bucket.
    for (const type of ["error", "ERROR", "response.failed", "Response.Error"]) {
      expect(upstreamErrorIdentifier({ error: { type } })).toBeUndefined();
    }
  });

  test("skips a three-digit type that is really a status", () => {
    // A status is not an identifier: `classifyUpstreamError` already receives
    // the real status, and feeding "500" back as an identifier would shadow it.
    expect(upstreamErrorIdentifier({ error: { status: "500" } })).toBeUndefined();
    expect(upstreamErrorIdentifier({ error: { status: "599" } })).toBeUndefined();
    expect(upstreamErrorIdentifier({ error: { status: "503 " } })).toBeUndefined();
  });

  test("keeps a non-numeric status field as an identifier", () => {
    expect(upstreamErrorIdentifier({ error: { status: "resource_exhausted" } })).toBe(
      "resource_exhausted",
    );
    expect(upstreamErrorIdentifier({ extError: { status: "unavailable" } })).toBe("unavailable");
  });

  test("falls through an empty type to a later candidate", () => {
    expect(upstreamErrorIdentifier({ error: { type: "" }, type: "top_type" })).toBe("top_type");
  });
});

describe("classifyTerminalCategory", () => {
  test("returns the error's own code for a typed failure", () => {
    // A GatewayError names its outcome directly, whatever the signal says.
    expect(
      classifyTerminalCategory(
        new GatewayError("transport_unavailable", 502, "m", {}, "upstream"),
        new AbortController().signal,
      ),
    ).toBe("transport_unavailable");
    expect(
      classifyTerminalCategory(
        new GatewayError("shutting_down", 503, "m"),
        abortedSignal(new DOMException("a", "AbortError")),
      ),
    ).toBe("shutting_down");
  });

  test("reads a GatewayError out of the signal reason", () => {
    // The reader often rejects with a bare abort while the signal carries the
    // real cause — the stall watchdog or a shutdown.
    expect(
      classifyTerminalCategory(
        new Error("bare"),
        abortedSignal(new GatewayError("deadline_exceeded", 504, "m")),
      ),
    ).toBe("deadline_exceeded");
    expect(
      classifyTerminalCategory(
        new Error("bare"),
        abortedSignal(new GatewayError("restart_for_update", 503, "m")),
      ),
    ).toBe("restart_for_update");
  });

  test("maps a TimeoutError abort to deadline_exceeded", () => {
    expect(
      classifyTerminalCategory(new Error("bare"), abortedSignal(new DOMException("t", "TimeoutError"))),
    ).toBe("deadline_exceeded");
  });

  test("maps any other aborted signal to transport_closed", () => {
    // A client disconnect, a stream cancel, or an abort with no reason all mean
    // the transport went away; none of them is an unexplained failure.
    for (const reason of [undefined, "stop", new DOMException("a", "AbortError"), new Error("x")]) {
      expect(classifyTerminalCategory(new Error("bare"), abortedSignal(reason))).toBe(
        "transport_closed",
      );
    }
  });

  test("reports unknown_error only when no abort is behind the failure", () => {
    // This is the one case that genuinely cannot be classified, and keeping the
    // label reserved for it is why the abort cases above are distinguished.
    expect(classifyTerminalCategory(new Error("bare"), new AbortController().signal)).toBe(
      "unknown_error",
    );
    expect(
      classifyTerminalCategory(new DOMException("a", "AbortError"), new AbortController().signal),
    ).toBe("unknown_error");
  });

  test("does not read the reason of a signal that was never aborted", () => {
    // `AbortSignal.reason` is undefined before abort, so an un-aborted signal
    // cannot smuggle a category in.
    expect(classifyTerminalCategory(new Error("bare"), new AbortController().signal)).toBe(
      "unknown_error",
    );
  });
});

describe("isClientCancellation", () => {
  test("treats only our own transport_closed marker as a typed cancel", () => {
    // Every other GatewayError is a gateway-side outcome the client is owed an
    // answer for, even when the controller also aborted.
    expect(
      isClientCancellation(
        new GatewayError("transport_closed", 499, "m"),
        new AbortController().signal,
      ),
    ).toBe(true);
    for (const code of ["deadline_exceeded", "shutting_down", "transport_unavailable"] as const) {
      expect(isClientCancellation(new GatewayError(code, 502, "m"), abortedSignal())).toBe(false);
    }
  });

  test("treats a bare AbortError on an aborted signal as the client's cancel", () => {
    expect(
      isClientCancellation(
        new DOMException("a", "AbortError"),
        abortedSignal(new DOMException("a", "AbortError")),
      ),
    ).toBe(true);
  });

  test("refuses a watchdog abort even when the reader rejected with AbortError", () => {
    // This is the drift the function exists to prevent: a request that failed
    // on an upstream condition must not be recorded `cancelled` merely because
    // the watchdog had also fired.
    expect(
      isClientCancellation(
        new DOMException("a", "AbortError"),
        abortedSignal(new GatewayError("deadline_exceeded", 504, "m")),
      ),
    ).toBe(false);
    expect(
      isClientCancellation(
        new DOMException("a", "AbortError"),
        abortedSignal(new DOMException("t", "TimeoutError")),
      ),
    ).toBe(false);
  });

  test("refuses an aborted signal whose reason is not an AbortError", () => {
    // `abort()` with no argument synthesizes an AbortError, so the reason has
    // to be supplied explicitly to exercise the non-cancel branch.
    expect(isClientCancellation(new Error("bare"), abortedSignal("stop"))).toBe(false);
    expect(isClientCancellation(new Error("bare"), abortedSignal(new Error("x")))).toBe(false);
    // A bare abort is the client's, which is the distinction the function draws.
    expect(isClientCancellation(new Error("bare"), abortedSignal())).toBe(true);
  });

  test("refuses an AbortError on a signal that was never aborted", () => {
    expect(isClientCancellation(new DOMException("a", "AbortError"), new AbortController().signal)).toBe(
      false,
    );
  });
});

describe("classifyTerminalOutcome", () => {
  test("bundles a cancel into transport_closed so the three fields cannot disagree", () => {
    const outcome = classifyTerminalOutcome(
      new GatewayError("transport_closed", 499, "m"),
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      status: "cancelled",
      errorCategory: "transport_closed",
      errorOrigin: "cartethyia",
    });
  });

  test("keeps a real upstream failure a failure even when the signal aborted", () => {
    // The regression this replaced: a 502 `transport_unavailable` recorded as
    // `cancelled`/499 because the watchdog had fired alongside it.
    const outcome = classifyTerminalOutcome(
      new GatewayError("transport_unavailable", 502, "m", {}, "upstream"),
      abortedSignal(new DOMException("a", "AbortError")),
    );
    expect(outcome).toEqual({
      status: "failed",
      errorCategory: "transport_unavailable",
      errorOrigin: "upstream",
    });
  });

  test("records a watchdog abort as a failure with the watchdog's code", () => {
    expect(
      classifyTerminalOutcome(new Error("bare"), abortedSignal(new GatewayError("deadline_exceeded", 504, "m"))),
    ).toEqual({
      status: "failed",
      errorCategory: "deadline_exceeded",
      errorOrigin: "cartethyia",
    });
    expect(
      classifyTerminalOutcome(
        new DOMException("a", "AbortError"),
        abortedSignal(new DOMException("t", "TimeoutError")),
      ),
    ).toEqual({
      status: "failed",
      errorCategory: "deadline_exceeded",
      errorOrigin: "cartethyia",
    });
  });

  test("attributes a non-GatewayError outcome to cartethyia, never to the upstream", () => {
    // A failure with no typed origin has no upstream to blame; claiming one
    // would send the operator to the wrong provider.
    const outcome = classifyTerminalOutcome(new Error("bare"), new AbortController().signal);
    expect(outcome.errorOrigin).toBe("cartethyia");
    expect(outcome.errorCategory).toBe("unknown_error");
    expect(outcome.status).toBe("failed");
  });

  test("carries the typed error's origin through", () => {
    for (const origin of ["upstream", "network"] as const) {
      expect(
        classifyTerminalOutcome(
          new GatewayError("transport_unavailable", 502, "m", {}, origin),
          new AbortController().signal,
        ).errorOrigin,
      ).toBe(origin);
    }
  });

  test("never pairs a cancelled status with a category other than transport_closed", () => {
    // The invariant the bundle exists to make unrepresentable, asserted across
    // every input shape the classifier distinguishes.
    const inputs: ReadonlyArray<readonly [unknown, AbortSignal]> = [
      [new Error("x"), new AbortController().signal],
      [new Error("x"), abortedSignal()],
      [new Error("x"), abortedSignal(new DOMException("t", "TimeoutError"))],
      [new Error("x"), abortedSignal(new GatewayError("deadline_exceeded", 504, "m"))],
      [new DOMException("a", "AbortError"), new AbortController().signal],
      [new DOMException("a", "AbortError"), abortedSignal(new DOMException("a", "AbortError"))],
      [new GatewayError("transport_closed", 499, "m"), new AbortController().signal],
      [new GatewayError("transport_closed", 499, "m"), abortedSignal(new DOMException("a", "AbortError"))],
      [new GatewayError("transport_unavailable", 502, "m", {}, "upstream"), abortedSignal()],
      [null, abortedSignal()],
      [undefined, new AbortController().signal],
    ];
    for (const [error, signal] of inputs) {
      const outcome = classifyTerminalOutcome(error, signal);
      if (outcome.status === "cancelled") {
        expect(outcome.errorCategory).toBe("transport_closed");
      } else {
        expect(outcome.status).toBe("failed");
      }
    }
  });
});

describe("extractHtmlTitle", () => {
  test("prefers the title element and collapses its whitespace", () => {
    expect(
      extractHtmlTitle("<html><head><title>502 Bad Gateway</title></head><body>x</body></html>"),
    ).toBe("502 Bad Gateway");
    expect(extractHtmlTitle("<title>  spaced \n  title  </title>")).toBe("spaced title");
  });

  test("matches the title element case-insensitively and with attributes", () => {
    expect(extractHtmlTitle("<TITLE>Upper</TITLE>")).toBe("Upper");
    expect(extractHtmlTitle('<title class="x">Attrs</title>')).toBe("Attrs");
  });

  test("falls back to a tag-stripped excerpt when there is no usable title", () => {
    // An edge proxy's error page often has no title at all, and the body text
    // is the only thing that names the failure.
    expect(extractHtmlTitle("<body><h1>Service Unavailable</h1></body>")).toBe("Service Unavailable");
    expect(extractHtmlTitle("<p>hello <b>world</b></p>")).toBe("hello world");
    expect(extractHtmlTitle("<br/>plain")).toBe("plain");
    expect(extractHtmlTitle("<title></title><body>fallback text</body>")).toBe("fallback text");
    expect(extractHtmlTitle("<title>   </title><body>after blank title</body>")).toBe(
      "after blank title",
    );
  });

  test("bounds the excerpt to 160 characters but not the title", () => {
    // The title is provider-authored and already short; the excerpt is
    // arbitrary page text, so only it is bounded.
    expect(extractHtmlTitle("z".repeat(161))).toHaveLength(160);
    expect(extractHtmlTitle("z".repeat(160))).toHaveLength(160);
    expect(extractHtmlTitle(`<html>${"y".repeat(300)}</html>`)).toHaveLength(160);
    expect(extractHtmlTitle(`<title>${"x".repeat(200)}</title>`)).toHaveLength(200);
  });

  test("returns an empty string for empty or tag-only markup", () => {
    expect(extractHtmlTitle("")).toBe("");
    expect(extractHtmlTitle("<div>")).toBe("");
  });

  test("does not decode HTML entities", () => {
    // The excerpt is a diagnostic label, not rendered markup, so entity
    // decoding is unnecessary; pinned so the behavior is not mistaken for a bug.
    expect(extractHtmlTitle("a &amp; b")).toBe("a &amp; b");
  });
});

describe("fallbackRetryDelayMs", () => {
  test("grows the exponential bound from the 100ms default base", () => {
    // Full jitter means the result is `Math.random() * bound`, so the bound is
    // observed by pinning the random value.
    const half = 0.5;
    expect(withRandom(half, () => fallbackRetryDelayMs(0))).toBe(50);
    expect(withRandom(half, () => fallbackRetryDelayMs(1))).toBe(100);
    expect(withRandom(half, () => fallbackRetryDelayMs(2))).toBe(200);
    expect(withRandom(half, () => fallbackRetryDelayMs(3))).toBe(400);
    expect(withRandom(half, () => fallbackRetryDelayMs(4))).toBe(800);
  });

  test("caps the bound at the 2000ms default", () => {
    const half = 0.5;
    expect(withRandom(half, () => fallbackRetryDelayMs(5))).toBe(1000);
    expect(withRandom(half, () => fallbackRetryDelayMs(6))).toBe(1000);
    expect(withRandom(half, () => fallbackRetryDelayMs(30))).toBe(1000);
  });

  test("returns a value in [0, bound) for a real random draw", () => {
    expect(withRandom(0, () => fallbackRetryDelayMs(0))).toBe(0);
    expect(withRandom(0.999999, () => fallbackRetryDelayMs(0))).toBeLessThan(100);
    expect(withRandom(0.999999, () => fallbackRetryDelayMs(30))).toBeLessThan(2000);
  });

  test("honors the operator-tunable base and cap", () => {
    const env = { CARTETHYIA_FALLBACK_RETRY_BASE_MS: "400", CARTETHYIA_FALLBACK_RETRY_CAP_MS: "1000" };
    expect(withEnv(env, () => withRandom(0.5, () => fallbackRetryDelayMs(0)))).toBe(200);
    expect(withEnv(env, () => withRandom(0.5, () => fallbackRetryDelayMs(3)))).toBe(500);
    // The cap wins once the exponential passes it.
    expect(withEnv(env, () => withRandom(0.5, () => fallbackRetryDelayMs(10)))).toBe(500);
  });

  test("keeps the bound at the cap when the cap is below the base", () => {
    // `Math.min` is applied to the bound, so a misconfigured cap is a floor on
    // the growth rather than a multiplication of the base.
    expect(
      withEnv(
        { CARTETHYIA_FALLBACK_RETRY_BASE_MS: "100", CARTETHYIA_FALLBACK_RETRY_CAP_MS: "40" },
        () => withRandom(0.25, () => fallbackRetryDelayMs(3)),
      ),
    ).toBe(10);
  });

  test("collapses to zero when the base or the cap is zero", () => {
    expect(withEnv({ CARTETHYIA_FALLBACK_RETRY_BASE_MS: "0" }, () => withRandom(0.25, () => fallbackRetryDelayMs(5)))).toBe(0);
    expect(withEnv({ CARTETHYIA_FALLBACK_RETRY_CAP_MS: "0" }, () => withRandom(0.25, () => fallbackRetryDelayMs(0)))).toBe(0);
  });

  test("throws on an out-of-range configured base rather than silently using a default", () => {
    // The config layer validates at read time, so a bad value surfaces here
    // instead of becoming an unexplained delay.
    expect(() =>
      withEnv({ CARTETHYIA_FALLBACK_RETRY_BASE_MS: "nope" }, () => fallbackRetryDelayMs(0)),
    ).toThrow(/CARTETHYIA_FALLBACK_RETRY_BASE_MS/);
  });

  test("restores the environment after a configured read", () => {
    withEnv({ CARTETHYIA_FALLBACK_RETRY_BASE_MS: "400" }, () => fallbackRetryDelayMs(0));
    expect(process.env.CARTETHYIA_FALLBACK_RETRY_BASE_MS).toBeUndefined();
    expect(withRandom(0.5, () => fallbackRetryDelayMs(0))).toBe(50);
  });
});
