/**
 * Quota presentation: the strings an operator reads on an account card.
 *
 * These are pure formatters, but they sit between a provider's numbers and an
 * operator's decision to top up, re-login, or wait. Three properties carry that
 * weight:
 *
 * 1. **A reset distance must not read as a measurement it is not.** The
 *    formatter picks a unit from a magnitude, so the interesting cases are the
 *    boundaries between minutes/hours/days/months/years, and the two states that
 *    are not a duration at all: already elapsed, and unparseable.
 * 2. **`null` and `0` are different.** `quotaBarTone(null)` is the "no quota
 *    reported" tone and `quotaBarTone(0)` is the red one. Conflating them paints
 *    an exhausted account grey, which is the opposite of what an operator needs
 *    to see.
 * 3. **A raw provider error must not reach the operator.** `friendlyQuotaError`
 *    maps a provider's own wording to an action; an unmapped string falls back to
 *    a generic sentence rather than showing the raw text, which can carry an
 *    account id or an upstream URL.
 *
 * `formatResetDistance` reads `Date.now()`, so those tests compute their
 * expectation from the same instant rather than hard-coding a duration.
 */
import { describe, expect, test } from "bun:test";
import {
  accountIdentity,
  displayAccountHint,
  formatQuotaRefresh,
  formatQuotaWindowLabel,
  formatResetDistance,
  friendlyQuotaError,
  paginateQuotaWindows,
  quotaBarTone,
  QUOTA_WINDOWS_PER_PAGE,
} from "../../src/shared/quota-formatters";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO instant `ms` from now, so the formatter's own clock is the reference. */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("formatResetDistance", () => {
  test("no value produces an empty string", () => {
    // The card renders nothing rather than "Resets in NaN" for a provider that
    // reports no reset instant.
    expect(formatResetDistance(null)).toBe("");
    expect(formatResetDistance("")).toBe("");
  });

  test("an already-elapsed instant reports the recurring wording", () => {
    // A quota whose reset instant is in the past is about to roll over; calling it
    // "Expired" would send the operator to re-authenticate a healthy account.
    expect(formatResetDistance(fromNow(-HOUR))).toBe("Resetting soon");
    expect(formatResetDistance(fromNow(-HOUR), false)).toBe("Expired");
  });

  test("an unparseable value is treated as elapsed, not as a duration", () => {
    // `new Date("garbage").getTime()` is NaN, and the `Number.isFinite` check
    // catches it. Without it the formatter would render "Resets in NaNmins".
    expect(formatResetDistance("garbage")).toBe("Resetting soon");
    expect(formatResetDistance("garbage", false)).toBe("Expired");
  });

  test("the prefix follows the recurring flag", () => {
    // A recurring quota resets; a one-off grant expires. The two read differently
    // to an operator deciding whether the account is still usable.
    expect(formatResetDistance(fromNow(30 * MINUTE))).toBe("Resets in 30mins");
    expect(formatResetDistance(fromNow(30 * MINUTE), false)).toBe("Expires in 30mins");
  });

  test("under an hour is reported in minutes", () => {
    expect(formatResetDistance(fromNow(1 * MINUTE))).toBe("Resets in 1mins");
    expect(formatResetDistance(fromNow(59 * MINUTE))).toBe("Resets in 59mins");
    // The boundary: 60 minutes becomes an hour.
    expect(formatResetDistance(fromNow(60 * MINUTE))).toBe("Resets in 1h");
  });

  test("minutes are rounded UP so a partial minute is not reported as zero", () => {
    // `Math.ceil` is what stops "Resets in 0mins" for an instant 30 seconds away.
    // Pinned because `Math.floor` would produce exactly that.
    expect(formatResetDistance(fromNow(30_000))).toBe("Resets in 1mins");
    expect(formatResetDistance(fromNow(1))).toBe("Resets in 1mins");
  });

  test("between an hour and a day is reported in hours, with minutes when present", () => {
    expect(formatResetDistance(fromNow(HOUR))).toBe("Resets in 1h");
    expect(formatResetDistance(fromNow(HOUR + 30 * MINUTE))).toBe("Resets in 1h 30mins");
    expect(formatResetDistance(fromNow(23 * HOUR + 59 * MINUTE))).toBe("Resets in 23h 59mins");
  });

  test("the day boundary drops the minutes when they are zero", () => {
    // `minutes > 0 ? ... : ""` — a whole number of hours renders without a
    // trailing "0mins".
    expect(formatResetDistance(fromNow(DAY))).toBe("Resets in 1d");
    expect(formatResetDistance(fromNow(DAY + HOUR))).toBe("Resets in 1d 1h");
    expect(formatResetDistance(fromNow(DAY + HOUR + 5 * MINUTE))).toBe("Resets in 1d 1h 5mins");
  });

  test("the month boundary is 30 days", () => {
    expect(formatResetDistance(fromNow(29 * DAY))).toBe("Resets in 29d");
    expect(formatResetDistance(fromNow(30 * DAY))).toBe("Resets in 1mo");
    expect(formatResetDistance(fromNow(31 * DAY))).toBe("Resets in 1mo 1d");
    expect(formatResetDistance(fromNow(59 * DAY))).toBe("Resets in 1mo 29d");
  });

  test("the year boundary is 365 days", () => {
    expect(formatResetDistance(fromNow(364 * DAY))).toBe("Resets in 12mo 4d");
    expect(formatResetDistance(fromNow(365 * DAY))).toBe("Resets in 1y");
    expect(formatResetDistance(fromNow(366 * DAY))).toBe("Resets in 1y 1d");
    expect(formatResetDistance(fromNow(730 * DAY))).toBe("Resets in 2y");
  });

  test("a long distance keeps the hours and minutes after the year", () => {
    // The `suffix` is appended in every branch past a day, so a distance of
    // 1y 1d 2h 3mins is fully expressed rather than truncated at the largest unit.
    const value = fromNow(365 * DAY + DAY + 2 * HOUR + 3 * MINUTE);
    expect(formatResetDistance(value)).toBe("Resets in 1y 1d 2h 3mins");
  });

  test("a month distance keeps the hours and minutes", () => {
    const value = fromNow(30 * DAY + 5 * HOUR + 7 * MINUTE);
    expect(formatResetDistance(value)).toBe("Resets in 1mo 5h 7mins");
  });

  test("a very long distance does not overflow or render NaN", () => {
    // A provider could report a reset far in the future; the output must stay a
    // readable string rather than `Infinityy` or `NaNd`.
    const value = formatResetDistance(fromNow(1_000 * 365 * DAY));
    expect(value).toContain("Resets in");
    expect(value).not.toContain("NaN");
    expect(value).not.toContain("Infinity");
  });

  test("every duration renders a pluralised unit name consistently", () => {
    // The module writes "mins" and "h"/"d"/"mo"/"y" — not "minute"/"minutes".
    // Pinned so a copy change is deliberate rather than incidental.
    const value = formatResetDistance(fromNow(2 * HOUR + 2 * MINUTE));
    expect(value).toBe("Resets in 2h 2mins");
    expect(value).not.toContain("minute");
  });
});

