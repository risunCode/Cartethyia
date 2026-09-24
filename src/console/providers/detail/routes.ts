import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import type { AccessDecision } from "../../../security/access-control";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../catalog/contracts";
import type { ProviderDetailConfig } from "./contracts";
import { ROUTING_STRATEGIES } from "../../../transport/routing/route-model";

/**
 * Routing-tuning bounds, declared once because two layers enforce them: the
 * Elysia body schema rejects an out-of-range value with 422 before the handler
 * runs, and `updateRouting` throws the typed `ConsoleDomainError` for callers
 * that reach it directly. Two copies of a bound drift; one cannot — and the
 * error text is templated from it for the same reason.
 */
const ROUTING_BOUNDS = {
  rotateCount: { min: 1, max: 1000 },
  maxInflight: { min: 1, max: 10000 },
} as const;

export function createProviderDetailOperations(deps: ProviderDetailConfig) {
  const operations = {
    async getRouting(
      access: AccessDecision | undefined,
      providerId: string,
    ): Promise<ProviderRoutingResponse> {
      const a = requireTenantScope(access, "dashboard:read");
      return deps.store.getRouting(providerId, a.tenantId);
    },
    async updateRouting(
      access: AccessDecision | undefined,
      providerId: string,
      patch: UpdateProviderRoutingRequest,
    ): Promise<ProviderRoutingResponse> {
      const a = requireTenantScope(access, "dashboard:write");
      if (patch.strategy && !(ROUTING_STRATEGIES as readonly string[]).includes(patch.strategy)) {
        throw new ConsoleDomainError("invalid_request", 400, "Invalid strategy");
      }
      const { rotateCount, maxInflight } = ROUTING_BOUNDS;
      if (patch.rotateCount !== undefined) {
        if (
          !Number.isInteger(patch.rotateCount) ||
          patch.rotateCount < rotateCount.min ||
          patch.rotateCount > rotateCount.max
        ) {
          throw new ConsoleDomainError(
            "invalid_rotate_count",
            400,
            `rotateCount must be ${rotateCount.min}-${rotateCount.max}`,
          );
        }
      }
      if (patch.maxInflight !== undefined && patch.maxInflight !== null) {
        if (
          !Number.isInteger(patch.maxInflight) ||
          patch.maxInflight < maxInflight.min ||
          patch.maxInflight > maxInflight.max
        )
          throw new ConsoleDomainError(
            "invalid_max_inflight",
            400,
            `maxInflight must be an integer between ${maxInflight.min} and ${maxInflight.max}, or null`,
          );
      }
      const updated = await deps.store.updateRouting(providerId, a.tenantId, patch);
      await deps.auditSink?.record({
        access: a,
        action: "provider.routing.updated",
        target: providerId,
        detail: patch as Record<string, unknown>,
      });
      await deps.snapshotInvalidator?.invalidate();
      return updated;
    },
  };
  return operations;
}

function providerDetailErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Provider detail operation failed", {
    detailsPolicy: "include-if-present",
  });
}

const updateRoutingBody = t.Object({
  strategy: t.Optional(literalUnion(ROUTING_STRATEGIES)),
  enabled: t.Optional(t.Boolean()),
  rotateCount: t.Optional(
    t.Integer({ minimum: ROUTING_BOUNDS.rotateCount.min, maximum: ROUTING_BOUNDS.rotateCount.max }),
  ),
  maxInflight: t.Optional(
    t.Nullable(
      t.Integer({ minimum: ROUTING_BOUNDS.maxInflight.min, maximum: ROUTING_BOUNDS.maxInflight.max }),
    ),
  ),
  bypassProxy: t.Optional(t.Boolean()),
});

export function createProviderDetailRoutes(config: ProviderDetailConfig): Elysia {
  const factory = createProviderDetailOperations(config);
  return new Elysia({ prefix: "/providers" })
    .get("/:providerId/routing", async ({ request, params, set }) => {
      try {
        return await factory.getRouting(config.accessResolver(request), params.providerId);
      } catch (e) {
        return providerDetailErrorResponse(e, set);
      }
    })
    .patch(
      "/:providerId/routing",
      { body: updateRoutingBody },
      async ({ request, params, body, set }) => {
        try {
          return await factory.updateRouting(
            config.accessResolver(request),
            params.providerId,
            body as UpdateProviderRoutingRequest,
          );
        } catch (e) {
          return providerDetailErrorResponse(e, set);
        }
      },
    ) as unknown as Elysia;
}
