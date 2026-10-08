/**
 * Hard-vs-soft cooldown, failover-on-account-error, and the attempt cap.
 *
 * The previous eligibility suite proved *which* account was reached by reading
 * the adapter dispatch log. This suite extends that contract to the three
 * changes failover depends on:
 *
 * - an account-wide `cooldown` with `cooldown_kind: "hard"` is excluded from
 *   the plan, not deprioritized;
 * - when every candidate is hard-cooled the plan answers
 *   `accounts_rate_limited` (429), not `accounts_unavailable` (503);
 * - an account-scoped failure is retried against a sibling even when the
 *   provider chose a 400 for it;
 * - `CARTETHYIA_ROUTE_MAX_ATTEMPTS` bounds the number of candidates one request
 *   may dial.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { EligibilityEvaluator, RoutingEngine } from "../../src/transport/routing/router";
import { GatewayError } from "../../src/transport/gateway-error";
import type { RouteCandidate, RouteSnapshot } from "../../src/transport/routing/route-model";

const CHAT_BODY = { model: "placeholder", messages: [{ role: "user", content: "hi" }], stream: false };

/** A minimal candidate; only the fields the evaluator reads are meaningful. */
function candidate(overrides: Record<string, unknown> = {}): RouteCandidate {
  return {
    provider_id: "p",
    model_id: "m",
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    ...overrides,
  } as RouteCandidate;
}

/** A snapshot with one provider, one model, and the given candidates. */
function snapshot(candidates: readonly RouteCandidate[]): RouteSnapshot {
  return {
    revision: 1,
    candidates,
    aliases: {},
    combos: {},
    created_at: Date.now(),
  };
}

describe("EligibilityEvaluator cooldown classes", () => {
  const evaluator = new EligibilityEvaluator();

  test("a hard-cooled account is excluded", () => {
    expect(
      evaluator.evaluate(candidate({ health_status: "cooldown", cooldown_kind: "hard" })),
    ).toMatchObject({ eligible: false, reason: "cooldown_hard" });
  });

  test("a soft-cooled account stays eligible", () => {
    expect(
      evaluator.evaluate(candidate({ health_status: "cooldown", cooldown_kind: "soft" })),
    ).toMatchObject({ eligible: true, reason: "cooldown" });
  });

  test("a cooldown with no class keeps the legacy soft behavior", () => {
    expect(evaluator.evaluate(candidate({ health_status: "cooldown" }))).toMatchObject({
      eligible: true,
      reason: "cooldown",
    });
  });
});