describe("formatQuotaWindowLabel", () => {
  test("the four documented durations get their names", () => {
    expect(formatQuotaWindowLabel("24 hour")).toBe("Daily");
    expect(formatQuotaWindowLabel("168 hour")).toBe("Weekly");
    expect(formatQuotaWindowLabel("720 hour")).toBe("Monthly");
    expect(formatQuotaWindowLabel("8760 hour")).toBe("Yearly");
  });

  test("the match is case-insensitive and tolerant of spacing", () => {
    // A provider writes "24 Hour" or "24hour"; the pattern is `/^(\d+)\s*hour$/i`.
    expect(formatQuotaWindowLabel("24 Hour")).toBe("Daily");
    expect(formatQuotaWindowLabel("24hour")).toBe("Daily");
    expect(formatQuotaWindowLabel("  168   hour  ")).toBe("Weekly");
  });

  test("a label that is not a duration is returned unchanged", () => {
    // The formatter only rewrites the `<n> hour` shape; anything else is the
    // provider's own label and must pass through rather than being dropped.
    for (const label of ["daily", "monthly quota", "5 minutes", "hour", "", "  ", "24 hours", "-24 hour", "24.5 hour"]) {
      expect(formatQuotaWindowLabel(label)).toBe(label);
    }
  });

  test("a duration under a day is reported in hours", () => {
    expect(formatQuotaWindowLabel("1 hour")).toBe("1h");
    expect(formatQuotaWindowLabel("5 hour")).toBe("5h");
    expect(formatQuotaWindowLabel("23 hour")).toBe("23h");
  });

  test("a duration between a day and a month is reported in days and hours", () => {
    expect(formatQuotaWindowLabel("48 hour")).toBe("2d");
    expect(formatQuotaWindowLabel("25 hour")).toBe("1d 1h");
    expect(formatQuotaWindowLabel("49 hour")).toBe("2d 1h");
    expect(formatQuotaWindowLabel("719 hour")).toBe("29d 23h");
  });

  test("a duration between a month and a year is reported in months and days", () => {
    // The day remainder is `Math.floor((hours % 720) / 24)`, so a partial day is
    // dropped rather than shown as a fraction. MEASURED: 8759 % 720 = 119 hours
    // = 4.96 days, floored to 4.
    expect(formatQuotaWindowLabel("1440 hour")).toBe("2mo");
    expect(formatQuotaWindowLabel("744 hour")).toBe("1mo 1d");
    expect(formatQuotaWindowLabel("8759 hour")).toBe("12mo 4d");
  });

  test("a duration past a year is reported in years and days", () => {
    expect(formatQuotaWindowLabel("17520 hour")).toBe("2y");
    // The day remainder comes from the hours within the year, floored to whole
    // days: 24 hours is one day.
    expect(formatQuotaWindowLabel("8784 hour")).toBe("1y 1d");
    expect(formatQuotaWindowLabel("17544 hour")).toBe("2y 1d");
  });

  test("a month or year remainder under 24 hours does not render as '0d'", () => {
    // The defect this pins: the day-remainder guard tested the RAW hour remainder
    // (`hours % 8760 > 0`) but emitted `Math.floor(remainder / 24)` — a whole
    // number of DAYS. Any remainder in 1..23 hours satisfied the guard and floored
    // to 0, so the label read "1y 0d" / "1mo 0d": a day count that reads as "less
    // than a day", the opposite of a window just past a month.
    //
    // The guard now tests the value it emits.
    expect(formatQuotaWindowLabel("8761 hour")).toBe("1y");
    expect(formatQuotaWindowLabel("721 hour")).toBe("1mo");
    expect(formatQuotaWindowLabel("1441 hour")).toBe("2mo");
    expect(formatQuotaWindowLabel("732 hour")).toBe("1mo");
  });

  test("a month or year remainder of at least a day is still shown", () => {
    // The other side of the same boundary, so the fix cannot be satisfied by
    // dropping the remainder entirely.
    expect(formatQuotaWindowLabel("8784 hour")).toBe("1y 1d");
    expect(formatQuotaWindowLabel("744 hour")).toBe("1mo 1d");
    expect(formatQuotaWindowLabel("8759 hour")).toBe("12mo 4d");
  });

  test("a zero duration is returned unchanged rather than as '0h'", () => {
    // The `hours <= 0` guard. A provider reporting a zero-length window is
    // reporting something the formatter cannot describe, so it passes through.
    expect(formatQuotaWindowLabel("0 hour")).toBe("0 hour");
  });

  test("a huge duration does not produce NaN", () => {
    const value = formatQuotaWindowLabel("999999 hour");
    expect(value).not.toContain("NaN");
    expect(value).toContain("y");
  });
});

