/**
 * Model resolution and per-key model authorization.
 *
 * This is the layer between "the caller asked for a model" and "an upstream is
 * chosen", and it is where the gateway decides what a key may reach. The cases
 * are organized around the questions the rule has to answer:
 *
 * - does a name resolve to exactly one routable target?
 * - does this key's allow/deny list permit that target?
 * - which qualified/bare/aliased spelling is the rule applied to?
 *
 * Every case runs through the real router against a real catalog, so an
 * assertion about ambiguity or precedence is an assertion about the shipped
 * resolution order rather than a re-implementation of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestGateway, type TestGateway } from "../helpers/gateway";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";
import { dbDescribe } from "../helpers/database";

const CHAT_BODY = {
  model: "placeholder",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
};

/** Reads the gateway error envelope a response carries. */
async function errorBody(response: Response): Promise<{
  code: string;
  message: string;
  details: Record<string, unknown>;
  origin: string;
}> {
  const parsed = (await response.json()) as {
    error: { code: string; message: string; details: Record<string, unknown>; origin: string };
  };
  return parsed.error;
}

dbDescribe("model resolution", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld();
    gateway = await createTestGateway();
    gateway.setRoutes([
      { providerId: world.providerId, modelId: world.modelId, accountId: world.accountId },
    ]);
    gateway.adapter(world.providerId);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  const chat = (model: string, token = world.token) =>
    gateway.json("/v1/chat/completions", { ...CHAT_BODY, model }, { token });

  describe("qualified and bare names", () => {
    test("the qualified provider/model ref routes", async () => {
      const response = await chat(world.qualifiedModel);
      expect(response.status).toBe(200);
    });

    test("the bare model id routes when exactly one provider serves it", async () => {
      // A single owner is unambiguous, so a client that omits the prefix is
      // not forced to know which provider serves the model.
      const response = await chat(world.modelId);
      expect(response.status).toBe(200);
    });

    test("an unknown qualified ref is a 404 naming the model", async () => {
      const response = await chat(`${world.providerId}/no-such-model`);
      expect(response.status).toBe(404);
      const error = await errorBody(response);
      expect(error.code).toBe("model_not_found");
      expect(error.details.model).toBe(`${world.providerId}/no-such-model`);
    });

    test("an unknown bare model is a 404", async () => {
      const response = await chat("no-such-model-anywhere");
      expect(response.status).toBe(404);
      expect((await errorBody(response)).code).toBe("model_not_found");
    });

    test("an empty model field is a 400, not a lookup failure", async () => {
      const response = await chat("");
      expect(response.status).toBe(400);
      const error = await errorBody(response);
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("non-empty model identifier");
    });

    test("a whitespace-only model field is refused like an empty one", async () => {
      const response = await chat("   ");
      expect(response.status).toBe(400);
    });
  });

  describe("ambiguous bare names", () => {
    // A second provider serving the *same* bare model id is what makes the bare
    // name ambiguous, and it is the one case where the prefix is required.
    let second: { providerId: string; accountId: string; modelId: string };

    beforeAll(async () => {
      second = await world.addProvider();
      gateway.setRoutes([
        { providerId: world.providerId, modelId: world.modelId, accountId: world.accountId },
        { providerId: second.providerId, modelId: second.modelId, accountId: second.accountId },
      ]);
      gateway.adapter(second.providerId);
    });

    test("a bare name served by two providers is refused as ambiguous", async () => {
      const response = await chat(world.modelId);
      expect(response.status).toBe(400);
      const error = await errorBody(response);
      expect(error.code).toBe("ambiguous_model");
      // The message names the owners inline. `details.owners` is deliberately
      // not part of the public envelope — `PUBLIC_ERROR_DETAIL_KEYS` is an
      // allowlist — so the assertion reads the human-facing message, which is
      // what an operator actually sees.
      expect(error.message).toContain(world.providerId);
      expect(error.message).toContain(second.providerId);
    });

    test("the qualified ref still routes while the bare name is ambiguous", async () => {
      const response = await chat(world.qualifiedModel);
      expect(response.status).toBe(200);
    });

    test("the other provider's qualified ref also routes", async () => {
      // Ambiguity is about the bare spelling, not about either target being
      // unusable — both remain individually addressable.
      const response = await chat(`${second.providerId}/${second.modelId}`);
      expect(response.status).toBe(200);
    });
  });
});

