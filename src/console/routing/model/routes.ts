// Model routing control-plane HTTP routes. The only module that touches Elysia.
import { Elysia, t } from "elysia";
import { errorResponse } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { modelComboStrategy, type ComboStrategy } from "../../../persistence/schema";
import {
  type ModelComboCreateInput,
  type ModelComboPatchInput,
  type ModelRoutingConfig,
} from "./contracts";
import { createModelRoutingOperations } from "./operations";

function modelRoutingErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Model routing operation failed");
}
// Compile-time parity: the combo validation schemas below must accept exactly
// the canonical ComboStrategy. Adding a combo strategy to the schema enum
// without updating these literals fails here.
type ExpectComboParity<T extends true> = T;
export type ComboSchemaParity = ExpectComboParity<
  [ComboStrategy] extends ["fallback" | "round_robin" | "fusion"]
    ? (["fallback" | "round_robin" | "fusion"] extends [ComboStrategy] ? true : false)
    : false
>;
const createAliasBody = t.Object({ alias: t.String(), targetModel: t.String() });
const updateAliasBody = t.Object({
  alias: t.Optional(t.String()),
  targetModel: t.Optional(t.String()),
});
/** Full replacement order for the tenant's alias list. */
const reorderBody = t.Object({ ids: t.Array(t.String(), { minItems: 1 }) });
/** The combo-strategy enum's own values; see `ComboSchemaParity` above. */
const comboStrategySchema = literalUnion(modelComboStrategy.enumValues);
const createComboBody = t.Object({
  name: t.String(),
  members: t.Array(t.String(), { minItems: 1 }),
  strategy: t.Optional(comboStrategySchema),
});
const updateComboBody = t.Object({
  name: t.Optional(t.String()),
  members: t.Optional(t.Array(t.String(), { minItems: 1 })),
  strategy: t.Optional(comboStrategySchema),
});
export function createModelRoutingRoutes(config: ModelRoutingConfig): Elysia {
  const factory = createModelRoutingOperations(config);
  return new Elysia({ prefix: "/routing" })
    .get("/aliases", async ({ request, set }) => {
      try {
        return await factory.listAliases(config.accessResolver(request));
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/aliases", { body: createAliasBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createAlias(config.accessResolver(request), body);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .patch("/aliases/:id", { body: updateAliasBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateAlias(config.accessResolver(request), params.id, body);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .delete("/aliases/:id", async ({ request, params, set }) => {
      try {
        return await factory.deleteAlias(config.accessResolver(request), params.id);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/aliases/reorder", { body: reorderBody }, async ({ request, body, set }) => {
      try {
        await factory.reorderAliases(config.accessResolver(request), body.ids);
        return { success: true };
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .get("/combos", async ({ request, set }) => {
      try {
        return await factory.listCombos(config.accessResolver(request));
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/combos", { body: createComboBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createCombo(
          config.accessResolver(request),
          body as ModelComboCreateInput,
        );
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/combos/reorder", { body: reorderBody }, async ({ request, body, set }) => {
      try {
        await factory.reorderCombos(config.accessResolver(request), body.ids);
        return { success: true };
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .post("/combos/:id/clone", async ({ request, params, set }) => {
      try {
        set.status = 201;
        return await factory.cloneCombo(config.accessResolver(request), params.id);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .patch("/combos/:id", { body: updateComboBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateCombo(
          config.accessResolver(request),
          params.id,
          body as ModelComboPatchInput,
        );
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    })
    .delete("/combos/:id", async ({ request, params, set }) => {
      try {
        return await factory.deleteCombo(config.accessResolver(request), params.id);
      } catch (e) {
        return modelRoutingErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}
