import { describe, expect, test } from "bun:test";
import { InMemoryRouteSnapshotService } from "../../src/transport/routing/route-model";
import { EligibilityEvaluator } from "../../src/transport/routing/router";
import { RoutingEngine } from "../../src/transport/routing/router";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

function cand(model: string, provider = "openai"): RouteCandidate {
  return {
    provider_id: provider,
    model_id: model,
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: { tools: true },
  };
}

describe("routing matrix composition", () => {
  test("plan resolves alias and checks eligibility before lease", async () => {
    const snapshots = new InMemoryRouteSnapshotService(async () => ({
      candidates: [cand("gpt-4"), cand("gpt-4", "anthropic")],
      aliases: { "test-tenant": { "gpt-4-alias": "openai/gpt-4" } },
      combos: {},
    }));
    const snap = await snapshots.getSnapshot();
    const engine = new RoutingEngine();
    // Bare model with multiple owners should be ambiguous without qualification
    await expect(engine.plan("gpt-4", snap, "test-tenant")).rejects.toMatchObject({
      code: "ambiguous_model",
    });
    // An alias resolving to a bare, still-ambiguous target must reject exactly
    // like requesting the bare model directly — alias resolution is never a
    // silent way to bypass ambiguity protection.
    const ambiguousAlias = new InMemoryRouteSnapshotService(async () => ({
      candidates: [cand("gpt-4"), cand("gpt-4", "anthropic")],
      aliases: { "test-tenant": { "gpt-4-alias": "gpt-4" } },
      combos: {},
    }));
    const ambiguousSnap = await ambiguousAlias.getSnapshot();
    await expect(
      new RoutingEngine().plan("gpt-4-alias", ambiguousSnap, "test-tenant"),
    ).rejects.toMatchObject({ code: "ambiguous_model" });
    // Alias resolving to an explicitly provider-qualified target resolves cleanly.
    const plan = await engine.plan("gpt-4-alias", snap, "test-tenant");
    expect(plan.resolved_model).toBe("openai/gpt-4");
    expect(plan.candidates.length).toBeGreaterThan(0);
  });

  test("eligibility shared between live and diagnostic", async () => {
    const snapshots = new InMemoryRouteSnapshotService(async () => ({
      candidates: [{ ...cand("x"), health_status: "cooldown" } as unknown as RouteCandidate],
      aliases: {},
      combos: {},
    }));
    const snap = await snapshots.getSnapshot();
    const evaluator = new EligibilityEvaluator();
    const live = evaluator.filter(snap.candidates);
    const diag = evaluator.filter(snap.candidates);
    expect(live.length).toBe(0);
    expect(diag.length).toBe(0);
  });

  test("reservation lease lifecycle", async () => {
    const snapshots = new InMemoryRouteSnapshotService(async () => ({
      candidates: [cand("a")],
      aliases: {},
      combos: {},
    }));
    const snap = await snapshots.getSnapshot();
    const engine = new RoutingEngine();
    const plan = await engine.plan("a", snap);
    const res = await engine.reserve(plan);
    expect(res.lease_id).toBeDefined();
    await engine.release(res);
  });
});
