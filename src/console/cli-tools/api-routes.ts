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
import type { ConfigPersistence } from "../../storage";
import { badRequest, notFound } from "../api/route-helpers";
import { CliToolService } from "./service";
import type { ApplyInput, CliMappingInput } from "./types";

function parseMapping(value: unknown): CliMappingInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const rawMappings = Array.isArray(candidate.mappings) ? candidate.mappings : [];
  const mappings = rawMappings.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.slotKey !== "string" || typeof row.sourceModel !== "string" || typeof row.targetModel !== "string") return [];
    return [{
      slotKey: row.slotKey,
      sourceModel: row.sourceModel,
      targetModel: row.targetModel,
      enabled: row.enabled !== false,
    }];
  });
  return { enabled: candidate.enabled === true, mappings };
}

function parseApplyInput(body: unknown): ApplyInput {
  const value = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const rawSlots = typeof value.modelSlots === "object" && value.modelSlots !== null && !Array.isArray(value.modelSlots) ? value.modelSlots as Record<string, unknown> : {};
  return {
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    models: Array.isArray(value.models) ? value.models.filter((model): model is string => typeof model === "string") : [],
    modelSlots: Object.fromEntries(Object.entries(rawSlots).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    activeModel: typeof value.activeModel === "string" ? value.activeModel : undefined,
    subagentModel: typeof value.subagentModel === "string" ? value.subagentModel : undefined,
    mapping: parseMapping(value.mapping),
  };
}

/** Create the CLI tools Elysia sub-app. The service is created once and shared. */
export function createCliToolsApi(config: ConfigPersistence): Elysia {
  const service = new CliToolService(config);
  const app = new Elysia();

  app
    .route("QUERY", "/cli-tools/registry", () => service.getRegistry())
    .route("QUERY", "/cli-tools/all-statuses", async () => service.getAllStatuses())
    .route("QUERY", "/cli-tools/:toolId/mappings", ({ params, set }: { params: { toolId: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set, "CLI tool not found");
      return service.getMappings(params.toolId);
    })
    .route("QUERY", "/cli-tools/:toolId", async ({ params, set }: { params: { toolId: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const status = await service.getStatus(params.toolId);
      if (status === null) return notFound(set, "CLI tool not found");
      return status;
    })
    .post("/cli-tools/:toolId", async ({ params, body, set }: { params: { toolId: string }; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set, "CLI tool not found");
      const input = parseApplyInput(body);
      const result = await service.applyConfig(params.toolId, input);
      if (!result.success) return badRequest(set, result.message);
      return result;
    })
    .delete("/cli-tools/:toolId", async ({ params, set }: { params: { toolId: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set, "CLI tool not found");
      const result = await service.resetConfig(params.toolId);
      if (!result.success) return badRequest(set, result.message);
      return result;
    })
    .post("/cli-tools/:toolId/download", async ({ params, body, set }: { params: { toolId: string }; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      if (!service.isValidTool(params.toolId)) return notFound(set, "CLI tool not found");
      const input = parseApplyInput(body);
      if (!input.endpoint || !input.apiKey) return badRequest(set, "endpoint and apiKey are required");
      const result = await service.downloadConfig(params.toolId, input);
      if (result === null) return notFound(set, "CLI tool not found");
      return result;
    });

  return app;
}