describe("formatQuotaRefresh", () => {
  test("no value produces an empty string", () => {
    expect(formatQuotaRefresh(null)).toBe("");
    expect(formatQuotaRefresh("")).toBe("");
  });

  test("a valid instant renders with the documented prefix", () => {
    // The prefix is the label's meaning: this is when the collector last ran, not
    // when the quota resets.
    const value = formatQuotaRefresh("2026-03-15T12:00:00.000Z");
    expect(value).toStartWith("Last refreshed: ");
    expect(value.length).toBeGreaterThan("Last refreshed: ".length);
  });

  test("an unparseable instant produces an empty string, not 'Invalid Date'", () => {
    // `Number.isFinite(date.getTime())` is the guard; without it the card would
    // render "Last refreshed: Invalid Date".
    expect(formatQuotaRefresh("garbage")).toBe("");
    expect(formatQuotaRefresh("2026-13-45T99:99:99Z")).toBe("");
  });

  test("two different instants render differently", () => {
    // The value is not a constant string; it reflects the input.
    expect(formatQuotaRefresh("2026-03-15T12:00:00.000Z")).not.toBe(
      formatQuotaRefresh("2025-01-02T03:04:05.000Z"),
    );
  });
});

describe("friendlyQuotaError", () => {
  test("no error produces null", () => {
    expect(friendlyQuotaError(null)).toBeNull();
    expect(friendlyQuotaError(undefined)).toBeNull();
    expect(friendlyQuotaError("")).toBeNull();
  });

  test("each documented provider wording maps to its action", () => {
    // The mapping is the operator's whole diagnosis: the raw text names a status
    // code, the friendly text names what to do about it.
    const cases: readonly (readonly [string, string])[] = [
      ["token invalidated", "OAuth account invalidated — re-login required"],
      ["reauthorization required", "OAuth account invalidated — re-login required"],
      ["refresh token revoked", "OAuth account invalidated — re-login required"],
      ["endpoint is not available", "Quota tracking is not supported for this provider"],
      ["overloaded", "Provider capacity unavailable — retry after the indicated time"],
      ["usage limit reached", "Quota exhausted or rate limited — wait for reset"],
      ["http 500 error", "Provider temporarily unavailable — retry in a moment"],
      ["http 429", "Rate limited — slow down requests"],
      ["http 401 unauthorized", "Credential expired — re-login or refresh token"],
      ["http 403 forbidden", "Access denied — check account permissions"],
      ["http 402 payment required", "Payment required — top up account balance"],
      ["connection timeout", "Network error — check connection and retry"],
    ];
    for (const [raw, expected] of cases) {
      expect(friendlyQuotaError(raw)).toBe(expected);
    }
  });

  test("the match is case-insensitive", () => {
    expect(friendlyQuotaError("HTTP 429")).toBe("Rate limited — slow down requests");
    expect(friendlyQuotaError("INVALIDATED")).toBe("OAuth account invalidated — re-login required");
  });

  test("the first matching rule wins, in the documented order", () => {
    // A string containing several signals is mapped by the earliest rule. Pinned
    // because the order is the only thing making an ambiguous provider message
    // deterministic — an `invalidated` message that also says `429` must read as
    // the credential problem, which is the actionable one.
    expect(friendlyQuotaError("invalidated due to http 429")).toBe(
      "OAuth account invalidated — re-login required",
    );
    expect(friendlyQuotaError("endpoint is not available: http 500")).toBe(
      "Quota tracking is not supported for this provider",
    );
  });

  test("an unmapped error falls back to a generic sentence, never the raw text", () => {
    // The fallback is what stops a provider's own message reaching the operator;
    // those can carry an account id, an internal URL, or a stack frame.
    const raw = "some_unknown_provider_failure account=acct_123 internal=https://internal.example/secret";
    const friendly = friendlyQuotaError(raw);
    expect(friendly).toBe("Provider error — inspect account health details");
    expect(friendly).not.toContain("acct_123");
    expect(friendly).not.toContain("internal.example");
    expect(friendly).not.toContain("secret");
  });

  test("an exact 'not available' string is mapped", () => {
    // The comment records this as a stale-cached-error safety net: the backend
    // string should no longer surface fresh, but a cached value may still carry
    // it. The comparison is `lower === "not available"`, so a longer string that
    // merely contains the phrase is not this case.
    expect(friendlyQuotaError("not available")).toBe(
      "Quota tracking is not supported for this provider",
    );
    expect(friendlyQuotaError("NOT AVAILABLE")).toBe(
      "Quota tracking is not supported for this provider",
    );
  });

  test("a phrase that merely contains a mapped substring is still mapped", () => {
    // The mapping is a substring check, not an equality check, for every rule
    // except `not available`. Pinned so a reader knows the granularity.
    expect(friendlyQuotaError("The provider returned: too many requests today")).toBe(
      "Rate limited — slow down requests",
    );
  });

  test("every returned message is a non-empty sentence", () => {
    // A sweep so a new rule cannot return an empty string and render a blank
    // alert. The fallback guarantees this for unmapped input too.
    for (const raw of [
      "anything",
      "invalidated",
      "overloaded",
      "quota",
      "http 500",
      "http 429",
      "http 401",
      "http 403",
      "http 402",
      "network",
      "not available",
    ]) {
      const friendly = friendlyQuotaError(raw);
      expect(typeof friendly).toBe("string");
      expect(friendly?.length).toBeGreaterThan(0);
    }
  });
});

