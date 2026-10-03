// Network-pool control-plane HTTP routes. The only module that touches Elysia.
import { Elysia, t } from "elysia";
import { consoleErrorHandler } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { RELAY_TARGETS, type RelayDeployRequest } from "./relay-deploy";
import { SPEED_TEST_DEFAULT_BYTES } from "./speed-test-sizes";
import {
  MAX_BATCH_PROBE_TARGETS,
  POOL_KINDS,
  POOL_ROUTING_STRATEGIES,
  POOL_STATUSES,
  type CreateNetworkPoolRequest,
  type NetworkPoolConfig,
  type PoolStrategySetting,
} from "./contracts";
import { createNetworkPoolOperations } from "./operations";

const poolKindSchema = literalUnion(POOL_KINDS);
const createPoolBody = t.Object({
  kind: poolKindSchema,
  label: t.Optional(t.String()),
  endpoint: t.String(),
  credential: t.Optional(t.String()),
  maxInflight: t.Optional(t.Number()),
  weight: t.Optional(t.Number()),
  status: t.Optional(literalUnion(POOL_STATUSES)),
  config: t.Optional(t.Record(t.String(), t.Unknown())),
  /** Egress allowance in bytes; `null` clears it back to unmetered. */
  quotaBytes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
});
const deployRelayBody = t.Object({
  target: literalUnion(RELAY_TARGETS),
  token: t.String({ minLength: 1 }),
  accountId: t.Optional(t.String()),
  projectName: t.Optional(t.String()),
});
const testBatchBody = t.Object({
  targets: t.Array(createPoolBody, { minItems: 1, maxItems: MAX_BATCH_PROBE_TARGETS }),
});
const updatePoolBody = t.Partial(createPoolBody);
export function createNetworkPoolRoutes(config: NetworkPoolConfig): Elysia {
  const factory = createNetworkPoolOperations(config);
  return new Elysia({ prefix: "/network/pools" })
    .error(consoleErrorHandler("Network pool operation failed"))
    .get("/", async ({ request }) => {
      return await factory.listPools(config.accessResolver(request));
})
    .get("/:poolId", async ({ request, params }) => {
      return await factory.getPoolDetail(config.accessResolver(request), params.poolId);
})
    .post("/", { body: createPoolBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})
    .patch("/:poolId", { body: updatePoolBody }, async ({ request, params, body }) => {
      return await factory.updatePool(
        config.accessResolver(request),
        params.poolId,
        body as Partial<CreateNetworkPoolRequest>,
      );
})
    .delete("/:poolId", async ({ request, params }) => {
      return await factory.deletePool(config.accessResolver(request), params.poolId);
})
    .get("/:poolId/health-events", async ({ request, params }) => {
      return await factory.listPoolHealthEvents(config.accessResolver(request), params.poolId);
})
    .post("/:poolId/recover", async ({ request, params }) => {
      return await factory.recoverPool(config.accessResolver(request), params.poolId);
})
    .post("/:poolId/health-check", async ({ request, params }) => {
      return await factory.healthCheck(config.accessResolver(request), params.poolId);
})
    .post(
      "/:poolId/speed-test",
      { body: t.Optional(t.Object({ bytes: t.Optional(t.Number()) })) },
      async ({ request, params, body }) => {
        return await factory.speedTest(
          config.accessResolver(request),
          params.poolId,
          body?.bytes ?? SPEED_TEST_DEFAULT_BYTES,
        );
      },
    )
    .post("/test", { body: createPoolBody }, async ({ request, body }) => {
      return await factory.probeAdHocPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})
    .post("/test-batch", { body: testBatchBody }, async ({ request, body }) => {
      return await factory.probeAdHocPoolBatch(
        config.accessResolver(request),
        body.targets as CreateNetworkPoolRequest[],
      );
})
    .post(
      "/:poolId/cooldowns/clear",
      { body: t.Optional(t.Object({ providerId: t.Optional(t.String()) })) },
      async ({ request, params, body }) => {
        return await factory.clearPoolCooldown(
          config.accessResolver(request),
          params.poolId,
          body?.providerId,
        );
},
    )
    .post("/relay/deploy", { body: deployRelayBody }, async ({ request, body }) => {
      return await factory.deployRelay(config.accessResolver(request), body as RelayDeployRequest);
    })
    .get("/strategy", async ({ request }) => {
      return await factory.getStrategy(config.accessResolver(request));
})
    .patch(
      "/strategy",
      {
        body: t.Object({
          strategy: t.Optional(literalUnion(POOL_ROUTING_STRATEGIES)),
          rotateCount: t.Optional(t.Number()),
        }),
      },
      async ({ request, body }) => {
        return await factory.updateStrategy(
          config.accessResolver(request),
          body as Partial<PoolStrategySetting>,
        );
},
    ) as unknown as Elysia;
}
