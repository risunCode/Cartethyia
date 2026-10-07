/**
 * Repeated-request stability for flagged accounts and inflight capacity.
 *
 * Two operator reports motivate this file, and both are about a decision that
 * must not change between two identical requests:
 *
 * - "exhausted, then it worked on retry": capacity that disappears while
 *   nothing is running. An inflight counter that does not return to zero makes
 *   the second request fail for a reason that no longer exists, and the failure
 *   clears on its own once the TTL expires — which is exactly the "wait a
 *   moment and it works" symptom.
 *
 * - "a flagged account was dialed anyway": a per-model exclusion that holds for
 *   the first request but not the tenth, because something re-reads the flag
 *   without the expiry check or reorders candidates back into the plan.
 *
 * Every test sends the same request repeatedly and reads which account the stub
 * adapter actually reached, so a test cannot pass by succeeding for the wrong
 * reason: it has to succeed *at the same account* every time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

const CHAT_BODY = { model: "placeholder", messages: [{ role: "user", content: "hi" }], stream: false };

describe("repeated requests with flagged accounts", () => {
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
    gateway.json(
      "/v1/chat/completions",
      { ...CHAT_BODY, model: world.qualifiedModel },
      { token: world.token },
    );

  const dispatchedAccountIds = (): (string | undefined)[] =>
    (gateway.adapters.get(world.providerId)?.dispatches ?? []).map(
      (record) => record.context.credential.account_id,
    );

  test("a model-cooldown account is never dialed across repeated requests", async () => {
    const cooled = await world.addAccount({ label: "cooled" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: cooled,
        healthStatus: "model_cooldown",
      },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId);

    for (let i = 0; i < 5; i++) expect((await chat()).status).toBe(200);
    const reached = dispatchedAccountIds();
    expect(reached.length).toBe(5);
    expect(reached).not.toContain(cooled);
    expect(new Set(reached)).toEqual(new Set([healthy]));
  });

  test("inflight capacity is available again once the previous request settles", async () => {
    // A ceiling of 1 with sequential requests is the sharpest probe: if the
    // counter fails to return to zero, request two is refused forever until
    // the TTL self-heals — the "exhausted, then it worked later" report.
    const a = await world.addAccount({ label: "a" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: a, maxInflight: 1 },
    ]);
    gateway.adapter(world.providerId);

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await chat()).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
  });

  test("a capacity-refused candidate falls through to its sibling", async () => {
    // A ceiling of 0 refuses every admission for that account, so this is the
    // failover question in isolation: the refused candidate must not take the
    // request's capacity with it. Asserting only a 200 would pass even if the
    // router had given up at the first refusal, so this reads the account that
    // was actually reached.
    const refused = await world.addAccount({ label: "refused" });
    const sibling = await world.addAccount({ label: "sibling" });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: refused, maxInflight: 0 },
      { providerId: world.providerId, modelId: world.modelId, accountId: sibling },
    ]);
    gateway.adapter(world.providerId);

    const response = await chat();
    expect(response.status).toBe(200);
    const reached = dispatchedAccountIds();
    expect(reached).not.toContain(refused);
    expect(reached).toEqual([sibling]);
  });

  test("one disabled account still leaves the sibling answering", async () => {
    const flagged = await world.addAccount({ label: "flagged" });
    const healthy = await world.addAccount({ label: "healthy" });
    gateway.setRoutes([
      {
        providerId: world.providerId,
        modelId: world.modelId,
        accountId: flagged,
        healthStatus: "disabled",
      },
      { providerId: world.providerId, modelId: world.modelId, accountId: healthy },
    ]);
    gateway.adapter(world.providerId);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await chat()).status);
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(dispatchedAccountIds()).not.toContain(flagged);
  });
});
