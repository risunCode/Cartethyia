import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../audit/contracts";
import { Elysia, t } from "elysia";
import { errorResponse, requireTenantScope } from "../shared/errors";
import type { CliToolService } from "./service";
import type { ApplyInput, CliMappingInput, CliModelMapping } from "./contracts";
// ── api-routes.ts ──
/**
 * CLI Tools API routes — Elysia sub-app mounted inside `/console/api`.
 *
 * Routes:
 *   GET    /cli-tools/registry              — all tool metadata (auth only)
 *   GET    /cli-tools/all-statuses          — batch host FS probe (dashboard:read)
 *   GET    /cli-tools/:toolId               — single tool status (dashboard:read)
 *   GET    /cli-tools/:toolId/mappings      — persisted mappings for one key (dashboard:read)
 *   POST   /cli-tools/:toolId/mappings      — save mappings for one key (dashboard:write, audited)
 *   POST   /cli-tools/:toolId/download      — download config text (dashboard:read)
 *   POST   /cli-tools/:toolId/apply         — write config and/or save remote route
 *                                             (dashboard:write, audited)
 *
 * Mapping endpoints require a `keyId` — mappings are now per-(tenant, tool, key)
 * so each API key can route the same CLI slot to a different target.
 * `download` and `apply` require `keyId`; the server resolves the recoverable
 * AES-256-GCM copy so the operator never pastes a raw secret.
 */
export interface CliToolsRoutesConfig {
  readonly service: CliToolService;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  /** Invalidated after mapping saves so the routing snapshot picks them up. */
  readonly snapshotInvalidator?: { invalidate(): unknown };
}

function parseMapping(value: unknown): CliMappingInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean" || !Array.isArray(candidate.mappings)) return undefined;
  const mappings: CliModelMapping[] = [];
  for (const entry of candidate.mappings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.slotKey !== "string" ||
      typeof row.sourceModel !== "string" ||
      typeof row.targetModel !== "string" ||
      typeof row.enabled !== "boolean"
    )
      return undefined;
    mappings.push({
      slotKey: row.slotKey,
      sourceModel: row.sourceModel,
      targetModel: row.targetModel,
      enabled: row.enabled,
    });
  }
  return { enabled: candidate.enabled, mappings };
}

/**
 * Parses an apply/download body. `keyId` is required: the server resolves
 * the key's AES-256-GCM ciphertext so the operator never pastes a raw secret.
 * Mappings are keyed to the same `keyId`, so apply and mapping saves are
 * always consistent.
 */
function parseApplyInput(
  body: unknown,
): (ApplyInput & { keyId: string; mappingOwnerId?: string; mapping?: CliMappingInput; mode?: "file" | "remote" | "both" }) | undefined {
  const value =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0) return undefined;
  const keyId = typeof value.keyId === "string" && value.keyId.length > 0 ? value.keyId : undefined;
  if (!keyId) return undefined;
  const rawSlots =
    typeof value.modelSlots === "object" &&
    value.modelSlots !== null &&
    !Array.isArray(value.modelSlots)
      ? (value.modelSlots as Record<string, unknown>)
      : {};
  const modelSlots = Object.fromEntries(
    Object.entries(rawSlots).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const mapping = parseMapping(value.mapping);
  if (value.mapping !== undefined && mapping === undefined) return undefined;
  return {
    endpoint: value.endpoint,
    apiKey: "",
    keyId,
    modelIds: Array.isArray(value.models)
      ? value.models.filter((model): model is string => typeof model === "string")
      : [],
    ...(Object.keys(modelSlots).length > 0 ? { modelSlots } : {}),
    ...(typeof value.activeModel === "string" ? { activeModel: value.activeModel } : {}),
    ...(typeof value.subagentModel === "string" ? { subagentModel: value.subagentModel } : {}),
    ...(typeof value.mappingOwnerId === "string" && value.mappingOwnerId.length > 0
      ? { mappingOwnerId: value.mappingOwnerId }
      : {}),
    ...(mapping !== undefined ? { mapping } : {}),
    ...(value.mode === "file" || value.mode === "remote" || value.mode === "both"
      ? { mode: value.mode }
      : {}),
  };
}

const applyBody = t.Object({
  endpoint: t.String(),
  keyId: t.String(),
  mappingOwnerId: t.Optional(t.String()),
  mode: t.Optional(t.Union([t.Literal("file"), t.Literal("remote"), t.Literal("both")])),
  models: t.Array(t.String()),
  modelSlots: t.Optional(t.Record(t.String(), t.String())),
  activeModel: t.Optional(t.String()),
  subagentModel: t.Optional(t.String()),
  mapping: t.Optional(
    t.Object({
      enabled: t.Boolean(),
      mappings: t.Array(
        t.Object({
          slotKey: t.String(),
          sourceModel: t.String(),
          targetModel: t.String(),
          enabled: t.Optional(t.Boolean()),
        }),
      ),
    }),
  ),
  bypassPermissions: t.Optional(t.Boolean()),
});

const mappingBody = t.Object({
  keyId: t.String(),
  enabled: t.Boolean(),
  mappings: t.Array(
    t.Object({
      slotKey: t.String(),
      sourceModel: t.String(),
      targetModel: t.String(),
      enabled: t.Optional(t.Boolean()),
    }),
  ),
});

