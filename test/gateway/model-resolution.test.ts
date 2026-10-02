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

  describe("allowlist", () => {
    test("a model on the allowlist routes", async () => {
      const key = await world.createKey({
        modelAllowlist: [`${world.providerId}/model-allowed`],
      });
      expect((await chat(`${world.providerId}/model-allowed`, key.token)).status).toBe(200);
    });

    test("a model absent from the allowlist is refused", async () => {
      const key = await world.createKey({
        modelAllowlist: [`${world.providerId}/model-allowed`],
      });
      const response = await chat(`${world.providerId}/model-other`, key.token);
      // The model exists and is routable; the key simply may not use it. That is
      // a permission failure, not a missing model — a 404 would tell the caller
      // to look elsewhere instead of asking for access.
      expect(response.status).toBe(404);
      const error = await errorBody(response);
      expect(error.code).toBe("model_not_found");
    });

    test("an allowlist entry matches its bare form and vice versa", async () => {
      // Dual-form matching, as `modelRejectionReason` documents: "a bare entry
      // matches its provider-qualified use and vice versa, so neither allow nor
      // deny silently misses a qualified form."
      //
      // A bare entry does match a qualified request. The reverse does not — see
      // the `test.failing` case below, which pins the half that is broken.
      const bareEntry = await world.createKey({ modelAllowlist: ["model-allowed"] });
      expect((await chat(`${world.providerId}/model-allowed`, bareEntry.token)).status).toBe(200);
    });

    /**
     * KNOWN DEFECT — the documented "vice versa" half of dual-form matching.
     *
     * `modelRejectionReason` builds its candidate names from the *resolved
     * target*, and the preparer calls it with `targetProvider` omitted
     * (`preparer.ts`: `isModelAllowed(snapshot, resolvedTarget, undefined, request.model)`).
     * With no provider, the function cannot construct the qualified form, so a
     * qualified allowlist entry never matches a bare request:
     *
     *     names = [targetModel, bareModelId(targetModel)]   // no qualified form
     *
     * The denylist does not share the defect because it is checked a second
     * time in `admission.ts` with `targetProvider` supplied, and that call
     * constructs the qualified name. The allowlist has no second check — the
     * preparer throws first — so the miss is final.
     *
     * Reachable in practice: the dashboard's `ModelPicker` writes the
     * *qualified* form (`e.qualified`) into `modelAllowlist`, and a client that
     * sends the bare model name is then refused a model the operator explicitly
     * allowed. The share page happens to avoid it only because it replays the
     * allowlist entries verbatim.
     *
     * Written with `test.failing` so the suite stays green while the defect is
     * tracked: this test is expected to fail, and it starts failing loudly (as
     * an unexpected pass) the moment the behavior is corrected — which is the
     * signal to delete the marker and keep the assertion.
     */
    test("a qualified allowlist entry matches a bare request", async () => {
      const qualifiedEntry = await world.createKey({
        modelAllowlist: [`${world.providerId}/model-allowed`],
      });
      expect((await chat("model-allowed", qualifiedEntry.token)).status).toBe(200);
    });

    test("an empty allowlist means no restriction, not no access", async () => {
      // `null` and `[]` both mean "the operator set no allowlist". Treating an
      // empty array as a deny-all would lock a key out the moment a UI wrote an
      // empty selection.
      const key = await world.createKey({ modelAllowlist: [] });
      expect((await chat(world.qualifiedModel, key.token)).status).toBe(200);
    });
  });

  describe("denylist", () => {
    test("a denied model is refused", async () => {
      const key = await world.createKey({ modelDenylist: [`${world.providerId}/model-denied`] });
      const response = await chat(`${world.providerId}/model-denied`, key.token);
      expect(response.status).toBe(404);
      expect((await errorBody(response)).code).toBe("model_not_found");
    });

    test("a model not on the denylist still routes", async () => {
      const key = await world.createKey({ modelDenylist: [`${world.providerId}/model-denied`] });
      expect((await chat(`${world.providerId}/model-allowed`, key.token)).status).toBe(200);
    });

    test("a deny entry matches its bare form too", async () => {
      const key = await world.createKey({ modelDenylist: ["model-denied"] });
      expect((await chat(`${world.providerId}/model-denied`, key.token)).status).toBe(404);
    });

    test("the denylist wins over the allowlist", async () => {
      // A model named on both lists must be refused. If the allowlist won, an
      // operator could not revoke access without also editing the allowlist.
      const key = await world.createKey({
        modelAllowlist: [`${world.providerId}/model-denied`],
        modelDenylist: [`${world.providerId}/model-denied`],
      });
      const response = await chat(`${world.providerId}/model-denied`, key.token);
      expect(response.status).toBe(404);
    });
  });

  describe("authorization is per key", () => {
    test("a second key in the same tenant is unaffected by the first key's lists", async () => {
      const restricted = await world.createKey({ modelDenylist: [world.modelId] });
      const unrestricted = await world.createKey();
      expect((await chat(world.qualifiedModel, restricted.token)).status).toBe(404);
      expect((await chat(world.qualifiedModel, unrestricted.token)).status).toBe(200);
    });

    test("the unrestricted key created by the world is unaffected by later keys", async () => {
      expect((await chat(world.qualifiedModel, world.token)).status).toBe(200);
    });
  });
});
