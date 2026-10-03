/**
 * The probe's reasoning effort must reach the wire that actually serves the
 * model.
 *
 * The bug this pins: `loadProbePreferences` gated the whole reasoning block on
 * `wireFamily === "responses"`, so an operator who picked `high` on the Models
 * card got **no** `reasoning` intent at all for a Chat-wire model — the
 * dropdown looked wired and changed nothing. The gate existed because
 * `ProbeReasoning.summary_mode` is a Responses-only knob; the fix keeps the
 * summary Responses-only while letting the effort ride every wire.
 *
 * Two properties are load-bearing:
 *
 * - **Effort is wire-agnostic.** Chat, Messages and Responses all honor
 *   `reasoning_effort`, so a requested effort must survive on all three.
 * - **`auto` still means "no intent".** A probe must be able to reflect what the
 *   route does by itself, and forcing an effort onto a model that does not
 *   support reasoning would turn a working route into a reported failure.
 */
import { describe, expect, test } from "bun:test";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import {
  buildProbeCanonicalRequest,
  loadProbePreferences,
} from "../../src/providers/discovery/probe-phases";
import {
  PROBE_REASONING_EFFORTS,
  type ProbeModelRequest,
} from "../../src/providers/discovery/discovery-types";

/** A chainable stand-in for the one `select().from().where().limit()` read. */
function fakeDb(rows: readonly unknown[]): CartethyiaDatabase {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return chain as unknown as CartethyiaDatabase;
}

/** A db whose read throws, to exercise the non-fatal catch branch. */
function throwingDb(): CartethyiaDatabase {
  const chain = {
    select: () => {
      throw new Error("settings read outage");
    },
  };
  return chain as unknown as CartethyiaDatabase;
}

const TENANT = "00000000-0000-0000-0000-000000000000";

async function load(
  wireFamily: "chat" | "responses" | "messages",
  request: ProbeModelRequest,
  db: CartethyiaDatabase = fakeDb([]),
) {
  return loadProbePreferences({ db, tenantId: TENANT, wireFamily, request });
}

describe("loadProbePreferences — effort reaches the wire", () => {
  test("a Chat-wire probe carries the requested effort", async () => {
    // The regression: this used to come back `undefined`, so the Models card's
    // dropdown was inert for every Chat-wire model.
    const { probeReasoning } = await load("chat", { modelId: "m", reasoningEffort: "high" });
    expect(probeReasoning?.effort).toBe("high");
  });

  test("a Messages-wire probe carries the requested effort", async () => {
    const { probeReasoning } = await load("messages", { modelId: "m", reasoningEffort: "medium" });
    expect(probeReasoning?.effort).toBe("medium");
  });

  test("a Responses-wire probe carries the requested effort", async () => {
    const { probeReasoning } = await load("responses", { modelId: "m", reasoningEffort: "xhigh" });
    expect(probeReasoning?.effort).toBe("xhigh");
  });

  test("every documented effort survives on every wire", async () => {
    // Derived from the tuple, not a hand-written copy: the vocabulary and this
    // assertion cannot drift apart, and a newly offered level is covered the
    // moment it is added.
    const efforts = PROBE_REASONING_EFFORTS.filter((effort) => effort !== "auto");
    for (const wireFamily of ["chat", "responses", "messages"] as const) {
      for (const effort of efforts) {
        const { probeReasoning } = await load(wireFamily, { modelId: "m", reasoningEffort: effort });
        expect(probeReasoning?.effort).toBe(effort);
      }
    }
  });

  test("`max` is offered and reaches the wire", async () => {
    // The Model Lab offers `Max`; the probe vocabulary used to stop at `xhigh`,
    // so the two dropdowns disagreed about the same scale.
    expect(PROBE_REASONING_EFFORTS).toContain("max");
    for (const wireFamily of ["chat", "responses", "messages"] as const) {
      const { probeReasoning } = await load(wireFamily, { modelId: "m", reasoningEffort: "max" });
      expect(probeReasoning?.effort).toBe("max");
    }
  });
});

describe("loadProbePreferences — summary_mode stays Responses-only", () => {
  test("a Chat-wire probe omits the summary knob", async () => {
    // Chat has no summary field; sending one would be a value the codec drops.
    const { probeReasoning } = await load("chat", { modelId: "m", reasoningEffort: "high" });
    expect(probeReasoning?.summary_mode).toBeUndefined();
  });

  test("a Responses-wire probe includes the tenant summary mode", async () => {
    const { probeReasoning } = await load("responses", { modelId: "m", reasoningEffort: "high" });
    expect(probeReasoning?.summary_mode).toBe("detailed");
  });

  test("the tenant's stored summary mode is honored on Responses", async () => {
    const db = fakeDb([{ preferences: { responsesReasoningSummary: "concise" } }]);
    const { probeReasoning } = await load("responses", { modelId: "m", reasoningEffort: "high" }, db);
    expect(probeReasoning?.summary_mode).toBe("concise");
  });
});

describe("loadProbePreferences — auto means no intent", () => {
  test("an omitted effort sends nothing", async () => {
    const { probeReasoning } = await load("chat", { modelId: "m" });
    expect(probeReasoning).toBeUndefined();
  });

  test("`auto` sends nothing on any wire", async () => {
    // Pinned because forcing an effort onto a model without reasoning support
    // turns a healthy route into a reported failure.
    for (const wireFamily of ["chat", "responses", "messages"] as const) {
      const { probeReasoning } = await load(wireFamily, { modelId: "m", reasoningEffort: "auto" });
      expect(probeReasoning).toBeUndefined();
    }
  });
});

describe("loadProbePreferences — a settings read outage is non-fatal", () => {
  test("a Chat-wire probe still carries the effort when the read throws", async () => {
    // The catch branch used to re-apply the Responses gate, so an outage
    // silently dropped the effort on Chat too.
    const { probeReasoning } = await load("chat", { modelId: "m", reasoningEffort: "low" }, throwingDb());
    expect(probeReasoning?.effort).toBe("low");
    expect(probeReasoning?.summary_mode).toBeUndefined();
  });

  test("a Responses-wire probe falls back to `detailed` when the read throws", async () => {
    const { probeReasoning } = await load(
      "responses",
      { modelId: "m", reasoningEffort: "low" },
      throwingDb(),
    );
    expect(probeReasoning?.summary_mode).toBe("detailed");
  });
});

describe("buildProbeCanonicalRequest", () => {
  test("a carried effort lands on the canonical request's reasoning block", async () => {
    // The end of the chain: what `loadProbePreferences` decided is what the
    // adapter dispatches.
    const { probeReasoning } = await load("chat", { modelId: "m", reasoningEffort: "high" });
    const canonical = buildProbeCanonicalRequest({
      modelId: "m",
      request: { modelId: "m", reasoningEffort: "high" },
      probeReasoning,
      sourceSurface: "chat",
    });
    expect(canonical.reasoning?.effort).toBe("high");
  });

  test("no effort means no reasoning block at all", () => {
    const canonical = buildProbeCanonicalRequest({
      modelId: "m",
      request: { modelId: "m" },
      probeReasoning: undefined,
      sourceSurface: "chat",
    });
    expect(canonical.reasoning).toBeUndefined();
  });
});