export function createCliToolsRoutes(config: CliToolsRoutesConfig): Elysia {
  const { service, accessResolver, auditSink, snapshotInvalidator } = config;

  return new Elysia({ prefix: "/cli-tools" })
    .get("/registry", async ({ request, set }) => {
      try {
        requireTenantScope(accessResolver(request), "dashboard:read");
        return service.getRegistry();
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .get("/all-statuses", async ({ request, set }) => {
      try {
        requireTenantScope(accessResolver(request), "dashboard:read");
        return await service.getAllStatuses();
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .get("/:toolId/mappings", async ({ request, params, query, set }) => {
      try {
        const a = requireTenantScope(accessResolver(request), "dashboard:read");
        if (!service.isValidTool(params.toolId)) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        const keyId = typeof query.keyId === "string" && query.keyId.length > 0 ? query.keyId : undefined;
        if (!keyId) {
          set.status = 422;
          return { error: "keyId query parameter is required", code: "invalid_request" };
        }
        return await service.getMappings(a.tenantId, params.toolId, keyId);
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .post("/:toolId/mappings", { body: mappingBody }, async ({ request, params, body, set }) => {
      try {
        const a = requireTenantScope(accessResolver(request), "dashboard:write");
        if (!service.isValidTool(params.toolId)) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        const input = parseMapping(body);
        if (input === undefined) {
          set.status = 422;
          return { error: "Invalid mapping payload", code: "invalid_request" };
        }
        const keyId = typeof body.keyId === "string" && body.keyId.length > 0 ? body.keyId : undefined;
        if (!keyId) {
          set.status = 422;
          return { error: "keyId is required", code: "invalid_request" };
        }
        try {
          const result = await service.saveMappings(a.tenantId, params.toolId, keyId, input);
          await auditSink?.record({
            access: a,
            action: "cli_tool.mappings_saved",
            target: params.toolId,
            detail: { count: input.mappings.length, enabled: input.enabled, keyId },
          });
          // Mapping saves are routing changes: invalidate the snapshot so the
          // next `/v1/*` request routes through the newly saved source→target
          // immediately instead of the previous revision.
          await snapshotInvalidator?.invalidate();
          return result;
        } catch (error) {
          set.status = 422;
          return {
            error: error instanceof Error ? error.message : "Failed to save mappings",
            code: "invalid_request",
          };
        }
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .post("/:toolId/mappings/reset", { body: t.Object({ keyId: t.String() }) }, async ({ request, params, body, set }) => {
      try {
        const a = requireTenantScope(accessResolver(request), "dashboard:write");
        if (!service.isValidTool(params.toolId)) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        const keyId = typeof body.keyId === "string" && body.keyId.length > 0 ? body.keyId : undefined;
        if (!keyId) {
          set.status = 422;
          return { error: "keyId is required", code: "invalid_request" };
        }
        const result = await service.resetMappings(a.tenantId, params.toolId, keyId);
        await auditSink?.record({
          access: a,
          action: "cli_tool.mappings_reset",
          target: params.toolId,
          detail: { keyId },
        });
        await snapshotInvalidator?.invalidate();
        return result;
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .get("/:toolId", async ({ request, params, set }) => {
      try {
        requireTenantScope(accessResolver(request), "dashboard:read");
        const status = await service.getStatus(params.toolId);
        if (status === null) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        return status;
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    .post("/:toolId/download", { body: applyBody }, async ({ request, params, body, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:read");
        if (!service.isValidTool(params.toolId)) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        const parsed = parseApplyInput(body);
        if (parsed === undefined) {
          set.status = 422;
          return {
            error: "endpoint and keyId are required",
            code: "invalid_request",
          };
        }
        const input = await service.withResolvedSecret(access.tenantId, parsed);
        const result = await service.downloadConfig(params.toolId, input);
        if (result === null) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        return result;
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    })
    /**
     * Writes the tool's config on this host and/or records a remote route.
     *
     * `mode` defaults to `both`: on a single-machine install that is the
     * obviously-right action, and it reports back which paths actually ran so
     * an operator on a remote or containerised gateway can see that the file
     * write is not the one doing the work.
     */
    .post("/:toolId/apply", { body: applyBody }, async ({ request, params, body, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        if (!service.isValidTool(params.toolId)) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        const parsed = parseApplyInput(body);
        if (parsed === undefined) {
          set.status = 422;
          return {
            error: "endpoint and keyId are required",
            code: "invalid_request",
          };
        }
        const input = await service.withResolvedSecret(access.tenantId, parsed);
        const result = await service.applyConfig(access.tenantId, params.toolId, parsed.mappingOwnerId ?? parsed.keyId, {
          ...input,
          ...(parsed.mode ? { mode: parsed.mode } : {}),
        });
        if (result === null) {
          set.status = 404;
          return { error: "CLI tool not found", code: "tool_not_found" };
        }
        await auditSink?.record({
          access,
          action: "cli_tool.applied",
          target: params.toolId,
          detail: {
            outcome: result.outcome,
            wroteFile: result.wroteFile,
            savedRemoteRoute: result.savedRemoteRoute,
            keyId: parsed.keyId,
          },
        });
        // A remote route is a routing change: invalidate so the next `/v1/*`
        // request picks it up without waiting for a restart.
        if (result.savedRemoteRoute) await snapshotInvalidator?.invalidate();
        return result;
      } catch (e) {
        return errorResponse(e, set, "CLI tool operation failed");
      }
    }) as unknown as Elysia;
}
