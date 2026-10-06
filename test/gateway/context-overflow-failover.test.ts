/**
 * End-to-end proof for a context-window overflow at the real boundary.
 *
 * These run through the real Elysia app, the real router, and the real
 * `runAttemptLoop` — only the upstream is a stub. That is what makes the 413
 * and the failover observable: a unit test on the classifier alone cannot show
 * that a client actually receives 413, or that a sibling candidate is dialed.
 *
 * The payload is the WorkBuddy overflow as reported, whose only statement of
 * the cause is prose.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";
import { GatewayError } from "../../src/protocol/gateway-error";

/** The upstream's overflow body: numeric code, prose-only cause. */
function overflowError(): GatewayError {
  return new GatewayError(
    "context_length_exceeded",
    413,
    "prompt is too long: 100001 tokens > 100000 maximum",
    { providerId: "fixture", providerCode: "11115" },
    "upstream",
  );
}

const CHAT_BODY = {
  model: "placeholder",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

dbDescribe("context overflow at the gateway boundary", () => {
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

  /** Account ids the stub was asked to serve, in dispatch order. */
  const dispatchedAccountIds = (): (string | undefined)[] =>
    (gateway.adapters.get(world.providerId)?.dispatches ?? []).map(
      (record) => record.context.credential.account_id,
    );

  test("an overflow on one candidate fails over to a sibling instead of ending the request", async () => {
    const first = await world.addAccount({ label: "overflowing" });
    const second = await world.addAccount({ label: "healthy" });
    // The first candidate reports the overflow; the second answers normally.
    let attempt = 0;
    gateway.adapter(world.providerId, {
      failWith: () => {
        attempt += 1;
        return attempt === 1 ? overflowError() : undefined;
      },
    });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: first },
      { providerId: world.providerId, modelId: world.modelId, accountId: second },
    ]);

    const response = await gateway.json(
      "/v1/chat/completions",
      { ...CHAT_BODY, model: world.qualifiedModel },
      { token: world.token },
    );
    expect(response.status).toBe(200);
    // Both candidates were dialed: the overflow did not end the request.
    expect(dispatchedAccountIds()).toEqual([first, second]);
  });

  test("when every candidate overflows, the client is told 413 context_length_exceeded", async () => {
    const only = await world.addAccount({ label: "overflowing" });
    gateway.adapter(world.providerId, { failWith: () => overflowError() });
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: only },
    ]);

    const response = await gateway.json(
      "/v1/chat/completions",
      { ...CHAT_BODY, model: world.qualifiedModel },
      { token: world.token },
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("context_length_exceeded");
    // The measured size survives to the client: it is what a compacting client
    // reads to decide how much to drop.
    expect(body.error.message).toContain("100001");
  });
});