describe("quotaBarTone", () => {
  test("no reported quota is the neutral tone", () => {
    // The distinction that matters: `null` means the provider reported no
    // percentage, and the bar must read as unknown rather than as empty.
    const tone = quotaBarTone(null);
    expect(tone.bar).toBe("var(--text-tertiary)");
    expect(tone.text).toBe("var(--text-tertiary)");
  });

  test("under 20 percent is red", () => {
    expect(quotaBarTone(0).bar).toBe("var(--red)");
    expect(quotaBarTone(19.9).bar).toBe("var(--red)");
    // The boundary is exclusive: 20 is orange.
    expect(quotaBarTone(20).bar).toBe("var(--orange)");
  });

  test("between 20 and 49 percent is orange", () => {
    expect(quotaBarTone(20).bar).toBe("var(--orange)");
    expect(quotaBarTone(49.9).bar).toBe("var(--orange)");
    expect(quotaBarTone(50).bar).toBe("var(--green)");
  });

  test("50 percent and above is green", () => {
    expect(quotaBarTone(50).bar).toBe("var(--green)");
    expect(quotaBarTone(100).bar).toBe("var(--green)");
  });

  test("zero is red, not neutral", () => {
    // The bug this guards: a truthiness check would treat 0 as "no quota" and
    // paint an exhausted account grey — the opposite of what the operator needs.
    expect(quotaBarTone(0).bar).not.toBe(quotaBarTone(null).bar);
  });

  test("a negative percentage is red", () => {
    // A provider that overshoots reports below zero; it is the most urgent state,
    // not an unset one.
    expect(quotaBarTone(-1).bar).toBe("var(--red)");
    expect(quotaBarTone(-100).bar).toBe("var(--red)");
  });

  test("a percentage past 100 is green", () => {
    expect(quotaBarTone(150).bar).toBe("var(--green)");
  });

  test("the bar and text colours agree for every non-neutral input", () => {
    // The card paints a bar and a number; a mismatch would show a red bar beside
    // a green figure.
    for (const remaining of [0, 10, 20, 30, 50, 100]) {
      const tone = quotaBarTone(remaining);
      expect(tone.bar).toBe(tone.text);
    }
  });
});

