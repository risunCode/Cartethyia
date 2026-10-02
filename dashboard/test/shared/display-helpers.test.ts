/**
 * Small dashboard presentation helpers, grouped because each is a handful of
 * lines that answer one display question.
 *
 * Four of them, chosen because a wrong answer is visible to an operator:
 *
 * - `formatModelTokens` — the model cards' context/output limits. Its whole
 *   reason for existing is that an UNKNOWN limit must not look like a measured
 *   one (see `UNKNOWN_LIMITS_TOOLTIP`), so the `—` path is the load-bearing one.
 * - `requestProviderId` — which provider the usage log names for a request that
 *   may have failed before a provider was leased.
 * - `resolveDashboardApp` — which of the three apps the shared index document
 *   mounts. Getting this wrong mounts the console for a share visitor.
 * - `providerCanConfigureUserAgent` — whether the route-level User-Agent control
 *   is offered on a provider detail page. Offering it where the adapter owns the
 *   header would let an operator set a value that is silently ignored.
 *
 * Every expected value below was measured against the module, not derived from
 * its comments.
 */
import { describe, expect, test } from "bun:test";
import { resolveDashboardApp, type DashboardApp } from "../../src/shared/app-entry";
import { COMBO_STRATEGY_OPTIONS } from "../../src/shared/combo-strategy";
import { providerCanConfigureUserAgent } from "../../src/shared/provider-user-agent";
import { formatModelTokens, UNKNOWN_LIMITS_TOOLTIP } from "../../src/shared/model-limits";
import { requestProviderId } from "../../src/shared/request-provider";
import { DASHBOARD_CODENAME, DASHBOARD_RELEASE_LABEL, DASHBOARD_VERSION } from "../../src/shared/version";

