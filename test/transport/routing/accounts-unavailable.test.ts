import { describe, expect, test } from "bun:test";
import { RoutingEngine } from "../../../src/transport/routing/router";
import type { RouteCandidate, RouteSnapshot } from "../../../src/transport/routing/route-model";

const acct = (
  id: string,
  health?: "cooldown" | "disabled",
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
  test("all accounts cooling still plan, and the cooling account is chosen", async () => {
    // Cooling is a deprioritization, not an exclusion: the account recently
    // failed, but it can still serve the request. Excluding it made a
    // single-account deployment answer 503 while a usable credential sat idle —
    // reported as "cooldown blocks the account completely". A plan that refuses
    // to route through its own only account is worse than one that retries it.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B", "cooldown")]),
      null,
      [],
    );
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates[0]?.provider_account_id).toBe("A");
  });

  test("a healthy account is preferred over a cooling one", async () => {
    // The whole point of keeping a cooling account in the plan: it must be a
    // fallback, never the first choice while a healthy sibling exists.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B")]),
      null,
      [],
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["B", "A"]);
  });

  test("the cooling account stays last even when it is the first candidate", async () => {
    // Ordering must not depend on the snapshot's own order: the deprioritized
    // account is moved to the back whichever position it arrived in.
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B"), acct("C")]),
      null,
      [],
    );
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["B", "C", "A"]);
  });

  test("disabled accounts stay excluded until explicitly recovered", async () => {
    const engine = new RoutingEngine();
    const err = await engine
      .plan("cb/deepseek-v4.1-flash", snap([acct("A", "disabled")]), null, [])
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

  test("every account unusable for a hard reason => 503 accounts_unavailable", async () => {
    // `disabled` remains a hard exclusion — an operator decision that only an
    // operator reverses. When nothing is left to try, the error is still
    // "unavailable", never a 404.
    const engine = new RoutingEngine();
    const err = await engine
      .plan(
        "cb/deepseek-v4.1-flash",
        snap([acct("A", "disabled"), acct("B", "disabled")]),
        null,
        [],
      )
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number; message?: string },
      );
    expect(err?.code).toBe("accounts_unavailable");
    expect(err?.status).toBe(503);
    expect(err?.message).toContain("cb/deepseek-v4.1-flash");
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

  test("one account recovers => the plan routes to it first", async () => {
    const engine = new RoutingEngine();
    const plan = await engine.plan(
      "cb/deepseek-v4.1-flash",
      snap([acct("A", "cooldown"), acct("B")]),
      null,
      [],
    );
    expect(plan.candidates[0]?.provider_account_id).toBe("B");
    expect(plan.candidates).toHaveLength(2);
  });
});
