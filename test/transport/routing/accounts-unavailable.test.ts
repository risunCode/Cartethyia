import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../../src/transport/routing/route-model";

const acct = (
  id: string,
  health?: "cooldown" | "unhealthy" | "degraded" | "disabled",
): RouteCandidate => ({
  provider_id: "cb",
  model_id: "deepseek-v4.1-flash",
  wire_family: "chat",
  endpoint: "/v1/chat/completions",
  capability_profile: {
    tools: true,
    reasoning: true,
    vision: false,
    streaming: true,
    input_modalities: ["text"],
    output_modalities: ["text"],
    generation_controls: new Set(),
    context_window: 1000,
    max_output_tokens: 1000,
  } as never,
  provider_account_id: id,
  ...(health === undefined ? {} : { health_status: health }),
});

const snap = (cs: RouteCandidate[]): RouteSnapshot =>
  ({ revision: 1, candidates: cs, combos: {}, aliases: {} }) as never as RouteSnapshot;

describe("exhausted models report unavailable, not missing", () => {
  test("all accounts in cooldown => 503 accounts_unavailable (not 404)", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "cooldown"), acct("B", "cooldown")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number; message?: string },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);
    expect(err?.message).toContain("cb/deepseek-v4.1-flash");
  });

  test("degraded accounts stay excluded until explicitly recovered", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "degraded")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);

    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A")]),
      null,
      [],
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.provider_account_id).toBe("A");
  });

  test("no candidate at all => still a genuine 404 model_not_found", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/nope-model", snap([]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(err?.code).toBe("model_not_found");
    expect(err?.status).toBe(404);
  });

  test("one account recovers => the plan routes to it immediately", async () => {
    const engine = new RoutingEngine();
    const err1 = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "cooldown"), acct("B", "cooldown")]), null, [])
      .then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    expect(err1?.code).toBe("accounts_unavailable");
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B")]),
      null,
      [],
    );
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.provider_account_id).toBe("B");
  });
});