describe("RoutingEngine.plan cooldown classes", () => {
  const engine = new RoutingEngine();
  const qualified = "p/m";

  test("a hard-cooled candidate is excluded and a healthy sibling wins", async () => {
    const hard = candidate({
      provider_account_id: "hard",
      health_status: "cooldown",
      cooldown_kind: "hard",
    });
    const healthy = candidate({ provider_account_id: "healthy" });
    const plan = await engine.plan(qualified, snapshot([hard, healthy]));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.provider_account_id).toBe("healthy");
  });

  test("every candidate hard-cooled answers accounts_rate_limited", async () => {
    const a = candidate({
      provider_account_id: "a",
      health_status: "cooldown",
      cooldown_kind: "hard",
    });
    const b = candidate({
      provider_account_id: "b",
      health_status: "cooldown",
      cooldown_kind: "hard",
    });
    await expect(engine.plan(qualified, snapshot([a, b]))).rejects.toMatchObject({
      code: "accounts_rate_limited",
      status: 429,
    });
  });

  test("every candidate disabled answers accounts_unavailable", async () => {
    const off = candidate({ provider_account_id: "off", health_status: "disabled" });
    await expect(engine.plan(qualified, snapshot([off]))).rejects.toMatchObject({
      code: "accounts_unavailable",
      status: 503,
    });
  });

  test("soft-cooled candidates stay eligible and are ordered after healthy ones", async () => {
    const coolA = candidate({
      provider_account_id: "cool-a",
      health_status: "cooldown",
      cooldown_kind: "soft",
    });
    const coolB = candidate({ provider_account_id: "cool-b", health_status: "cooldown" });
    const healthy = candidate({ provider_account_id: "healthy" });
    const plan = await engine.plan(qualified, snapshot([coolA, coolB, healthy]));
    expect(plan.candidates[0]?.provider_account_id).toBe("healthy");
    expect(plan.candidates.slice(1).map((c) => c.provider_account_id)).toEqual([
      "cool-a",
      "cool-b",
    ]);
  });
});
describe("EligibilityEvaluator global credit limit", () => {
  const evaluator = new EligibilityEvaluator();

  test("an account at or below the global limit is excluded", () => {
    expect(
      evaluator.evaluate(candidate({ credit_limit: 100, last_remaining_credit: 100 })),
    ).toMatchObject({ eligible: false, reason: "credit_floor_reached" });
    expect(
      evaluator.evaluate(candidate({ credit_limit: 100, last_remaining_credit: 99 })),
    ).toMatchObject({ eligible: false, reason: "credit_floor_reached" });
  });

  test("an account above the global limit stays eligible", () => {
    expect(
      evaluator.evaluate(candidate({ credit_limit: 100, last_remaining_credit: 101 })),
    ).toMatchObject({ eligible: true, reason: "healthy" });
  });

  test("a disabled global limit never excludes, whatever the balance", () => {
    expect(
      evaluator.evaluate(
        candidate({ credit_limit_enabled: false, credit_limit: 100, last_remaining_credit: 0 }),
      ),
    ).toMatchObject({ eligible: true, reason: "healthy" });
    expect(
      evaluator.evaluate(
        candidate({ credit_limit_enabled: false, credit_limit: 100, last_remaining_percent: 0 }),
      ),
    ).toMatchObject({ eligible: true, reason: "healthy" });
  });

  test("a percent-quota account at or below the floor is excluded", () => {
    expect(
      evaluator.evaluate(candidate({ credit_limit: 60, last_remaining_percent: 60 })),
    ).toMatchObject({ eligible: false, reason: "credit_floor_reached" });
    expect(
      evaluator.evaluate(candidate({ credit_limit: 60, last_remaining_percent: 12 })),
    ).toMatchObject({ eligible: false, reason: "credit_floor_reached" });
    expect(
      evaluator.evaluate(candidate({ credit_limit: 60, last_remaining_percent: 61 })),
    ).toMatchObject({ eligible: true, reason: "healthy" });
  });

  test("an absolute credit wins over percent on the same candidate", () => {
    // An account reporting both compares in credits; the percent stamp is
    // only the fallback for percent-only providers.
    expect(
      evaluator.evaluate(
        candidate({ credit_limit: 100, last_remaining_credit: 500, last_remaining_percent: 5 }),
      ),
    ).toMatchObject({ eligible: true, reason: "healthy" });
    expect(
      evaluator.evaluate(
        candidate({ credit_limit: 100, last_remaining_credit: 50, last_remaining_percent: 95 }),
      ),
    ).toMatchObject({ eligible: false, reason: "credit_floor_reached" });
  });

  test("a depleted account loses to a healthy sibling in plan()", async () => {
    const engine = new RoutingEngine();
    const depleted = candidate({
      provider_account_id: "depleted",
      credit_limit: 100,
      last_remaining_credit: 80,
    });
    const healthy = candidate({ provider_account_id: "healthy" });
    const plan = await engine.plan("p/m", snapshot([depleted, healthy]));
    expect(plan.candidates.map((c) => c.provider_account_id)).toEqual(["healthy"]);
  });

  test("every account below the global limit answers accounts_unavailable", async () => {
    const engine = new RoutingEngine();
    const only = candidate({
      provider_account_id: "only",
      credit_limit: 100,
      last_remaining_credit: 50,
    });
    await expect(engine.plan("p/m", snapshot([only]))).rejects.toMatchObject({
      code: "accounts_unavailable",
      status: 503,
    });
  });

  test("a combo routes its live member despite a dead member", async () => {
    const engine = new RoutingEngine();
    const live = candidate({ provider_id: "cline", model_id: "spark" });
    const snap: RouteSnapshot = {
      revision: 1,
      candidates: [live],
      aliases: {},
      combos: {
        t1: {
          pool: {
            members: ["cline/spark", "meta/ghost-model"],
            strategy: "fallback",
          },
        },
      },
      created_at: Date.now(),
    };
    const plan = await engine.plan("pool", snap, "t1");
    expect(plan.candidates.map((c) => c.provider_id)).toEqual(["cline"]);
  });

  test("a combo whose live member is unusable hides member detail from the client", async () => {
    const engine = new RoutingEngine();
    const down = candidate({
      provider_id: "cline",
      model_id: "spark",
      provider_account_id: "down",
      health_status: "disabled",
    });
    const snap: RouteSnapshot = {
      revision: 1,
      candidates: [down],
      aliases: {},
      combos: {
        t1: {
          pool: {
            members: ["cline/spark", "meta/ghost-model"],
            strategy: "fallback",
          },
        },
      },
      created_at: Date.now(),
    };
    // The public message names only the request and the usable candidates —
    // dead member ids stay server-side (server logs), never the envelope.
    await expect(engine.plan("pool", snap, "t1")).rejects.toThrow(
      "Model 'pool' has no available account (1 candidate(s) unusable: disabled)",
    );
  });
});

