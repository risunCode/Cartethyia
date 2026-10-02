/**
 * Account eligibility, ordering, and failover.
 *
 * The router decides which account serves a request, and the decision has three
 * distinct outcomes that are easy to conflate and expensive to get wrong:
 *
 * - a **hard exclusion** (disabled, locked, model-scoped cooldown) must never be
 *   dispatched to at all;
 * - a **cooling** account stays eligible but is ordered *after* every healthy
 *   sibling, so it is reached only when nothing better is left;
 * - when **nothing** but cooling accounts remain, the answer is a 429 so the
 *   client retries after the reset — not a 503, and never a dispatch to an
 *   account that just refused this exact request.
 *
 * The last case is the one the previous suite got wrong by asserting only that
 * a request succeeded: whether it succeeded by failing over or by dialing the
 * cooled account is the whole question. Every assertion here therefore reads
 * the adapter's dispatch log, so it proves *which* account was reached.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { EligibilityEvaluator } from "../../src/transport/routing/router";
import { GatewayError } from "../../src/transport/gateway-error";
import type { RouteCandidate } from "../../src/transport/routing/route-model";

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

describe("EligibilityEvaluator", () => {
  const evaluator = new EligibilityEvaluator();

  test("an active account is healthy", () => {
    expect(evaluator.evaluate(candidate({ health_status: "active" }))).toMatchObject({
      eligible: true,
      reason: "healthy",
    });
  });

  test("an absent health status is treated as healthy", () => {
    // Every pre-existing catalog row has no `health_status`; treating absence as
    // unhealthy would take the whole fleet out of service on deploy.
    expect(evaluator.evaluate(candidate()).eligible).toBe(true);
  });

  test("a disabled account is excluded", () => {
    expect(evaluator.evaluate(candidate({ health_status: "disabled" }))).toMatchObject({
      eligible: false,
      reason: "disabled",
    });
  });

  test("a locked account is excluded regardless of health", () => {
    // `locked` is an operator/in-flight hold; it outranks the health machine.
    expect(evaluator.evaluate(candidate({ account_locked: true }))).toMatchObject({
      eligible: false,
      reason: "locked",
    });
    expect(evaluator.evaluate(candidate({ locked: true })).eligible).toBe(false);
  });

  test("a locked account is excluded even when it is also healthy", () => {
    expect(
      evaluator.evaluate(candidate({ account_locked: true, health_status: "active" })).eligible,
    ).toBe(false);
  });

  test("a cooling account stays eligible, ordered last", () => {
    // Excluding it made the gateway answer `accounts_unavailable` while a
    // usable credential sat idle, so cooling must remain eligible.
    expect(evaluator.evaluate(candidate({ health_status: "cooldown" }))).toMatchObject({
      eligible: true,
      reason: "cooldown",
    });
  });

  test("a model-scoped cooldown is a hard exclusion", () => {
    // Distinct from `cooldown`: the upstream said *this account and this model*
    // are exhausted until a named reset. Retrying inside that window can only
    // reproduce the refusal.
    expect(evaluator.evaluate(candidate({ health_status: "model_cooldown" }))).toMatchObject({
      eligible: false,
      reason: "model_cooldown",
    });
  });

  test("filter drops exactly the ineligible candidates", () => {
    const kept = evaluator.filter([
      candidate({ health_status: "active" }),
      candidate({ health_status: "disabled" }),
      candidate({ health_status: "cooldown" }),
      candidate({ health_status: "model_cooldown" }),
      candidate({ account_locked: true }),
    ]);
    expect(kept.length).toBe(2);
  });

  test("the decision carries the candidate it judged", () => {
    // The caller orders on `reason` and needs the candidate back; returning a
    // detached decision would force a second lookup.
    const target = candidate({ health_status: "cooldown" });
    expect(evaluator.evaluate(target).candidate).toBe(target);
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

  /**
   * Reads the account ids the stub adapter was asked to serve, in order.
   *
   * The account id travels on the resolved credential, not on the dispatch
   * target: `proxy-request.ts` builds `providerRouteCandidate` from the routing
   * fields and deliberately leaves the account out of it, because the adapter
   * receives the account through `context.credential.account_id`. Reading it
   * from the credential is therefore reading the same value the adapter uses to
   * pick its upstream auth.
   */
  const dispatchedAccountIds = (): (string | undefined)[] =>
    (gateway.adapters.get(world.providerId)?.dispatches ?? []).map(
      (record) => record.context.credential.account_id,
    );

  test("a single healthy account serves the request", async () => {
    const accountId = await world.addAccount({ label: "only" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId },
    ]);
    gateway.adapter(world.providerId);
    const response = await chat();
    expect(response.status).toBe(200);
    expect(dispatchedAccountIds()).toEqual([accountId]);
  });

  test("a failing account fails over to the healthy sibling", async () => {
    const failing = await world.addAccount({ label: "failing" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: failing },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId, {
      failWith: (_request, attempt) =>
        attempt === 1 ? new Error("upstream exploded") : undefined,
    });

    const response = await chat();
    expect(response.status).toBe(200);
    // The proof: the failing account was tried, then the healthy one answered.
    // Asserting only the 200 would pass even if the retry had gone nowhere.
    const reached = dispatchedAccountIds();
    expect(reached).toContain(failing);
    expect(reached.at(-1)).toBe(healthy);
  });

  test("a model-scoped cooldown excludes that account but not its siblings", async () => {
    // The account is cooling for this model, so it must not be dialed at all —
    // while a sibling serving the same model still answers.
    const cooled = await world.addAccount({ label: "cooled" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: cooled,
        // The catalog projects an unexpired per-model entry onto the candidate
        // as `health_status: "model_cooldown"`.
        healthStatus: "model_cooldown",
      },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(200);
    const reached = dispatchedAccountIds();
    expect(reached).not.toContain(cooled);
    expect(reached.at(-1)).toBe(healthy);
  });

  test("every candidate cooling answers 429 rather than dialing one", async () => {
    // The end state the operator reported as "still hit a cooled-down account,
    // never failed over": with nothing healthy left, the honest answer is
    // "rate limited, retry after the reset".
    const a = await world.addAccount({ label: "cool-a" });
    const b = await world.addAccount({ label: "cool-b" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: a, healthStatus: "cooldown" },
      { providerId: world.providerId, modelId: world.modelId, accountId: b, healthStatus: "cooldown" },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("accounts_rate_limited");
    expect(dispatchedAccountIds()).toEqual([]);
  });

  test("every candidate disabled answers accounts_unavailable", async () => {
    // A 404 would tell the client the model does not exist, which is false: the
    // model exists and every account serving it is switched off.
    const a = await world.addAccount({ label: "off-a", status: "disabled" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: a, healthStatus: "disabled" },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("accounts_unavailable");
    expect(dispatchedAccountIds()).toEqual([]);
  });

  test("a healthy account is preferred over a cooling sibling", async () => {
    // Ordering is what carries the intent: the healthy account must be first
    // even when the cooling one appears earlier in the catalog.
    const cooling = await world.addAccount({ label: "cooling" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: cooling, healthStatus: "cooldown" },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId);

    expect((await chat()).status).toBe(200);
    // The healthy account answered, and the cooling one was never dialed: a
    // first-attempt success means the ordering put it first.
    expect(dispatchedAccountIds()).toEqual([healthy]);
  });

  test("a single cooling account answers 429 rather than dialing it", async () => {
    // Measured end state, and the reason the suite reads the dispatch log:
    // `plan()` throws `accountsRateLimitedError` whenever *no* eligible
    // candidate is non-cooling — including the case where the only account is
    // the cooling one. So there is no "single cooling account still serves"
    // behavior; a lone cooling account is a 429.
    //
    // Note the comment further down `plan()` ("a deployment whose only account
    // is cooling still routes instead of failing") contradicts the `healthyCount
    // === 0` throw a few lines above it. The throw is what runs; the stale
    // sentence is the drift.
    const cooling = await world.addAccount({ label: "only-cooling" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: cooling, healthStatus: "cooldown" },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("accounts_rate_limited");
    expect(dispatchedAccountIds()).toEqual([]);
  });

  test("a non-retryable upstream failure is not retried against a sibling", async () => {
    // A 400-class failure is the caller's problem; retrying it on another
    // account multiplies the provider's load and cannot change the answer.
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
    // Exactly one attempt: the second account was never dialed.
    expect(dispatchedAccountIds()).toEqual([first]);
  });
});