describe("formatModelTokens", () => {
  test("an absent limit renders as an em-dash, never as a number", () => {
    // The module's stated purpose: a made-up 200k/64k "looks measured and
    // misleads capacity planning". This is the assertion that holds it.
    expect(formatModelTokens(null)).toBe("—");
    expect(formatModelTokens(undefined)).toBe("—");
  });

  test("a non-finite value also renders as an em-dash", () => {
    // `Number.isFinite` — a NaN or Infinity from a bad upstream payload must not
    // render as "NaN" or "InfinityM".
    expect(formatModelTokens(Number.NaN)).toBe("—");
    expect(formatModelTokens(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatModelTokens(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  test("a value below a thousand is printed as-is", () => {
    // `String(value)` — no suffix, no rounding.
    expect(formatModelTokens(0)).toBe("0");
    expect(formatModelTokens(1)).toBe("1");
    expect(formatModelTokens(999)).toBe("999");
  });

  test("a negative value is printed as-is, not as unknown", () => {
    // MEASURED — I first expected "-1000k" and was wrong. The suffix branches are
    // `value >= 1_000_000` and `value >= 1_000`, both of which a negative fails,
    // so every negative falls through to `String(value)` with no suffix at all.
    // Pinned because it is the boundary between "absent" (rendered `—`) and
    // "nonsense" (rendered literally): the module treats only the former as
    // unknown, so a negative limit is displayed rather than hidden.
    expect(formatModelTokens(-1)).toBe("-1");
    expect(formatModelTokens(-1_000)).toBe("-1000");
    expect(formatModelTokens(-1_000_000)).toBe("-1000000");
  });

  test("the thousand boundary switches to a k suffix", () => {
    expect(formatModelTokens(1_000)).toBe("1k");
    expect(formatModelTokens(1_023)).toBe("1k");
  });

  test("k values are rounded to whole thousands", () => {
    // `toFixed(0)` — so 1499 is "1k" and 1500 is "2k". Pinned from both sides
    // because the rounding is half-up and an off-by-one here changes a displayed
    // context size.
    expect(formatModelTokens(1_499)).toBe("1k");
    expect(formatModelTokens(1_500)).toBe("2k");
    expect(formatModelTokens(200_000)).toBe("200k");
    expect(formatModelTokens(400_000)).toBe("400k");
  });

  test("a value just under a million stays in k", () => {
    // The boundary case that reads oddly: 999_999 rounds to "1000k" rather than
    // switching unit. MEASURED and pinned — the unit choice is made on the RAW
    // value, before rounding, so a rounding-up carry can exceed the suffix's
    // natural range.
    expect(formatModelTokens(999_999)).toBe("1000k");
  });

  test("the million boundary switches to an M suffix with one decimal", () => {
    expect(formatModelTokens(1_000_000)).toBe("1.0M");
    expect(formatModelTokens(1_048_576)).toBe("1.0M");
    expect(formatModelTokens(1_500_000)).toBe("1.5M");
    expect(formatModelTokens(2_000_000)).toBe("2.0M");
  });

  test("a value above the M range keeps growing rather than switching unit", () => {
    // There is no billion tier; the M value just gets larger. Pinned so the
    // ceiling is known.
    expect(formatModelTokens(999_999_999)).toBe("1000.0M");
  });

  test("the two cards agree because there is one owner", () => {
    // The module exists so the provider catalog and the share page cannot render
    // the same model differently. A sweep asserting the shape is stable is the
    // closest a unit test gets to that; the real guarantee is the single import.
    for (const value of [1_000, 400_000, 1_000_000, 1_500_000]) {
      const rendered = formatModelTokens(value);
      expect(rendered).toMatch(/^\d+(\.\d)?(k|M)?$/);
    }
  });

  test("the unknown-limits tooltip is a non-empty sentence", () => {
    // It is rendered beside `n/a` to explain the absence; a blank tooltip would
    // leave the operator with an unexplained dash.
    expect(UNKNOWN_LIMITS_TOOLTIP.length).toBeGreaterThan(0);
    expect(UNKNOWN_LIMITS_TOOLTIP).toContain("unavailable");
  });
});

describe("requestProviderId", () => {
  test("an explicit provider id is returned unchanged", () => {
    expect(requestProviderId("anthropic", "claude-sonnet-4")).toBe("anthropic");
    expect(requestProviderId("anthropic", undefined)).toBe("anthropic");
  });

  test("a qualified model supplies the provider id when the explicit one is absent", () => {
    // The case the function exists for: a request that failed before a provider
    // was leased still has a displayable provider, because the client named it.
    expect(requestProviderId(undefined, "anthropic/claude-sonnet-4")).toBe("anthropic");
  });

  test("a bare model names no provider", () => {
    // Documented: "a bare model names no provider". The usage row shows a dash.
    expect(requestProviderId(undefined, "claude-sonnet-4")).toBeUndefined();
    expect(requestProviderId(undefined, "gpt-5")).toBeUndefined();
  });

  test("only the FIRST slash splits", () => {
    // `indexOf("/")` + `slice(0, slash)` — a nested model path keeps only the
    // leading segment.
    expect(requestProviderId(undefined, "a/b/c")).toBe("a");
  });

  test("a leading slash names no provider", () => {
    // `slash > 0` — position 0 is rejected, so the id would be the empty string
    // and the row falls back to a dash rather than rendering blank.
    expect(requestProviderId(undefined, "/leading")).toBeUndefined();
  });

  test("an empty model names no provider", () => {
    expect(requestProviderId(undefined, "")).toBeUndefined();
    expect(requestProviderId(undefined, undefined)).toBeUndefined();
  });

  test("an empty explicit id falls through to the model", () => {
    // `if (providerId)` — an empty string is falsy, so the model is consulted.
    // Pinned: this is the difference between `if` and `!== undefined`.
    expect(requestProviderId("", "anthropic/x")).toBe("anthropic");
  });

  test("the explicit id wins over a conflicting model", () => {
    // The lease is authoritative when it exists; the model string is only a
    // fallback for display.
    expect(requestProviderId("openai", "anthropic/x")).toBe("openai");
  });
});

describe("resolveDashboardApp", () => {
  test("the three apps are resolved from their path prefixes", () => {
    expect(resolveDashboardApp("/console")).toBe("console");
    expect(resolveDashboardApp("/share")).toBe("share");
    expect(resolveDashboardApp("/")).toBe("landing");
  });

  test("a prefix match requires a segment boundary", () => {
    // `/consoleX` is not the console app. Without the trailing-slash check the
    // index document would mount the console for a path the router does not own.
    expect(resolveDashboardApp("/consoleX")).toBe("landing");
    expect(resolveDashboardApp("/shareX")).toBe("landing");
  });

  test("a nested path resolves to its app", () => {
    expect(resolveDashboardApp("/console/logs")).toBe("console");
    expect(resolveDashboardApp("/share/abc123")).toBe("share");
  });

  test("the trailing-slash form resolves to the app", () => {
    expect(resolveDashboardApp("/console/")).toBe("console");
    expect(resolveDashboardApp("/share/")).toBe("share");
  });

  test("anything unrecognised is the landing app", () => {
    // The fallback is the landing page, which is safe: it mounts nothing that
    // needs a session or a share key.
    expect(resolveDashboardApp("/landing")).toBe("landing");
    expect(resolveDashboardApp("/nonsense")).toBe("landing");
    expect(resolveDashboardApp("")).toBe("landing");
  });

  test("the match is case-sensitive", () => {
    // The router's paths are lower-case; treating `/Console` as the console app
    // would mount an app the router cannot route.
    expect(resolveDashboardApp("/Console")).toBe("landing");
    expect(resolveDashboardApp("/Share")).toBe("landing");
  });

  test("share is checked before console", () => {
    // A path cannot be both, so the order is not observable here — but the
    // returned type must stay in the documented union for every input.
    const apps: readonly DashboardApp[] = ["landing", "console", "share"];
    for (const path of ["/", "/console", "/share", "/x", ""]) {
      expect(apps).toContain(resolveDashboardApp(path));
    }
  });
});

describe("providerCanConfigureUserAgent", () => {
  /** A provider that satisfies every condition. */
  const eligible = {
    isBuiltIn: true,
    requiresAccount: true,
    hasAdapterUserAgent: false,
  };

  test("an eligible built-in provider can configure the header", () => {
    expect(providerCanConfigureUserAgent(eligible)).toBe(true);
  });

  test("a BYOK provider cannot", () => {
    // Documented: only built-ins get the route-level control; a custom provider's
    // header comes from the adapter.
    expect(providerCanConfigureUserAgent({ ...eligible, isBuiltIn: false })).toBe(false);
  });

  test("a provider that needs no account cannot", () => {
    // The two credential-less builtin routes have nothing to attach a header to.
    expect(providerCanConfigureUserAgent({ ...eligible, requiresAccount: false })).toBe(false);
  });

  test("a provider with an adapter-managed user agent cannot", () => {
    // The important negative: offering the control here would let an operator set
    // a value the adapter overwrites, so the setting would appear to save and
    // have no effect.
    expect(providerCanConfigureUserAgent({ ...eligible, hasAdapterUserAgent: true })).toBe(false);
  });

  test("a provider with live OAuth flows cannot", () => {
    // `oauthFlows === undefined` is the test — any defined value, including one
    // whose every flag is false, disqualifies the provider. MEASURED: an empty
    // object is NOT undefined, so it blocks the control. Pinned because it is the
    // one condition where "present but empty" differs from "absent", and the
    // contract's own comment says undefined means no live OAuth client.
    const flows = {
      browser: false,
      device: false,
      import: false,
      browserLoginFields: [],
      deviceLoginFields: [],
      importFields: [],
    };
    expect(providerCanConfigureUserAgent({ ...eligible, oauthFlows: flows })).toBe(false);
  });

  test("all four conditions are required, not any", () => {
    // A sweep over the single-failure shapes, so no condition can be dropped
    // without a failure.
    const failures = [
      { ...eligible, isBuiltIn: false },
      { ...eligible, requiresAccount: false },
      { ...eligible, hasAdapterUserAgent: true },
      {
        ...eligible,
        oauthFlows: {
          browser: true,
          device: true,
          import: true,
          browserLoginFields: [],
          deviceLoginFields: [],
          importFields: [],
        },
      },
    ];
    for (const provider of failures) {
      expect(providerCanConfigureUserAgent(provider)).toBe(false);
    }
  });
});

describe("COMBO_STRATEGY_OPTIONS", () => {
  test("every option carries a value and a label", () => {
    // The Select renders both; a missing label would render an empty row.
    expect(COMBO_STRATEGY_OPTIONS.length).toBeGreaterThan(0);
    for (const option of COMBO_STRATEGY_OPTIONS) {
      expect(option.value.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  test("the values are unique", () => {
    // A duplicate value would make two options select the same strategy.
    const values = COMBO_STRATEGY_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test("the three combo strategies are all offered", () => {
    // The list is typed as `SelectOption & { value: ComboStrategy }`, so the
    // canonical union drives it. Pinning the current membership means removing a
    // strategy from the UI is a deliberate change.
    const values = COMBO_STRATEGY_OPTIONS.map((option) => option.value).sort();
    expect(values).toEqual(["fallback", "fusion", "round_robin"]);
  });
});

describe("version metadata", () => {
  test("the release label is composed from the version and codename", () => {
    // The footer reads this; a mismatch between the three constants would show a
    // version that is not the one in package.json.
    expect(DASHBOARD_RELEASE_LABEL).toBe(`v${DASHBOARD_VERSION} (${DASHBOARD_CODENAME})`);
  });

  test("the version is a non-empty string taken from package.json", () => {
    // MEASURED: the dashboard's package.json carries a two-part version ("2.0"),
    // not a semver triple. I first asserted `/^\d+\.\d+\.\d+/` and was wrong.
    // Asserting the actual shape rather than a stricter guess keeps this a real
    // test of "it comes from package.json and is numeric", which is what the
    // release label needs.
    expect(typeof DASHBOARD_VERSION).toBe("string");
    expect(DASHBOARD_VERSION.length).toBeGreaterThan(0);
    expect(DASHBOARD_VERSION).toMatch(/^\d+(\.\d+)+/);
  });
});