describe("paginateQuotaWindows", () => {
  const windows = Array.from({ length: 10 }, (_value, index) => index);

  test("the page size is the documented constant", () => {
    expect(QUOTA_WINDOWS_PER_PAGE).toBe(4);
    expect(paginateQuotaWindows(windows, 0).items).toHaveLength(4);
  });

  test("the requested page is clamped into range", () => {
    // A stale page number (the operator's account lost windows since the page was
    // rendered) must not produce an empty card.
    expect(paginateQuotaWindows(windows, 0).page).toBe(0);
    expect(paginateQuotaWindows(windows, 1).page).toBe(1);
    expect(paginateQuotaWindows(windows, 2).page).toBe(2);
    expect(paginateQuotaWindows(windows, 99).page).toBe(2);
    expect(paginateQuotaWindows(windows, -5).page).toBe(0);
  });

  test("the page count covers a partial last page", () => {
    // 10 windows at 4 per page is 3 pages, the last holding 2.
    expect(paginateQuotaWindows(windows, 0).pageCount).toBe(3);
    expect(paginateQuotaWindows(windows, 2).items).toEqual([8, 9]);
  });

  test("an empty list reports one page holding nothing", () => {
    // `Math.ceil(0 / 4)` is 0, so `lastPage` is `max(0, -1)` = 0. A page count of
    // 0 would make a "1 of 0" label and a negative start index.
    const result = paginateQuotaWindows([], 0);
    expect(result.pageCount).toBe(0);
    expect(result.page).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.startIndex).toBe(0);
  });

  test("an exact multiple of the page size does not produce an empty page", () => {
    // 8 windows at 4 per page is exactly 2 pages; a third empty page would be a
    // blank card the operator could navigate to.
    const exact = Array.from({ length: 8 }, (_value, index) => index);
    expect(paginateQuotaWindows(exact, 0).pageCount).toBe(2);
    expect(paginateQuotaWindows(exact, 1).items).toEqual([4, 5, 6, 7]);
    expect(paginateQuotaWindows(exact, 99).page).toBe(1);
  });

  test("the start index matches the page", () => {
    // The card renders "showing N–M"; a wrong index would mislabel the range.
    expect(paginateQuotaWindows(windows, 0).startIndex).toBe(0);
    expect(paginateQuotaWindows(windows, 1).startIndex).toBe(4);
    expect(paginateQuotaWindows(windows, 2).startIndex).toBe(8);
  });

  test("a non-finite or fractional page request is normalised", () => {
    // `Number.isFinite` then `Math.trunc`: a NaN would propagate through the
    // clamp and produce `slice(NaN, NaN)`, which returns an empty array.
    expect(paginateQuotaWindows(windows, Number.NaN).page).toBe(0);
    expect(paginateQuotaWindows(windows, Number.POSITIVE_INFINITY).page).toBe(0);
    expect(paginateQuotaWindows(windows, 1.9).page).toBe(1);
    expect(paginateQuotaWindows(windows, -0.5).page).toBe(0);
  });

  test("the slice never returns more than the page size", () => {
    for (let page = -2; page < 6; page += 1) {
      expect(paginateQuotaWindows(windows, page).items.length).toBeLessThanOrEqual(
        QUOTA_WINDOWS_PER_PAGE,
      );
    }
  });

  test("a single window is one page", () => {
    const result = paginateQuotaWindows([42], 0);
    expect(result.pageCount).toBe(1);
    expect(result.items).toEqual([42]);
  });
});