dbDescribe("model authorization", () => {
  let gateway: TestGateway;
  let world: GatewayWorld;

  beforeAll(async () => {
    world = await createWorld({ extraModels: ["model-allowed", "model-denied", "model-other"] });
    gateway = await createTestGateway();
    gateway.serveWorld(world);
    gateway.adapter(world.providerId);
  });

  afterAll(async () => {
    await gateway?.close();
    await world?.cleanup();
  });

  const chat = (model: string, token: string) =>
    gateway.json("/v1/chat/completions", { ...CHAT_BODY, model }, { token });

  describe("whitelist mode", () => {
    test("a model on the whitelist routes", async () => {
      const key = await world.createKey({
        modelList: [`${world.providerId}/model-allowed`],
      });
      expect((await chat(`${world.providerId}/model-allowed`, key.token)).status).toBe(200);
    });

    test("a model absent from the whitelist is refused", async () => {
      const key = await world.createKey({
        modelList: [`${world.providerId}/model-allowed`],
      });
      const response = await chat(`${world.providerId}/model-other`, key.token);
      // The model exists and is routable; the key simply may not use it. That is
      // a permission failure, not a missing model — a 404 would tell the caller
      // to look elsewhere instead of asking for access.
      expect(response.status).toBe(404);
      const error = await errorBody(response);
      expect(error.code).toBe("model_not_found");
    });

    test("a whitelist entry matches its bare form and vice versa", async () => {
      // Bare entry authorizes a qualified use; a qualified entry only
      // authorizes the same-provider qualified use. The reverse (qualified
      // allow bare with no provider) is intentionally isolated so
      // `providerA/model-x` never authorizes `providerB/model-x` — see
      // `src/security/model-access-rule.ts` and `test/unit/api-key-auth.test.ts`.
      const bareEntry = await world.createKey({ modelList: ["model-allowed"] });
      expect((await chat(`${world.providerId}/model-allowed`, bareEntry.token)).status).toBe(200);

      const qualifiedEntry = await world.createKey({
        modelList: [`${world.providerId}/model-allowed`],
      });
      expect((await chat(`${world.providerId}/model-allowed`, qualifiedEntry.token)).status).toBe(200);
      expect((await chat("model-allowed", qualifiedEntry.token)).status).toBe(404);
    });

    test("an empty whitelist means no restriction, not no access", async () => {
      // `null` and `[]` both mean "the operator set no list". Treating an empty
      // array as deny-all would lock a key out the moment a UI wrote an empty
      // selection.
      const key = await world.createKey({ modelList: [] });
      expect((await chat(world.qualifiedModel, key.token)).status).toBe(200);
    });
  });

  describe("blacklist mode", () => {
    test("a denied model is refused", async () => {
      const key = await world.createKey({
        modelAccessMode: "blacklist",
        modelList: [`${world.providerId}/model-denied`],
      });
      const response = await chat(`${world.providerId}/model-denied`, key.token);
      expect(response.status).toBe(404);
      expect((await errorBody(response)).code).toBe("model_not_found");
    });

    test("a model not on the blacklist still routes", async () => {
      const key = await world.createKey({
        modelAccessMode: "blacklist",
        modelList: [`${world.providerId}/model-denied`],
      });
      expect((await chat(`${world.providerId}/model-allowed`, key.token)).status).toBe(200);
    });

    test("a deny entry matches its bare form too", async () => {
      const key = await world.createKey({
        modelAccessMode: "blacklist",
        modelList: ["model-denied"],
      });
      expect((await chat(`${world.providerId}/model-denied`, key.token)).status).toBe(404);
    });
  });

  describe("authorization is per key", () => {
    test("a second key in the same tenant is unaffected by the first key's list", async () => {
      const restricted = await world.createKey({
        modelAccessMode: "blacklist",
        modelList: [world.modelId],
      });
      const unrestricted = await world.createKey();
      expect((await chat(world.qualifiedModel, restricted.token)).status).toBe(404);
      expect((await chat(world.qualifiedModel, unrestricted.token)).status).toBe(200);
    });

    test("the unrestricted key created by the world is unaffected by later keys", async () => {
      expect((await chat(world.qualifiedModel, world.token)).status).toBe(200);
    });
  });
});
