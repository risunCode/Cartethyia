import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../../src/transport/gateway-error";
import {
  ambiguousModelError,
  capabilityUnsupportedError,
  capacityExhaustedError,
  modelNotFoundError,
  InMemoryRouteSnapshotService,
  type RouteCandidate,
} from "../../../src/transport/routing/route-model";

describe("contracts.test.ts", () => {
  describe("routing typed failures", () => {
    test("ambiguous_model preserves owners", () => {
      const err = ambiguousModelError("gpt-4", ["openai", "anthropic"]);
      expect(err.code).toBe("ambiguous_model");
      expect(err.status).toBe(400);
      expect((err.details as { owners: string[] }).owners).toEqual(["openai", "anthropic"]);
    });

    test("model_not_found preserves requested", () => {
      const err = modelNotFoundError("unknown-model");
      expect(err.code).toBe("model_not_found");
      expect(err.status).toBe(404);
    });

    test("capability_unsupported", () => {
      const err = capabilityUnsupportedError("tools");
      expect(err.code).toBe("capability_unsupported");
    });

    test("capacity_exhausted is 429", () => {
      expect(capacityExhaustedError().status).toBe(429);
    });

    test("GatewayError is instance of Error", () => {
      expect(ambiguousModelError("m", [])).toBeInstanceOf(GatewayError);
      expect(ambiguousModelError("m", [])).toBeInstanceOf(Error);
    });
  });
});

describe("snapshot.test.ts", () => {
  function cand(id: string): RouteCandidate {
    return {
      provider_id: "openai",
      model_id: id,
      wire_family: "chat",
      endpoint: "/v1/chat/completions",
      capability_profile: {},
    };
  }

  describe("RouteSnapshotService", () => {
    test("simultaneous reads await one build", async () => {
      let builds = 0;
      const gate = Promise.withResolvers<void>();
      const svc = new InMemoryRouteSnapshotService(async () => {
        builds++;
        await gate.promise;
        return { candidates: [cand("a")], aliases: {}, combos: {} };
      });
      const p1 = svc.getSnapshot();
      const p2 = svc.getSnapshot();
      const p3 = svc.getSnapshot();
      gate.resolve();
      const [a, b, c] = await Promise.all([p1, p2, p3]);
      expect(builds).toBe(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a.revision).toBe(0);
    });

    test("invalidate increments revision and new readers see new snapshot", async () => {
      let version = 0;
      const svc = new InMemoryRouteSnapshotService(async () => ({
        candidates: [cand(`v${version++}`)],
        aliases: {},
        combos: {},
      }));
      const s0 = await svc.getSnapshot();
      const rev = await svc.invalidate();
      expect(rev).toBe(1);
      const s1 = await svc.getSnapshot();
      expect(s1.revision).toBe(1);
      expect(s1.candidates[0]?.model_id).not.toBe(s0.candidates[0]?.model_id);
      expect(Object.isFrozen(s1)).toBe(true);
      expect(Object.isFrozen(s1.candidates)).toBe(true);
    });

    test("an invalidate during an in-flight build is not lost", async () => {
      let version = 0;
      const gate = Promise.withResolvers<void>();
      const svc = new InMemoryRouteSnapshotService(async () => {
        const v = version++;
        // The first build is held open so a mutation can invalidate while a
        // request is still reading the pre-mutation catalog.
        if (v === 0) await gate.promise;
        return { candidates: [cand(`v${v}`)], aliases: {}, combos: {} };
      });
      const inFlight = svc.getSnapshot();
      await Promise.resolve();
      expect(await svc.invalidate()).toBe(1);
      // A reader that arrives after the mutation must not be handed the
      // pre-mutation build that is still in flight.
      const afterMutation = svc.getSnapshot();
      gate.resolve();
      const [before, after] = await Promise.all([inFlight, afterMutation]);
      expect(before.revision).toBe(0);
      expect(after.revision).toBe(1);
      expect(after.candidates[0]?.model_id).toBe("v1");
      // The stale build must not have overwritten the newer cache entry.
      const cached = await svc.getSnapshot();
      expect(cached.revision).toBe(1);
      expect(cached.candidates[0]?.model_id).toBe("v1");
    });

    test("forwards builder poolRouting into the snapshot, deep-frozen", async () => {
      const svc = new InMemoryRouteSnapshotService(async () => ({
        candidates: [cand("a")],
        aliases: {},
        combos: {},
        poolRouting: { "t-1": { strategy: "round_robin", rotateCount: 4 } },
      }));
      const s = await svc.getSnapshot();
      expect(s.poolRouting).toEqual({ "t-1": { strategy: "round_robin", rotateCount: 4 } });
      expect(Object.isFrozen(s.poolRouting)).toBe(true);
      expect(Object.isFrozen(s.poolRouting?.["t-1"])).toBe(true);
    });

    test("omits poolRouting entirely when the builder leaves it out", async () => {
      const svc = new InMemoryRouteSnapshotService(async () => ({
        candidates: [cand("a")],
        aliases: {},
        combos: {},
      }));
      const s = await svc.getSnapshot();
      expect("poolRouting" in s).toBe(false);
      expect(s.poolRouting).toBeUndefined();
    });

  });
});