dbDescribe("account failover", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  const chat = () =>
    gateway.json("/v1/chat/completions", { ...CHAT_BODY, model: world.qualifiedModel }, {
      token: world.token,
    });

  /** Account ids the stub adapter was asked to serve, in dispatch order. */
  const dispatchedAccountIds = (): (string | undefined)[] =>
    (gateway.adapters.get(world.providerId)?.dispatches ?? []).map(
      (record) => record.context.credential.account_id,
    );

  test("a hard-cooled account is never dialed while a healthy sibling exists", async () => {
    const cooled = await world.addAccount({ label: "cooled" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: cooled,
        healthStatus: "cooldown",
        cooldownKind: "hard",
      },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(200);
    expect(dispatchedAccountIds()).toEqual([healthy]);
  });

  test("every candidate hard-cooled answers 429 without dispatching", async () => {
    const a = await world.addAccount({ label: "cool-a" });
    const b = await world.addAccount({ label: "cool-b" });
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: a,
        healthStatus: "cooldown",
        cooldownKind: "hard",
      },
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: b,
        healthStatus: "cooldown",
        cooldownKind: "hard",
      },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("accounts_rate_limited");
    expect(dispatchedAccountIds()).toEqual([]);
  });

  test("an account-scoped 400 fails over to the healthy sibling", async () => {
    const first = await world.addAccount({ label: "first" });
    const second = await world.addAccount({ label: "second" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: first },
      { providerId: world.providerId, modelId: world.modelId, accountId: second },
    ]);
    gateway.adapter(world.providerId, {
      failWith: (_request, attempt) =>
        attempt === 1
          ? new GatewayError(
              "invalid_request",
              400,
              "bad request from caller",
              { accountScope: true },
              "upstream",
            )
          : undefined,
    });

    const response = await chat();
    expect(response.status).toBe(200);
    const reached = dispatchedAccountIds();
    expect(reached).toContain(first);
    expect(reached.at(-1)).toBe(second);
  });

  test("a provider-scoped 400 is terminal and never reaches a sibling", async () => {
    // Without account evidence the 400 is the caller's problem; retrying cannot
    // change the answer and the previous suite pins that as terminal.
    const first = await world.addAccount({ label: "first" });
    const second = await world.addAccount({ label: "second" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: first },
      { providerId: world.providerId, modelId: world.modelId, accountId: second },
    ]);
    gateway.adapter(world.providerId, {
      failWith: () => new GatewayError("invalid_request", 400, "bad request from caller"),
    });

    const response = await chat();
    expect(response.status).toBe(400);
    expect(dispatchedAccountIds()).toEqual([first]);
  });

  test("a platform_unavailable 502 fails over to a sibling", async () => {
    // The provider's own Responses stream emits a terminal `failed` state whose
    // message is "The model failed to generate a response". `terminalFailure`
    // surfaces it as transport_unavailable/502 — retryable, so the loop must
    // try the next account instead of stopping after the first.
    const first = await world.addAccount({ label: "first" });
    const second = await world.addAccount({ label: "second" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: first },
      { providerId: world.providerId, modelId: world.modelId, accountId: second },
    ]);
    gateway.adapter(world.providerId, {
      failWith: (_request, attempt) =>
        attempt === 1
          ? new GatewayError(
              "transport_unavailable",
              502,
              "The model failed to generate a response",
              {},
              "upstream",
            )
          : undefined,
    });

    const response = await chat();
    expect(response.status).toBe(200);
    const reached = dispatchedAccountIds();
    expect(reached).toContain(first);
    expect(reached.at(-1)).toBe(second);
  });

  test("CARTETHYIA_ROUTE_MAX_ATTEMPTS caps the number of dialed candidates", async () => {
    const ids = await Promise.all([
      world.addAccount({ label: "one" }),
      world.addAccount({ label: "two" }),
      world.addAccount({ label: "three" }),
      world.addAccount({ label: "four" }),
    ]);
    gateway.setRoutes(
      ids.map((accountId) => ({
        providerId: world.providerId,
        modelId: world.modelId,
        accountId,
      })),
    );
    gateway.adapter(world.providerId, {
      failWith: () => new GatewayError("transport_unavailable", 502, "upstream down"),
    });

    const previous = process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS;
    process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS = "2";
    try {
      const response = await chat();
      expect(response.status).toBe(502);
      expect(dispatchedAccountIds()).toEqual([ids[0], ids[1]]);
    } finally {
      if (previous === undefined) delete process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS;
      else process.env.CARTETHYIA_ROUTE_MAX_ATTEMPTS = previous;
    }
  });
});
