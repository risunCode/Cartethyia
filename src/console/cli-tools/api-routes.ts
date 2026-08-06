/**
 * CLI Tools API routes — Elysia sub-app mounted inside the console API.
 *
 * Routes:
 *   GET    /cli-tools/registry           — all tool metadata
 *   GET    /cli-tools/all-statuses       — batch status for all tools
 *   GET    /cli-tools/:toolId            — single tool status
 *   POST   /cli-tools/:toolId            — apply config (inject to fs)
 *   DELETE /cli-tools/:toolId            — reset config (remove cartethyia fields)
 *   POST   /cli-tools/:toolId/download   — download config as text
 *
 * All routes sit behind the console session guard (applied by the parent app).
 */

import { Elysia, type HTTPHeaders } from "elysia";
import { consoleError } from "../services";
import { CliToolService } from "./service";
import type { ApplyInput } from "./types";

function badRequest(set: { status?: number | string; headers: HTTPHeaders }, message: string): { error: { code: string; message: string } } {
  set.status = 400;
  return consoleError("invalid_request", message);
}

function notFound(set: { status?: number | string; headers: HTTPHeaders }): { error: { code: string; message: string } } {
  set.status = 404;
  return consoleError("not_found", "CLI tool not found");
}

/** Create the CLI tools Elysia sub-app. The service is created once and shared. */
export function createCliToolsApi(): Elysia {
  const service = new CliToolService();
  const app = new Elysia();

  app
    .get("/cli-tools/registry", () => service.getRegistry())
    .get("/cli-tools/all-statuses", async () => service.getAllStatuses())
    .get("/cli-tools/:toolId", async ({ params, set }: { params: { toolId: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const status = await service.getStatus(params.toolId);
      if (status === null) return notFound(set);
      return status;
    })
    .post("/cli-tools/:toolId", async ({ params, body, set }: { params: { toolId: string }; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set);
      const value = typeof body === "object" && body !== null ? body as Partial<ApplyInput> : {};
      const input: ApplyInput = {
        endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
        apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
        models: Array.isArray(value.models) ? value.models.filter((m): m is string => typeof m === "string") : [],
        activeModel: typeof value.activeModel === "string" ? value.activeModel : undefined,
        subagentModel: typeof value.subagentModel === "string" ? value.subagentModel : undefined,
      };
      const result = await service.applyConfig(params.toolId, input);
      if (!result.success) {
        set.status = 400;
        return consoleError("invalid_request", result.message);
      }
      return result;
    })
    .delete("/cli-tools/:toolId", async ({ params, set }: { params: { toolId: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set);
      const result = await service.resetConfig(params.toolId);
      if (!result.success) {
        set.status = 400;
        return consoleError("invalid_request", result.message);
      }
      return result;
    })
    .post("/cli-tools/:toolId/download", async ({ params, body, set }: { params: { toolId: string }; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set);
      const value = typeof body === "object" && body !== null ? body as Partial<ApplyInput> : {};
      const input: ApplyInput = {
        endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
        apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
        models: Array.isArray(value.models) ? value.models.filter((m): m is string => typeof m === "string") : [],
        activeModel: typeof value.activeModel === "string" ? value.activeModel : undefined,
        subagentModel: typeof value.subagentModel === "string" ? value.subagentModel : undefined,
      };
      if (!input.endpoint || !input.apiKey) return badRequest(set, "endpoint and apiKey are required");
      const result = await service.downloadConfig(params.toolId, input);
      if (result === null) return notFound(set);
      return result;
    });

  return app;
}
