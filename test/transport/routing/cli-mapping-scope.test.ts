import { describe, expect, test } from "bun:test";

import { RoutingEngine } from "../../../src/transport/routing/router";
import { InMemoryRouteSnapshotService, type RouteSnapshot } from "../../../src/transport/routing/route-model";

function snapshot(): RouteSnapshot {
  return {
    revision: 1,
    created_at: Date.now(),
    candidates: [
      {
        provider_id: "workbuddy",
        model_id: "hy4-preview-f",
        wire_family: "chat",
        endpoint: "/v1/chat/completions",
        capability_profile: {},
      },
    ],
    aliases: {},
    cli_aliases: { tenant: { sonnet: "workbuddy/hy4-preview-f" } },
    combos: {},
  };
}

  test("preserves CLI mappings through the in-memory snapshot cache", async () => {
    const service = new InMemoryRouteSnapshotService(async () => {
      const { revision: _revision, created_at: _createdAt, ...built } = snapshot();
      return built;
    });
    const cached = await service.getSnapshot();
    expect(cached.cli_aliases?.tenant?.sonnet).toBe("workbuddy/hy4-preview-f");
  });

describe("API-key scoped CLI model mappings", () => {
  test("does not apply CLI mappings without the explicit feature gate", async () => {
    await expect(new RoutingEngine().plan("sonnet", snapshot(), "tenant")).rejects.toMatchObject({
      code: "model_not_found",
    });
  });

  test("applies CLI mappings when the request has the feature gate", async () => {
    const plan = await new RoutingEngine().plan("sonnet", snapshot(), "tenant", undefined, true);
    expect(plan.resolved_model).toBe("workbuddy/hy4-preview-f");
  });
});
