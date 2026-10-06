import { Elysia } from "elysia";
import {
  createRuntimeSettingsOperations,
  runtimeUpdateBody,
  runtimeSettingsErrorResponse,
  type RuntimeSettingsConfig,
  type UpdateRuntimeSettingsRequest,
} from "./contracts";

export function createRuntimeSettingsRoutes(config: RuntimeSettingsConfig): Elysia {
  const factory = createRuntimeSettingsOperations(config);
  return new Elysia({ prefix: "/settings/runtime" })
    .get("/", async ({ request, set }) => {
      try {
        return await factory.get(config.accessResolver(request));
      } catch (e) {
        return runtimeSettingsErrorResponse(e, set);
      }
    })
    .patch("/", { body: runtimeUpdateBody }, async ({ request, body, set }) => {
      try {
        return await factory.update(
          config.accessResolver(request),
          body as UpdateRuntimeSettingsRequest,
        );
      } catch (e) {
        return runtimeSettingsErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}
