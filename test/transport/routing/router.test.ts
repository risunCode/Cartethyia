import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { poolMaxFromEnv } from "../../../src/persistence/postgres";
import { DEFAULT_BOUNDS } from "../../../src/transport/resources";
import {
  ReservationManager,
  RoutingEngine,
  InMemoryAdmissionController,
  RedisAdmissionController,
} from "../../../src/transport/routing/router";
import { InMemoryRouteSnapshotService } from "../../../src/transport/routing/route-model";
import type { RouteCandidate, RouteSnapshot, Reservation, ComboDefinition } from "../../../src/transport/routing/route-model";
import type { RedisClient } from "../../../src/persistence/redis";

describe("engine.test.ts", () => {
  function cand(id: string, provider = "openai", tenantId: string | null = null): RouteCandidate {
    return {
      provider_id: provider,
      model_id: id,

      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
      ...(tenantId === null ? {} : { tenant_id: tenantId }),
    };
  }

  async function buildSnapshot(
    builder: () => Promise<Omit<RouteSnapshot, "revision" | "created_at">>,
  ): Promise<RouteSnapshot> {
    const svc = new InMemoryRouteSnapshotService(builder);
    return svc.getSnapshot();
  }
  test("normalizes legacy routing snapshots without rotateCount", async () => {
    const snapshot = await buildSnapshot(async () => ({
      candidates: [],
      aliases: {},
      combos: {},
      providerRouting: {
        __global__: {
          openai: {
            strategy: "fallback",
            maxInflight: null,
            enabled: true,
            bypassProxy: false,
          },
        },
      } as unknown as NonNullable<RouteSnapshot["providerRouting"]>,
    }));
    expect(snapshot.providerRouting?.__global__?.openai?.rotateCount).toBe(1);
  });

  function candidate(): RouteCandidate {
    return {
      provider_id: "openai",
      model_id: "gpt-4",

      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
    };
  }

  describe("RoutingEngine — tenant-scoped alias resolution", () => {
    test("alias resolves to a real model within its tenant", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { fast: "real-model" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("fast", snap, "tenant-a");
      expect(plan.resolved_model).toBe("real-model");
    });

    test("alias does not resolve for a different tenant", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { fast: "real-model" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("fast", snap, "tenant-b")).rejects.toMatchObject({
        code: "model_not_found",
      });
    });

    test("alias does not resolve when no tenantId is passed", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { fast: "real-model" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("fast", snap)).rejects.toMatchObject({ code: "model_not_found" });
    });

    test("model_not_found names the resolved target when the alias points at nothing", async () => {
      // Regression: a tenant alias and a fallback combo both addressed a model
      // the bundled catalog had dropped, so every request 404'd with only the
      // alias name in the error — the missing target was invisible.
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { "mimo-2.6-flash": "opencodeft/mimo-v2.6-flash-free" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("mimo-2.6-flash", snap, "tenant-a")).rejects.toMatchObject({
        code: "model_not_found",
        details: { resolved_models: ["opencodeft/mimo-v2.6-flash-free"] },
      });
    });

    test("alias cycle throws model_not_found, not an unhandled Error", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { a: "b", b: "a" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      const result = engine.plan("a", snap, "tenant-a");
      await expect(result).rejects.toMatchObject({ code: "model_not_found" });
      await expect(result).rejects.toHaveProperty("status");
    });

    test("CLI variant suffix resolves through the stripped alias", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("deepseek-v4.1-flash", "cb")],
        aliases: { "tenant-a": { opus: "cb/deepseek-v4.1-flash" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("claude-opus-5[1m]", snap, "tenant-a");
      expect(plan.resolved_model).toBe("cb/deepseek-v4.1-flash");
      expect(plan.provider_id).toBe("cb");
    });

    test("verbatim alias wins over variant normalization", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("other-model", "other"), cand("deepseek-v4.1-flash", "cb")],
        aliases: {
          "tenant-a": { "claude-opus-5": "other/other-model", opus: "cb/deepseek-v4.1-flash" },
        },
        combos: {},
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("claude-opus-5[1m]", snap, "tenant-a");
      expect(plan.resolved_model).toBe("other/other-model");
    });

    test("unknown variant still throws model_not_found, never a silent remap", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("deepseek-v4.1-flash", "cb")],
        aliases: { "tenant-a": { opus: "cb/deepseek-v4.1-flash" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("unknown-model[xx]", snap, "tenant-a")).rejects.toMatchObject({
        code: "model_not_found",
      });
    });
  });
  describe("RoutingEngine — combo strategy ordering", () => {
    test("fallback strategy orders candidates by declared member order across providers", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("model-a", "openai"), cand("model-b", "anthropic")],
        aliases: {},
        combos: {
          "tenant-a": {
            pool: { members: ["model-a", "model-b"], strategy: "fallback" },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a");
      expect(plan.candidates.map((c) => c.model_id)).toEqual(["model-a", "model-b"]);
    });

    test("round_robin strategy alternates the starting member across sequential calls", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("model-a", "openai"), cand("model-b", "anthropic")],
        aliases: {},
        combos: {
          "tenant-a": {
            pool: { members: ["model-a", "model-b"], strategy: "round_robin" },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan1 = await engine.plan("pool", snap, "tenant-a");
      const plan2 = await engine.plan("pool", snap, "tenant-a");
      expect(plan1.candidates[0]?.model_id).not.toBe(plan2.candidates[0]?.model_id);
      // Every member's candidates are still present in both plans, just reordered.
      expect(new Set(plan1.candidates.map((c) => c.model_id))).toEqual(
        new Set(["model-a", "model-b"]),
      );
      expect(new Set(plan2.candidates.map((c) => c.model_id))).toEqual(
        new Set(["model-a", "model-b"]),
      );
    });

    test("a combo member resolving via a chained alias expands to the real model", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { fast: "real-model" } },
        combos: {
          "tenant-a": {
            pool: { members: ["fast"], strategy: "fallback" },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a");
      expect(plan.candidates.map((c) => c.model_id)).toEqual(["real-model"]);
    });

    test("duplicate modelIds from two members resolving to the same target are deduped", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("real-model")],
        aliases: { "tenant-a": { alias1: "real-model", alias2: "real-model" } },
        combos: {
          "tenant-a": {
            pool: { members: ["alias1", "alias2"], strategy: "round_robin" },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a");
      expect(plan.candidates.map((c) => c.model_id)).toEqual(["real-model"]);
    });
  });

  describe("RoutingEngine — a combo edit survives an in-flight snapshot build", () => {
    test("a plan after the edit routes to the new member, not the pre-edit one", async () => {
      // The reported failure: a combo whose members were repointed at another
      // provider kept dispatching the old one. The edit does invalidate the
      // snapshot, but a build already running could finish afterwards and
      // re-cache the pre-edit catalog, so every later request kept routing to
      // the member the operator had just removed.
      let members = ["cb/deepseek-v4.1-flash"];
      const gate = Promise.withResolvers<void>();
      let builds = 0;
      const svc = new InMemoryRouteSnapshotService(async () => {
        const captured = [...members];
        builds += 1;
        // Hold the first (pre-edit) build open so the edit lands mid-build.
        if (builds === 1) await gate.promise;
        return {
          candidates: [
            cand("deepseek-v4.1-flash", "cb"),
            cand("deepseek-v4.1-flash", "workbuddy"),
          ],
          aliases: {},
          combos: {
            "tenant-a": { pool: { members: captured, strategy: "fallback" } },
          },
        };
      });
      const engine = new RoutingEngine();
      const inFlight = svc.getSnapshot();
      await Promise.resolve();
      members = ["workbuddy/deepseek-v4.1-flash"];
      await svc.invalidate();
      // Start the post-edit read without awaiting it: when the bug is present
      // it joins the gated pre-edit build, so the gate has to be released
      // before either promise can settle. Awaiting here instead would deadlock
      // and report a timeout rather than the wrong route.
      const afterEditPromise = svc.getSnapshot();
      gate.resolve();
      const afterEdit = await afterEditPromise;
      await inFlight;

      const plan = await engine.plan("pool", afterEdit, "tenant-a");
      expect(plan.provider_id).toBe("workbuddy");
    });
  });

  describe("RoutingEngine — provider-qualified model auto by registry", () => {
    test("bare model with multiple providers is ambiguous, provider/model pins to one", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("haiku-4.5", "claude"), cand("haiku-4.5", "openai")],
        aliases: {},
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("haiku-4.5", snap, "tenant-a")).rejects.toMatchObject({
        code: "ambiguous_model",
      });
      const pin = await engine.plan("claude/haiku-4.5", snap, "tenant-a");
      expect(pin.candidates).toHaveLength(1);
      expect(pin.candidates[0]?.provider_id).toBe("claude");
      expect(pin.resolved_model).toBe("claude/haiku-4.5");
    });


    test("alias resolving to an ambiguous bare model is rejected, not silently pinned", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("haiku-4.5", "claude"), cand("haiku-4.5", "openai")],
        aliases: { "tenant-a": { fast: "haiku-4.5" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("fast", snap, "tenant-a")).rejects.toMatchObject({
        code: "ambiguous_model",
      });
    });
    test("alias target can be provider/model", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("haiku-4.5", "claude"), cand("haiku-4.5", "openai")],
        aliases: { "tenant-a": { fast: "claude/haiku-4.5" } },
        combos: {},
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("fast", snap, "tenant-a");
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]?.provider_id).toBe("claude");
    });

    test("combo members can be provider/model and respect fallback order", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          cand("haiku-4.5", "claude"),
          cand("haiku-4.5", "openai"),
          cand("gpt-5", "openai"),
        ],
        aliases: {},
        combos: {
          "tenant-a": {
            pool: { members: ["openai/gpt-5", "claude/haiku-4.5"], strategy: "fallback" },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a");
      expect(plan.candidates.map((c) => `${c.provider_id}/${c.model_id}`)).toEqual([
        "openai/gpt-5",
        "claude/haiku-4.5",
      ]);
    });

    test("unknown provider/model throws model_not_found", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("haiku-4.5", "claude")],
        aliases: {},
        combos: {},
      }));
      const engine = new RoutingEngine();
      await expect(engine.plan("openai/haiku-4.5", snap, "tenant-a")).rejects.toMatchObject({
        code: "model_not_found",
      });
    });
  });

  describe("RoutingEngine — multi-account provider routing strategies", () => {
    test("single account per provider preserves fallback ordering", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("gpt-4", "openai"), provider_account_id: "acc1" },
          { ...cand("claude-4", "anthropic"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("gpt-4", snap);
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]?.provider_account_id).toBe("acc1");
    });

    test("multi-account fallback preserves natural candidate ordering", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
          { ...cand("model-1", "openai"), provider_account_id: "acc3" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "fallback",  rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("model-1", snap);
      expect(plan.candidates).toHaveLength(3);
      expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["acc1", "acc2", "acc3"]);
    });

    test("multi-account fallback disables when provider routing disabled", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "fallback",  rotateCount: 1, maxInflight: null, enabled: false, bypassProxy: false },
          },
        },
      }));
      const engine = new RoutingEngine();
      const plan = await engine.plan("model-1", snap);
      expect(plan.candidates).toHaveLength(2);
      expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["acc1", "acc2"]);
    });

    test("multi-account round_robin rotates primary across sequential plans", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
          { ...cand("model-1", "openai"), provider_account_id: "acc3" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "round_robin",  rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));
      const engine = new RoutingEngine();

      // Sequential calls should rotate the primary candidate
      const plan1 = await engine.plan("model-1", snap);
      const plan2 = await engine.plan("model-1", snap);
      const plan3 = await engine.plan("model-1", snap);
      const plan4 = await engine.plan("model-1", snap);

      const first1 = plan1.candidates[0]?.provider_account_id;
      const first2 = plan2.candidates[0]?.provider_account_id;
      const first3 = plan3.candidates[0]?.provider_account_id;
      const first4 = plan4.candidates[0]?.provider_account_id;

      // Should cycle through all three
      expect(first1).toBe("acc1");
      expect(first2).toBe("acc2");
      expect(first3).toBe("acc3");
      expect(first4).toBe("acc1"); // Should wrap around

      // All candidates still present in each plan
      [plan1, plan2, plan3, plan4].forEach((plan) => {
        expect(plan.candidates).toHaveLength(3);
        const ids = new Set(plan.candidates.map((c) => c.provider_account_id));
        expect(ids.size).toBe(3);
        expect(ids.has("acc1")).toBe(true);
        expect(ids.has("acc2")).toBe(true);
        expect(ids.has("acc3")).toBe(true);
      });
    });

    test("round_robin rotateCount keeps one account for N requests", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: {
              strategy: "round_robin",
              
              rotateCount: 2,
              maxInflight: null,
              enabled: true,
              bypassProxy: false,
            },
          },
        },
      }));
      const engine = new RoutingEngine();

      const first = async () =>
        (await engine.plan("model-1", snap)).candidates[0]?.provider_account_id;

      // Two requests stay on acc1, then rotate to acc2.
      expect(await first()).toBe("acc1");
      expect(await first()).toBe("acc1");
      expect(await first()).toBe("acc2");
      expect(await first()).toBe("acc2");
      expect(await first()).toBe("acc1");
    });

    test("multi-account round_robin rotates across accounts", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "round_robin", rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));
      const engine = new RoutingEngine();

      const plan1 = await engine.plan("model-1", snap);
      const plan2 = await engine.plan("model-1", snap);

      // Plans rotate across accounts
      expect(plan1.candidates[0]?.provider_account_id).toBe("acc1");
      expect(plan2.candidates[0]?.provider_account_id).toBe("acc2");
    });

    test("multi-account round_robin falls back when an account is gone", async () => {
      const snap1 = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "round_robin", rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));

      const snap2 = await buildSnapshot(async () => ({
        candidates: [
          // acc1 is no longer available
          { ...cand("model-1", "openai"), provider_account_id: "acc2" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          __global__: {
            openai: { strategy: "round_robin", rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));

      const engine = new RoutingEngine();

      const plan1 = await engine.plan("model-1", snap1);
      expect(plan1.candidates[0]?.provider_account_id).toBe("acc1");

      // Simulate account removal by planning with snap2 but same engine
      const plan2 = await engine.plan("model-1", snap2);
      // When an account is gone, the rotation serves what remains (acc2)
      expect(plan2.candidates[0]?.provider_account_id).toBe("acc2");
    });

    test("multi-account strategies respect tenant isolation", async () => {
      const snap = await buildSnapshot(async () => ({
        candidates: [
          { ...cand("model-1", "openai", "tenant-a"), provider_account_id: "acc1" },
          { ...cand("model-1", "openai", "tenant-a"), provider_account_id: "acc2" },
          { ...cand("model-1", "openai", "tenant-b"), provider_account_id: "acc3" },
          { ...cand("model-1", "openai", "tenant-b"), provider_account_id: "acc4" },
        ],
        aliases: {},
        combos: {},
        providerRouting: {
          "tenant-a": {
            openai: { strategy: "round_robin",  rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
          "tenant-b": {
            openai: { strategy: "fallback",  rotateCount: 1, maxInflight: null, enabled: true, bypassProxy: false },
          },
        },
      }));
      const engine = new RoutingEngine();

      const planA1 = await engine.plan("model-1", snap, "tenant-a");
      const planA2 = await engine.plan("model-1", snap, "tenant-a");
      const planB = await engine.plan("model-1", snap, "tenant-b");

      // Tenant-A uses round_robin: should rotate between acc1 and acc2
      const aIds = new Set(planA1.candidates.map((c) => c.provider_account_id));
      expect(aIds.size).toBe(2);
      expect(aIds.has("acc1")).toBe(true);
      expect(aIds.has("acc2")).toBe(true);
      expect(planA1.candidates[0]?.provider_account_id).not.toBe(
        planA2.candidates[0]?.provider_account_id,
      );

      // Tenant-B uses fallback: should preserve order (acc3 then acc4)
      expect(planB.candidates.map((c) => c.provider_account_id)).toEqual(["acc3", "acc4"]);
    });
  });

  describe("ReservationManager", () => {
    test("get() returns undefined and evicts an expired lease", () => {
      const manager = new ReservationManager();
      const originalNow = Date.now;
      try {
        let current = 1_000_000;
        Date.now = () => current;
        const reservation = manager.acquire(candidate(), 1, 10);
        current += 20;
        expect(manager.get(reservation.lease_id)).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    test("release() removes a lease immediately", () => {
      const manager = new ReservationManager();
      const reservation = manager.acquire(candidate(), 1, 30_000);
      manager.release(reservation.lease_id);
      expect(manager.get(reservation.lease_id)).toBeUndefined();
    });

    test("abandoned expired lease is evicted by a later sweep without ever being read back", () => {
      const manager = new ReservationManager();
      const originalNow = Date.now;
      try {
        let current = 1_000_000;
        Date.now = () => current;
        manager.acquire(candidate(), 1, 10); // expires at 1_000_010
        expect(manager.size()).toBe(1);
        // Advance past both the lease TTL and the sweep interval, then acquire
        // again (without ever calling get()/release() on the first lease) —
        // the sweep inside acquire() must reclaim the abandoned entry.
        current += 40_000;
        manager.acquire(candidate(), 1, 30_000);
        expect(manager.size()).toBe(1);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("RoutingEngine — bounded round-robin state", () => {
    test("caps round-robin entries for a long tail of unique combos", async () => {
      const combos: Record<string, ComboDefinition> = {};
      for (let index = 0; index < 1005; index += 1) {
        combos[`pool-${index}`] = { members: ["model-a", "model-b"], strategy: "round_robin" };
      }
      const snap = await buildSnapshot(async () => ({
        candidates: [cand("model-a", "openai"), cand("model-b", "anthropic")],
        aliases: {},
        combos: { "tenant-a": combos },
      }));
      const engine = new RoutingEngine();
      for (let index = 0; index < 1005; index += 1) {
        await engine.plan(`pool-${index}`, snap, "tenant-a");
      }
      expect(engine.roundRobinEntries().combo).toBe(1000);
      expect(engine.roundRobinEntries().provider).toBe(0);
    });
  });

  describe("RoutingEngine — capability-aware plan filtering (D1)", () => {
    function toolsCapable(id: string, provider: string): RouteCandidate {
      return {
        ...cand(id, provider),
        capability_profile: { tools: true, parallelToolCalls: true },
      };
    }

    async function capabilityPoolSnap(): Promise<RouteSnapshot> {
      return buildSnapshot(async () => ({
        candidates: [toolsCapable("tool-model", "openai"), cand("plain-model", "anthropic")],
        aliases: {},
        combos: {
          "tenant-a": {
            pool: { members: ["tool-model", "plain-model"], strategy: "fallback" },
          },
        },
      }));
    }

    test("excludes a tools-less candidate when tools are required", async () => {
      const snap = await capabilityPoolSnap();
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a", ["tools"]);
      expect(plan.candidates.map((c) => c.model_id)).toEqual(["tool-model"]);
    });

    test("omitting required capabilities keeps the full pool", async () => {
      const snap = await capabilityPoolSnap();
      const engine = new RoutingEngine();
      const plan = await engine.plan("pool", snap, "tenant-a");
      expect(plan.candidates.map((c) => c.model_id)).toEqual(["tool-model", "plain-model"]);
    });

    test("no capable candidate throws capability_unsupported, not model_not_found", async () => {
      const snap = await capabilityPoolSnap();
      const engine = new RoutingEngine();
      await expect(engine.plan("pool", snap, "tenant-a", ["image"])).rejects.toMatchObject({
        code: "capability_unsupported",
      });
    });
  });

});

describe("admission.test.ts", () => {
  const originalEnv = {
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
  };

  describe("Database pool and admission ceiling alignment", () => {
    beforeEach(() => {
      delete process.env.DATABASE_POOL_MAX;
    });

    afterEach(() => {
      if (originalEnv.DATABASE_POOL_MAX !== undefined) {
        process.env.DATABASE_POOL_MAX = originalEnv.DATABASE_POOL_MAX;
      } else {
        delete process.env.DATABASE_POOL_MAX;
      }
    });

    test("poolMaxFromEnv defaults to DEFAULT_BOUNDS.maxPostgresPoolSize", () => {
      // The bound itself is asserted where it is defined; pinning the literal
      // here as well made a deliberate re-tuning of the pool look like a
      // regression.
      expect(poolMaxFromEnv()).toBe(DEFAULT_BOUNDS.maxPostgresPoolSize);
    });

    test("poolMaxFromEnv parses valid DATABASE_POOL_MAX values", () => {
      process.env.DATABASE_POOL_MAX = "50";
      expect(poolMaxFromEnv()).toBe(50);
    });

    test("poolMaxFromEnv rejects invalid or non-positive DATABASE_POOL_MAX", () => {
      process.env.DATABASE_POOL_MAX = "0";
      expect(() => poolMaxFromEnv()).toThrow("DATABASE_POOL_MAX must be a positive integer");

      process.env.DATABASE_POOL_MAX = "-5";
      expect(() => poolMaxFromEnv()).toThrow("DATABASE_POOL_MAX must be a positive integer");

      process.env.DATABASE_POOL_MAX = "abc";
      expect(() => poolMaxFromEnv()).toThrow("DATABASE_POOL_MAX must be a positive integer");
    });

    test("InMemoryAdmissionController treats an absent ceiling as unlimited", async () => {
      const controller = new InMemoryAdmissionController();
      const candidate: RouteCandidate = {
        provider_id: "openai",
        model_id: "gpt-4",

        wire_family: "chat",
        endpoint: "https://api.openai.com/v1/chat/completions",
        capability_profile: {},
      };

      // No `max_inflight` configured means UNLIMITED, not the deployment
      // ceiling — every admission must succeed regardless of volume.
      for (let i = 0; i < 168; i++) {
        const res = await controller.admit(candidate);
        expect(res.admitted).toBe(true);
      }
    });
    });

    test("RedisAdmissionController treats an absent ceiling as unlimited", async () => {
      let sawCeilingedScript = false;
      const fakeRedis = {
        eval: (script: string) => {
          // The unlimited path counts via INCR and never compares against a
          // limit, so no limit argument must ever reach Redis.
          if (script.includes("current >=")) sawCeilingedScript = true;
          return Promise.resolve(1);
        },
      } as unknown as RedisClient;

      const controller = new RedisAdmissionController(fakeRedis);
      const candidate: RouteCandidate = {
        provider_id: "openai",
        model_id: "gpt-4",

        wire_family: "chat",
        endpoint: "https://api.openai.com/v1/chat/completions",
        capability_profile: {},
      };

      const res = await controller.admit(candidate);
      expect(res.admitted).toBe(true);
      expect(sawCeilingedScript).toBe(false);
    });

    // A non-positive ceiling is a configured zero, not another way to spell
    // "unlimited". Both back ends must reach that verdict through the same
    // shared policy instead of each re-deriving what `max_inflight: 0` means.
    test("both controllers reject a non-positive ceiling before reading a counter", async () => {
      const candidate: RouteCandidate = {
        provider_id: "openai",
        model_id: "gpt-4",

        wire_family: "chat",
        endpoint: "https://api.openai.com/v1/chat/completions",
        capability_profile: {},
        max_inflight: 0,
      };

      const inMemory = await new InMemoryAdmissionController().admit(candidate);
      expect(inMemory.admitted).toBe(false);
      expect(inMemory.reason).toBe("capacity_exhausted");

      let evaluated = false;
      const fakeRedis = {
        eval: () => {
          evaluated = true;
          return Promise.resolve(1);
        },
      } as unknown as RedisClient;
      const redis = await new RedisAdmissionController(fakeRedis).admit(candidate);
      expect(redis.admitted).toBe(false);
      expect(redis.reason).toBe("capacity_exhausted");
      // The zero ceiling is decided before the counter is consulted, so a
      // request that can never be admitted costs no script round-trip.
      expect(evaluated).toBe(false);
    });
  });

  describe("RedisAdmissionController", () => {
    const candidate: RouteCandidate = {
      provider_id: "openai",
      model_id: "gpt-4",

      wire_family: "chat",
      endpoint: "https://api.openai.com/v1/chat/completions",
      capability_profile: {},
      max_inflight: 2,
    };

    test("admits up to max_inflight and rejects when capacity is exhausted", async () => {
      let inflight = 0;
      const fakeRedis = {
        eval: (_script: string, _numKeys: number, _key: string, limitStr: string) => {
          const limit = Number(limitStr);
          if (inflight >= limit) return Promise.resolve(0);
          inflight += 1;
          return Promise.resolve(inflight);
        },
      } as unknown as RedisClient;

      const controller = new RedisAdmissionController(fakeRedis);

      const r1 = await controller.admit(candidate);
      expect(r1.admitted).toBe(true);

      const r2 = await controller.admit(candidate);
      expect(r2.admitted).toBe(true);

      const r3 = await controller.admit(candidate);
      expect(r3.admitted).toBe(false);
      expect(r3.reason).toBe("capacity_exhausted");
    });

    test("releases decrement inflight slots", async () => {
      let releasedKey = "";
      const fakeRedis = {
        eval: (_script: string, _numKeys: number, key: string) => {
          releasedKey = key;
          return Promise.resolve(0);
        },
      } as unknown as RedisClient;

      const controller = new RedisAdmissionController(fakeRedis);
      const reservation: Reservation = {
        candidate,
        lease_id: "lease-1",
        acquired_at: Date.now(),
        expires_at: Date.now() + 30_000,
      };

      await controller.release(reservation);
      expect(releasedKey).toBe("admission:inflight:openai:gpt-4");
    });
  });