describe("displayAccountHint", () => {
  test("a JWT-shaped hint is replaced by the account name", () => {
    // A hint starting `eyJ` is the base64 header of a JWT — a fragment of the
    // credential, not an identity. Showing it would put a piece of the token on
    // screen.
    expect(displayAccountHint("eyJhbGciOiJIUzI1NiJ9", "Work account")).toBe("Work account");
  });

  test("an em-dash placeholder is replaced by the account name", () => {
    // The placeholder the console uses for "no hint"; rendering it would show a
    // bare dash as the account's identity.
    expect(displayAccountHint("—", "Work account")).toBe("Work account");
  });

  test("any other hint is returned as-is", () => {
    expect(displayAccountHint("me@example.com", "Work account")).toBe("me@example.com");
    expect(displayAccountHint("sk-abc123", "Work account")).toBe("sk-abc123");
    expect(displayAccountHint("hint", "Work account")).toBe("hint");
  });

  test("an empty hint is returned as-is, not replaced", () => {
    // MEASURED: only `eyJ` and the em-dash trigger the replacement, so an empty
    // hint stays empty. Pinned because it means the caller must handle the empty
    // case — which `accountIdentity` does.
    expect(displayAccountHint("", "Work account")).toBe("");
  });
});

describe("accountIdentity", () => {
  test("an email hint becomes the primary and the name the secondary", () => {
    // The card leads with the address because that is what identifies the account
    // to the operator; the operator's own label is the qualifier.
    expect(accountIdentity("me@example.com", "Work account")).toEqual({
      primary: "me@example.com",
      secondary: "Work account",
    });
  });

  test("an email NAME is promoted to the primary when the hint is not one", () => {
    // The name field can hold an address too (an operator pastes it); it is
    // searched after the hint.
    expect(accountIdentity("sk-abc123", "me@example.com")).toEqual({
      primary: "me@example.com",
      secondary: null,
    });
  });

  test("a token-shaped hint is never shown as a secondary", () => {
    // `isTokenHint` covers `eyJ`, `sk-`, and the ellipsis prefix. A credential
    // fragment beside the account name would put it on screen.
    for (const hint of ["eyJhbGci", "sk-abcdef", "…abcd"]) {
      const identity = accountIdentity(hint, "Work account");
      expect(identity.primary).toBe("Work account");
      expect(identity.secondary).toBeNull();
    }
  });

  test("an empty name falls back to a placeholder rather than blank", () => {
    // A card with no title is unidentifiable; the placeholder is what makes the
    // account selectable. MEASURED: the name is the PRIMARY whenever it is not
    // an email — the hint becomes the secondary. I first wrote this the other way
    // round and the formatter corrected me.
    expect(accountIdentity("hint", "").primary).toBe("Unnamed account");
    expect(accountIdentity("hint", "").secondary).toBe("hint");
    expect(accountIdentity("", "").primary).toBe("Unnamed account");
    expect(accountIdentity("", "   ").primary).toBe("Unnamed account");
  });

  test("MEASURED QUIRK: a placeholder used AS the name becomes the identity", () => {
    // `fallbackName` is `name.trim() || "Unnamed account"`, so the placeholder
    // substitution is driven by emptiness only. An operator who sets the account
    // LABEL to an em-dash (the same glyph the console uses for "no value") gets
    // it back as the card's identity instead of "Unnamed account", because
    // `"—"` is a non-empty string.
    // The label is free-text operator input with no normalisation on the write
    // path (`src/console/providers/catalog/store.ts`: `set.label = patch.label`),
    // so this is reachable, but I am NOT calling it a defect: it is cosmetic
    // (the card reads "—" rather than a title), it requires the operator to type
    // the glyph deliberately, and unlike the hint position there is no rule
    // saying the name field is sanitised. Pinned so the behaviour is known rather
    // than surprising.
    expect(accountIdentity("—", "—")).toEqual({ primary: "—", secondary: null });
    expect(accountIdentity("", "—")).toEqual({ primary: "—", secondary: null });
  });

  test("a credential-kind hint is not treated as an identity", () => {
    // The comment is explicit: `oauth`, `api_key`, and `none` are categories, not
    // identities. Showing one would label every account the same.
    for (const hint of ["oauth", "api_key", "none", "OAUTH", "Api_Key"]) {
      expect(accountIdentity(hint, "Work account")).toEqual({
        primary: "Work account",
        secondary: null,
      });
    }
  });

  test("the em-dash placeholder is not treated as an identity", () => {
    expect(accountIdentity("—", "Work account")).toEqual({
      primary: "Work account",
      secondary: null,
    });
  });

  test("a non-email hint becomes the secondary beside the name", () => {
    // The hint is still useful (a login, a tenant, a plan) as long as it is not a
    // credential fragment and not the same string as the name.
    expect(accountIdentity("login-name", "Work account")).toEqual({
      primary: "Work account",
      secondary: "login-name",
    });
  });

  test("a hint identical to the name is not repeated as the secondary", () => {
    expect(accountIdentity("Work account", "Work account")).toEqual({
      primary: "Work account",
      secondary: null,
    });
  });

  test("an email hint never repeats itself as the secondary", () => {
    // The secondary search excludes the value already chosen as the primary.
    expect(accountIdentity("me@example.com", "me@example.com")).toEqual({
      primary: "me@example.com",
      secondary: null,
    });
  });

  test("an email-looking name with a non-email hint keeps the hint as secondary", () => {
    // The primary is the name's address; the hint is a usable qualifier.
    expect(accountIdentity("login-name", "me@example.com")).toEqual({
      primary: "me@example.com",
      secondary: "login-name",
    });
  });

  test("the secondary is null when nothing usable remains", () => {
    expect(accountIdentity("", "")).toEqual({ primary: "Unnamed account", secondary: null });
  });

  test("whitespace is trimmed from both inputs", () => {
    expect(accountIdentity("  me@example.com  ", "  Work account  ")).toEqual({
      primary: "me@example.com",
      secondary: "Work account",
    });
  });

  test("the primary is never empty and never a credential fragment", () => {
    // A sweep over the shapes the card can be handed. MEASURED results are
    // recorded in each case rather than reasoned about, because two of my
    // predictions here were wrong (the hint is not preferred over the name, and
    // `isTokenHint` guards the SECONDARY only — the name is emitted as the
    // primary even when it looks like a token).
    const cases: readonly (readonly [string, string, string])[] = [
      // hint, name, expected primary
      ["", "", "Unnamed account"],
      ["oauth", "", "Unnamed account"],
      ["eyJhbGci", "", "Unnamed account"],
      ["—", "—", "—"],
      ["me@example.com", "", "me@example.com"],
      ["", "me@example.com", "me@example.com"],
      ["login", "name", "name"],
      ["   ", "   ", "Unnamed account"],
    ];
    for (const [hint, name, expectedPrimary] of cases) {
      const identity = accountIdentity(hint, name);
      expect(identity.primary).toBe(expectedPrimary);
      expect(identity.primary.length).toBeGreaterThan(0);
      // The invariant that actually holds: the SECONDARY is never a credential
      // fragment, and never repeats the primary.
      expect(identity.primary).not.toBe(identity.secondary);
      if (identity.secondary !== null) {
        expect(identity.secondary).not.toStartWith("eyJ");
        expect(identity.secondary).not.toStartWith("sk-");
        expect(identity.secondary).not.toStartWith("…");
        expect(identity.secondary).not.toBe("—");
      }
    }
  });

  test("MEASURED: the name wins the primary slot even when it looks like a token", () => {
    // `isTokenHint` is applied only when searching for the secondary
    // (`quota-formatters.ts`, the `[fallbackName, usableHint].find(...)` call).
    // The primary search is the email test alone, so a token-shaped NAME is
    // emitted verbatim. Not reachable as a leak today: `name` comes from
    // `row.label || row.id` (`src/console/quota/account-quota-tenant.ts`), an
    // operator-typed label or the account's own UUID — never a credential. Pinned
    // so that if a future caller passes a credential-shaped name the behaviour is
    // already documented rather than silently trusted.
    expect(accountIdentity("sk-abc", "eyJxyz").primary).toBe("eyJxyz");
  });

  test("MEASURED: the 'Unnamed account' placeholder can surface as a secondary", () => {
    // When the hint is an email and the name is empty, `fallbackName` is
    // "Unnamed account" and it is the only candidate for the secondary, so the
    // card reads "me@example.com · Unnamed account". Cosmetic, and honest — the
    // account genuinely has no label — so pinned rather than flagged.
    expect(accountIdentity("me@example.com", "")).toEqual({
      primary: "me@example.com",
      secondary: "Unnamed account",
    });
  });
});
