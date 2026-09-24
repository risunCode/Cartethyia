import { consoleErrorHandler } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { Elysia, t } from "elysia";
import { WIRE_FAMILIES } from "../../../transport/canonical-model";
import { PROBE_REASONING_EFFORTS } from "../../../providers/discovery/discovery-types";
import { ACCOUNT_STATUSES, CREDENTIAL_KINDS } from "./contracts";
import { createModelCatalogOperations } from "./model-operations";
import {
  createProviderCatalogOperations,
  type ProviderCatalogConfig,
} from "./provider-operations";
import type {
  ByokConnectionTestRequest,
  CreateProviderAccountRequest,
  CreateProviderRequest,
  ProbeModelRequest,
  SetModelEnabledRequest,
  UpdateProviderAccountRequest,
  UpdateProviderRequest,
} from "./contracts";

const compatibilityProfileSchema = t.Object({
  cli_identity: t.Optional(t.Boolean()),
  gateway_user_agent: t.Optional(t.Boolean()),
  extra_headers: t.Optional(t.Record(t.String(), t.String())),
  extra_query_params: t.Optional(t.Record(t.String(), t.String())),
  endpoint_paths_by_wire_family: t.Optional(
    t.Record(literalUnion(WIRE_FAMILIES), t.String()),
  ),
  model_wire_families: t.Optional(
    t.Array(
      t.Object({
        pattern: t.String(),
        wire_family: literalUnion(WIRE_FAMILIES),
      }),
    ),
  ),
  streaming_usage_mode: t.Optional(t.Union([t.Literal("include_usage"), t.Literal("none")])),
  structured_output: t.Optional(
    t.Object({
      mode: t.Union([t.Literal("json_object"), t.Literal("json_schema")]),
      enabled: t.Boolean(),
    }),
  ),
  credentialUrl: t.Optional(t.String()),
});
const createProviderBody = t.Object({
  providerId: t.String(),
  label: t.Optional(t.String()),
  enabled: t.Optional(t.Boolean()),
  capabilityProfile: t.Optional(t.Record(t.String(), t.Unknown())),
  wireFamily: t.Optional(t.String()),
  baseUrl: t.Optional(t.String()),
  compatibilityProfile: t.Optional(compatibilityProfileSchema),
  models: t.Optional(t.Array(t.String())),
});
const updateProviderBody = t.Partial(
  t.Object({
    label: t.String(),
    enabled: t.Boolean(),
    capabilityProfile: t.Record(t.String(), t.Unknown()),
    baseUrl: t.String(),
    compatibilityProfile: compatibilityProfileSchema,
  }),
);
const createAccountBody = t.Object({
  label: t.Optional(t.String()),
  credentialKind: literalUnion(CREDENTIAL_KINDS),
  secret: t.String(),
});
const updateAccountBody = t.Object({
  label: t.Optional(t.String()),
  secret: t.Optional(t.String()),
  status: t.Optional(literalUnion(ACCOUNT_STATUSES)),
});
const registerModelsBody = t.Object({
  modelIds: t.Array(t.String()),
  wireFamily: t.Optional(t.String()),
});
const probeModelBody = t.Object({
  modelId: t.String(),
  route: t.Optional(t.String()),
  wireFamily: t.Optional(t.String()),
  accountId: t.Optional(t.String()),
  prompt: t.Optional(t.String()),
  reasoningEffort: t.Optional(literalUnion(PROBE_REASONING_EFFORTS)),
  maxOutputTokens: t.Optional(t.Integer({ minimum: 1, maximum: 131072 })),
  stream: t.Optional(t.Boolean()),
});
const byokConnectionTestBody = t.Object({
  baseUrl: t.String(),
  apiKey: t.String(),
  wireFamily: t.String(),
  cliIdentity: t.Optional(t.Boolean()),
  extraHeaders: t.Optional(t.Record(t.String(), t.String())),
});
const setModelEnabledBody = t.Object({
  modelId: t.String(),
  route: t.String(),
  enabled: t.Boolean(),
});
const deleteModelBody = t.Object({
  modelId: t.String(),
  route: t.String(),
});
const bulkDeleteModelsBody = t.Object({
  items: t.Array(deleteModelBody, { minItems: 1, maxItems: 1000 }),
});
export function createProviderCatalogRoutes(config: ProviderCatalogConfig): Elysia {
  const factory = createProviderCatalogOperations(config);
  const modelFactory = createModelCatalogOperations(config);
  return new Elysia({ prefix: "/providers" })
    .error(consoleErrorHandler("Provider catalog operation failed"))
    .get("/", async ({ request }) => {
      return await factory.listProviders(config.accessResolver(request));
})
    .patch(
      "/platform/global/:providerId",
      { body: updateProviderBody },
      async ({ request, params, body }) => {
        return await factory.updateGlobalProvider(
          config.accessResolver(request),
          params.providerId,
          body as UpdateProviderRequest,
        );
},
    )
    .delete("/platform/global/:providerId", async ({ request, params }) => {
      return await factory.deleteGlobalProvider(
        config.accessResolver(request),
        params.providerId,
      );
})
    .get("/models/flat", async ({ request }) => {
      return await modelFactory.listFlatModels(config.accessResolver(request));
})
    // Ad-hoc connectivity test for a provider the operator has not saved yet:
    // declared before the `/:providerId` routes so "connection-test" is never
    // captured as a provider id.
    .post(
      "/connection-test",
      { body: byokConnectionTestBody },
      async ({ request, body }) => {
        return await modelFactory.testByokConnection(
          config.accessResolver(request),
          body as ByokConnectionTestRequest,
        );
},
    )
    .get("/:providerId", async ({ request, params }) => {
      return await factory.getProviderDetail(config.accessResolver(request), params.providerId);
})
    .post("/", { body: createProviderBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createProvider(
        config.accessResolver(request),
        body as CreateProviderRequest,
      );
})
    .patch("/:providerId", { body: updateProviderBody }, async ({ request, params, body }) => {
      return await factory.updateProvider(
        config.accessResolver(request),
        params.providerId,
        body as UpdateProviderRequest,
      );
})
    .delete("/:providerId", async ({ request, params }) => {
      return await factory.deleteProvider(config.accessResolver(request), params.providerId);
})
    .get("/:providerId/models", async ({ request, params }) => {
      return await modelFactory.listModels(config.accessResolver(request), params.providerId);
})
    .post(
      "/:providerId/models",
      { body: registerModelsBody },
      async ({ request, params, body }) => {
        const b = body as { modelIds: readonly string[]; wireFamily?: string };
        return await modelFactory.registerModels(
          config.accessResolver(request),
          params.providerId,
          b.modelIds,
          b.wireFamily,
        );
},
    )
    .post(
      "/:providerId/models/probe",
      { body: probeModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.probeModel(
          config.accessResolver(request),
          params.providerId,
          body as ProbeModelRequest,
        );
},
    )
    .post("/:providerId/models/test-models", async ({ request, params }) => {
      return await modelFactory.probeAllModels(config.accessResolver(request), params.providerId);
})
    .post(
      "/:providerId/accounts/probe",
      { body: probeModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.probeAllAccounts(
          config.accessResolver(request),
          params.providerId,
          body as ProbeModelRequest,
        );
},
    )
    .patch(
      "/:providerId/models",
      { body: setModelEnabledBody },
      async ({ request, params, body }) => {
        return await modelFactory.setModelEnabled(
          config.accessResolver(request),
          params.providerId,
          body as SetModelEnabledRequest,
        );
},
    )
    .delete(
      "/:providerId/models",
      { body: deleteModelBody },
      async ({ request, params, body }) => {
        return await modelFactory.deleteModel(
          config.accessResolver(request),
          params.providerId,
          body as SetModelEnabledRequest,
        );
},
    )
    .delete(
      "/:providerId/models/bulk",
      { body: bulkDeleteModelsBody },
      async ({ request, params, body }) => {
        const items = (body as { items: SetModelEnabledRequest[] }).items;
        return await modelFactory.deleteModelsBulk(
          config.accessResolver(request),
          params.providerId,
          items,
        );
},
    )
    .post("/:providerId/models/sync", async ({ request, params }) => {
      return await modelFactory.syncModels(config.accessResolver(request), params.providerId);
})
    .get("/:providerId/accounts", async ({ request, params }) => {
      return await factory.listAccounts(config.accessResolver(request), params.providerId);
})
    .post(
      "/:providerId/accounts",
      { body: createAccountBody },
      async ({ request, params, body, set }) => {
        set.status = 201;
        const created = await factory.createAccount(
          config.accessResolver(request),
          params.providerId,
          body as CreateProviderAccountRequest,
        );
        return created;
},
    )
    .patch(
      "/:providerId/accounts/:accountId",
      { body: updateAccountBody },
      async ({ request, params, body }) => {
        const updated = await factory.updateAccount(
          config.accessResolver(request),
          params.providerId,
          params.accountId,
          body as UpdateProviderAccountRequest,
        );
        return updated;
},
    )
    .get("/:providerId/accounts/:accountId/health-events", async ({ request, params }) => {
      return await factory.listAccountHealthEvents(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
})
    .post("/:providerId/accounts/:accountId/recover", async ({ request, params }) => {
      const recovered = await factory.recoverAccount(
        config.accessResolver(request),
        params.providerId,
        params.accountId,
      );
      return recovered;
})
    .post(
      "/:providerId/accounts/export",
      { body: t.Object({ accountIds: t.Array(t.String()) }) },
      async ({ request, params, body }) => {
        return await factory.exportAccounts(
          config.accessResolver(request),
          params.providerId,
          body.accountIds,
        );
},
    ) as unknown as Elysia;
}
