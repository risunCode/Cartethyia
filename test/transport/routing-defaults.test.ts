/**
 * The three routing defaults an install falls back to when nothing was chosen.
 *
 * None of these is a preference: each one silently decided real behavior for
 * every provider an operator had not configured. A routing card that shows one
 * value while the dispatcher uses another is the failure this file locks.
 *
 * - **cline skips the proxy by default.** Cline bills and rate-limits on the
 *   egress address it observes, so a network pool in front of it is a way to be
 *   rate-limited per pool and to have a proxy VPN hang recorded as a dead
 *   connection. The default is a metadata flag (`defaultSkipProxy`), not a
 *   routing row, so the row the operator never created cannot flip it back.
 * - **max inflight is unlimited by default.** It used to be 5. An operator who
 *   never opened the routing card had asked for no ceiling and got one anyway,
 *   and the rejections arrived as `capacity_exhausted` — a capacity fact about
 *   a limit nobody set. An explicit ceiling is still honored.
 * - **A bare API key identifies as the Claude Code CLI.** It used to be the
 *   frozen Codex literal `codex_cli_rs/0.156.1`, which named a different
 *   vendor's client on requests that mostly reached neither upstream.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_MAX_INFLIGHT } from "../../src/persistence/schema";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../src/providers/metadata";
import { buildClaudeCliUserAgent } from "../../src/providers/operations/custom-cli-headers";
import { resolveRouteUserAgent } from "../../src/transport/routing/route-catalog";
import { InMemoryAdmissionController } from "../../src/transport/routing/admission";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

describe("proxy skip default", () => {
  test("cline dials direct unless an operator says otherwise", () => {
    // Cline is the provider whose per-account health follows the egress
    // address, so the pool is the thing most likely to be wrong for it.
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("cline")).toBe(true);
  });

  test("inferhub keeps the same default it always had", () => {
    // The other member of the set. If this flipped, the change stopped being
    // "cline now skips too" and became "the skip default moved".
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("inferhub")).toBe(true);
  });

  test("an ordinary API-key provider is not silently exempted", () => {
    expect(DEFAULT_PROXY_SKIP_PROVIDER_IDS.has("groq")).toBe(false);
  });
});

describe("max inflight default", () => {
  test("an unconfigured provider has no ceiling", () => {
    expect(DEFAULT_PROVIDER_MAX_INFLIGHT).toBeNull();
  });

  test("admission admits without a bound when the candidate carries no limit", async () => {
    // The decision `resolveMaxInflight` feeds: absent means unlimited, and
    // `admissionDirective` is where that is actually honored. Asserting only
    // the constant would pass while the dispatcher still capped at 5.
    const controller = new InMemoryAdmissionController();
    const candidate = { provider_id: "groq", model_id: "m", provider_account_id: "a" } as RouteCandidate;
    for (let i = 0; i < 25; i += 1) {
      const decision = await controller.admit(candidate);
      expect(decision.admitted).toBe(true);
    }
  });

  test("an explicit ceiling still rejects past it", async () => {
    // The other arm of the same change: unlimited-by-default must not mean
    // "the ceiling is ignored".
    const controller = new InMemoryAdmissionController();
    const candidate = {
      provider_id: "groq",
      model_id: "m",
      provider_account_id: "a",
      max_inflight: 2,
    } as RouteCandidate;
    expect((await controller.admit(candidate)).admitted).toBe(true);
    expect((await controller.admit(candidate)).admitted).toBe(true);
    const third = await controller.admit(candidate);
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe("capacity_exhausted");
  });
});

describe("default route identity", () => {
  test("is the Claude Code CLI identity, not Codex's", () => {
    // A provider whose operator chose nothing is handed this string. It used to
    // be `codex_cli_rs/0.156.1`, which named a different vendor's client.
    const resolved = resolveRouteUserAgent("groq", undefined, undefined);
    expect(resolved).toBe(buildClaudeCliUserAgent());
    // Asserted separately so the wiring above cannot pass by reverting both
    // sides together: the string itself has to be the Claude Code one.
    expect(resolved).toMatch(/^claude-cli\/\S+ \(external, cli\)$/);
  });

  test("no identity anywhere on the route answers with the Claude Code CLI", () => {
    expect(buildClaudeCliUserAgent()).toMatch(/^claude-cli\/\S+ \(external, cli\)$/);
  });

  test("does not carry the retired Codex identity", () => {
    expect(buildClaudeCliUserAgent()).not.toContain("codex_cli_rs");
  });

  test("an operator's own identity still wins over the default", () => {
    expect(resolveRouteUserAgent("groq", "Cartethyia/2.2", undefined)).toBe("Cartethyia/2.2");
    expect(resolveRouteUserAgent("groq", undefined, "my-client/1.0")).toBe("my-client/1.0");
  });

  test("an empty identity means no header at all, not the default", () => {
    // "None" in the card is an operator choosing silence. Falling back to the
    // default here would make that choice unreachable from the UI.
    expect(resolveRouteUserAgent("groq", "", undefined)).toBeUndefined();
  });
});