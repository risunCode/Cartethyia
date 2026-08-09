/**
 * Warp Pool API routes — Elysia sub-app mounted inside the console API.
 *
 * Routes:
 *   GET    /warp/accounts           — list all warp accounts (secrets masked)
 *   GET    /warp/accounts/:id       — single account (secrets masked)
 *   GET    /warp/accounts/:id/credential — full account with raw secrets
 *   POST   /warp/register           — register a new warp account via wgcf
 *   POST   /warp/import             — import from WireGuard profile .conf
 *   POST   /warp/accounts/:id/start — start wireproxy instance
 *   POST   /warp/accounts/:id/stop  — stop wireproxy instance
 *   POST   /warp/start-all          — start all enabled instances
 *   POST   /warp/stop-all           — stop all instances
 *   GET    /warp/statuses           — batch status for all instances
 *   GET    /warp/metrics/summary    — aggregated memory/bandwidth card data
 *   GET    /warp/metrics/history    — paginated metrics history (cursor pagination)
 *   PATCH  /warp/accounts/:id       — update label/enabled
 *   DELETE /warp/accounts/:id       — remove account
 *   GET    /warp/accounts/:id/profile — export WireGuard profile .conf (backup)
 *   GET    /warp/backup             — export all accounts as JSON backup payload
 *   POST   /warp/backup/restore     — import accounts from backup payload
 */

import { Elysia, type HTTPHeaders } from "elysia";
import { consoleError } from "../services/composition";
import type { ConfigPersistence } from "../../storage/main/config";
import type { RuntimePersistence } from "../../storage/runtime/runtime";
import { WarpPoolService } from "./service";
import type { WarpAccountInput, WarpBackupPayload, WarpImportInput } from "./types";

function badRequest(set: { status?: number | string; headers: HTTPHeaders }, message: string): { error: { code: string; message: string } } {
  set.status = 400;
  return consoleError("invalid_request", message);
}

function notFound(set: { status?: number | string; headers: HTTPHeaders }): { error: { code: string; message: string } } {
  set.status = 404;
  return consoleError("not_found", "Warp account not found");
}

/** Result of mounting the Warp Pool API — the Elysia sub-app and the owning service. */
export interface WarpApiMount {
  /** Elysia sub-app to mount via `.use()`. */
  app: Elysia;
  /** The single WarpPoolService instance — caller owns its lifecycle (shutdown). */
  service: WarpPoolService;
}

/**
 * Create the Warp Pool Elysia sub-app. Returns both the app and the single
 * WarpPoolService so the caller can shut it down. Only ONE service is ever
 * created here; the caller MUST reuse this instance rather than constructing
 * its own (the constructor starts a 15s metrics timer).
 */
export function createWarpApi(config: ConfigPersistence, runtime?: RuntimePersistence): WarpApiMount {
  const service = new WarpPoolService(config, runtime);
  const app = new Elysia();

  app
    .route("QUERY", "/warp/accounts", async () => service.listAccounts())
    .route("QUERY", "/warp/accounts/:id", async ({ params, set }: { params: { id: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const account = await service.getAccount(params.id);
      if (!account) return notFound(set);
      return account;
    })
    .route("QUERY", "/warp/accounts/:id/credential", async ({ params, set }: { params: { id: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const account = await service.getCredential(params.id);
      if (!account) return notFound(set);
      return account;
    })
    .post("/warp/register", async ({ body, set }: { body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const value = typeof body === "object" && body !== null ? body as Partial<WarpAccountInput> : {};
      const input: WarpAccountInput = { label: typeof value.label === "string" ? value.label : undefined };
      const result = await service.register(input);
      if (!result.success) return badRequest(set, result.message);
      return result;
    })
    .post("/warp/import", async ({ body, set }: { body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const value = typeof body === "object" && body !== null ? body as Partial<WarpImportInput> : {};
      if (typeof value.profileContent !== "string" || !value.profileContent.trim()) return badRequest(set, "profileContent is required");
      const input: WarpImportInput = {
        label: typeof value.label === "string" ? value.label : undefined,
        profileContent: value.profileContent,
        deviceId: typeof value.deviceId === "string" ? value.deviceId : undefined,
        accessToken: typeof value.accessToken === "string" ? value.accessToken : undefined,
        licenseKey: typeof value.licenseKey === "string" ? value.licenseKey : undefined,
      };
      const result = await service.import(input);
      if (!result.success) return badRequest(set, result.message);
      return result;
    })
    .post("/warp/accounts/:id/start", async ({ params, set }: { params: { id: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const result = await service.startInstance(params.id);
      if (!result.success) {
        set.status = 400;
        return consoleError("invalid_request", result.message);
      }
      return result;
    })
    .post("/warp/accounts/:id/stop", async ({ params, set }: { params: { id: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const result = await service.stopInstance(params.id);
      if (!result.success) {
        set.status = 400;
        return consoleError("invalid_request", result.message);
      }
      return result;
    })
    .post("/warp/start-all", async () => service.startAll())
    .post("/warp/stop-all", async () => service.stopAll())
    .route("QUERY", "/warp/statuses", async () => service.getAllStatuses())
    .route("QUERY", "/warp/metrics/summary", async () => await service.getMetricsSummary())
    .route("QUERY", "/warp/metrics/history", async ({ query }: { query: { cursor?: string; limit?: string } }) => {
      const cursor = query.cursor ? Number(query.cursor) : null;
      const limit = query.limit ? Math.min(50, Math.max(1, Number(query.limit))) : 10;
      return service.getMetricsPage(cursor, limit);
    })
    .patch("/warp/accounts/:id", async ({ params, body, set }: { params: { id: string }; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const value = typeof body === "object" && body !== null ? body as { label?: string; enabled?: boolean; preferIpv6?: boolean; customEndpoint?: string | null; persistentKeepalive?: number } : {};
      const result = await service.updateAccount(params.id, value);
      if (!result.success) return notFound(set);
      return result;
    })
    .route("QUERY", "/warp/accounts/:id/profile", async ({ params, set }: { params: { id: string }; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const exportData = await service.exportProfile(params.id);
      if (!exportData) return notFound(set);
      return exportData;
    })
    .route("QUERY", "/warp/backup", async () => service.exportAll())
    .post("/warp/backup/restore", async ({ body, set }: { body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const value = typeof body === "object" && body !== null ? body as Partial<{ payload: WarpBackupPayload; label?: string }> : {};
      if (!value.payload || value.payload.version !== 1) return badRequest(set, "Invalid backup payload");
      const result = await service.importBackup(value.payload, typeof value.label === "string" ? value.label : undefined);
      if (!result.success) return badRequest(set, result.message);
      return result;
    })
    .delete("/warp/accounts/:id", async ({ params }: { params: { id: string } }) => service.removeAccount(params.id));

  return { app, service };
}
