/**
 * Console HTTP composition.
 *
 * Public surface: `/console/api/login` and `/console/api/ip` are
 * unauthenticated; every other `/console/api/*` route sits behind the
 * explicit console guard (authenticated session + JSON content type +
 * same-origin validation for mutations, with HttpOnly/SameSite session
 * cookies).
 *
 * Routes only translate HTTP to application-service calls; they never touch
 * repositories, SQLite, or provider internals directly.
 */

import { Elysia, type HTTPHeaders } from "elysia";
import { MAX_BACKUP_BYTES } from "../storage";
import { convert9RouterBackup } from "./compat/9router";
import type { ModelProbeInput, ModelProbeResult, ProbePorts } from "./probe";
import type { ConsoleDiagnostics } from "./diagnostics";
import { createStudioSession, deleteStudioSession, getStudioSession, listStudioSessions, normalizeStudioMessages, patchStudioSession } from "./model-studio";
import type { ConsoleLogStreamHub } from "./streams";
import { createCliToolsApi } from "./cli-tools/api-routes";
import { createWarpApi, type WarpApiMount } from "./warp/api-routes";
import type { ConfigPersistence } from "../storage";
import type { RuntimePersistence } from "../storage/runtime/runtime";
import { createDbMapApi } from "./db-map/api-routes";
import type { DbMapPersistence } from "./db-map/service";
import type { DbTarget } from "./db-map/types";
import {
  buildSessionClearCookie,
  buildSessionCookie,
  clientIp,
  consoleError,
  guardConsoleRequest,
  isHttpsRequest,
  type ConsoleServices,
  type LoginResult,
} from "./services";
import { runProxyRequest, type ProxyRequestDependencies } from "../app/request";
import { appendTerminalError } from "../app/response";
import { metrics, toPrometheus } from "../observability/metrics";
import { extractTraceContext, injectTraceContext, traceMiddleware } from "../observability/tracing";
import { encodeSurfaceStream } from "../providers/surfaces";
import { beginProviderInFlight, endProviderInFlight, getInFlightCount, getProviderInFlight, subscribeInFlight } from "../traffic/in-flight";
import type { PresentedProxyResponse } from "../domain/contracts";

export interface ConsoleRouterDependencies {
  readonly services: ConsoleServices;
  readonly diagnostics: ConsoleDiagnostics;
  readonly config: ConfigPersistence;
  readonly runtime: RuntimePersistence;
  /** Bounded fanout hub for the live console-log SSE stream. */
  readonly logStream: ConsoleLogStreamHub;
  /** Lead-wired model probe runner (`src/console/probe.ts`). */
  readonly probe: (input: ModelProbeInput, ports: ProbePorts) => Promise<ModelProbeResult>;
  readonly probePorts: ProbePorts;
  /** Process-wide traffic snapshot backing the live in-flight console surface. */
  readonly liveTraffic: {
    readonly byIp: () => readonly { ip: string; active: number }[];
    readonly maxFlightsPerIp: () => number;
  };
  readonly proxy: ProxyRequestDependencies;
  readonly resetConfig: () => void;
  readonly resetRuntime: () => void;
}

interface RouteContext {
  readonly request: Request;
  readonly set: { status?: number | string };
}

function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra };
}

function notFound(set: { status?: number | string }, message = "resource not found"): ReturnType<typeof consoleError> {
  set.status = 404;
  return consoleError("not_found", message);
}

function conflict(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 409;
  return consoleError("conflict", message);
}

function badRequest(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 400;
  return consoleError("invalid_request", message);
}

export function liveTrafficSnapshot(liveTraffic: ConsoleRouterDependencies["liveTraffic"]): { inFlight: number; byIp: readonly { ip: string; active: number }[]; byProvider: readonly { providerId: string; active: number }[]; maxFlightsPerIp: number } {
  return { inFlight: getInFlightCount(), byIp: liveTraffic.byIp(), byProvider: getProviderInFlight(), maxFlightsPerIp: liveTraffic.maxFlightsPerIp() };
}

export function liveTrafficStream(request: Request, liveTraffic: ConsoleRouterDependencies["liveTraffic"]): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const frame = (event: string, data: unknown): Uint8Array => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (): void => {
        try { controller.enqueue(frame("count", liveTrafficSnapshot(liveTraffic))); } catch { cleanup(); }
      };
      const cleanup = (): void => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        request.signal.removeEventListener("abort", cleanup);
      };
      unsubscribe = subscribeInFlight(send);
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
      }, 25_000);
      heartbeat.unref?.();
      request.signal.addEventListener("abort", cleanup, { once: true });
      send();
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

function presentProxyResult(result: PresentedProxyResponse, surface: "openai-chat" | "images", model: string): Response {
  if (result.body.mode === "json") return Response.json(result.body.value, { status: result.status, headers: result.headers });
  const events = result.body.events;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of encodeSurfaceStream(surface, appendTerminalError(events), model)) controller.enqueue(chunk);
        controller.close();
      } catch {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: result.status, headers: result.headers });
}

/** Session + mutation guard mapped to the console error envelope. */
function makeSessionGuard(services: ConsoleServices) {
  return async ({ request, set }: RouteContext): Promise<unknown> => {
    const options = await services.auth.guardOptions();
    const verdict = await guardConsoleRequest(request, options);
    if (!verdict.ok) {
      set.status = verdict.status;
      return consoleError(verdict.code, verdict.message);
    }
    return undefined;
  };
}

const PROBE_LIMIT_KEYS = ["connectMs", "firstVisibleTextMs", "idleMs", "totalMs", "maxOutputTokens", "maxSampleChars"] as const;

function sanitizeProbeLimits(value: unknown): Partial<ModelProbeInput["limits"]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  const limits: { connectMs?: number; firstVisibleTextMs?: number; idleMs?: number; totalMs?: number; maxOutputTokens?: number; maxSampleChars?: number } = {};
  for (const key of PROBE_LIMIT_KEYS) {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) limits[key] = body[key];
  }
  return limits;
}

/** Narrow the model-probe request body; returns null when malformed. */
function probeInput(value: unknown): Omit<ModelProbeInput, "signal"> | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.provider !== "string" || typeof body.model !== "string") return null;
  const credentialMode =
    body.credentialMode === "account" || body.credentialMode === "manual" ? body.credentialMode : "auto";
  return {
    provider: body.provider,
    model: body.model,
    credentialMode,
    accountId: typeof body.accountId === "string" ? body.accountId : undefined,
    credential: typeof body.credential === "string" ? body.credential : undefined,
    limits: sanitizeProbeLimits(body.limits),
  };
}

function consoleLogStream(hub: ConsoleLogStreamHub, request: Request): Response {
  return hub.handle(request);
}

export function createConsoleApi(deps: ConsoleRouterDependencies) {
  const { services, diagnostics, config, runtime } = deps;
  const sessionGuard = makeSessionGuard(services);
  // Single WarpPoolService — created here and surfaced for shutdown by the
  // caller. Constructing it starts the 15s metrics timer, so there must be
  // exactly one instance process-wide.
  const warpApi: WarpApiMount = createWarpApi(config, runtime);

  // Bridge the console's config/runtime singletons into db-map's coordination
  // interface so writes go through the live WAL session and import reopens the
  // singleton against the swapped file instead of leaving it pinned to a stale
  // inode (WAL corruption risk — see db-map service header).
  const dbMapPersistence: DbMapPersistence = {
    db: (target: DbTarget) => {
      try {
        return target === "config" ? config.db() : runtime.db();
      } catch {
        // Singleton not yet open / closed — db-map falls back to its own
        // read-write connection for this write.
        return null;
      }
    },
    closeForSwap: (target: DbTarget) => {
      if (target === "config") config.closeForSwap();
      else runtime.closeForSwap();
    },
    reopen: (target: DbTarget) => {
      if (target === "config") config.reopen();
      else runtime.reopen();
    },
  };

  const app = new Elysia({ prefix: "/console/api" })
    // ---- public ----
    .get("/ip", () => ({ ips: diagnostics.localIps() }))
    .post("/login", async ({ body, request, set }: { body: unknown; request: Request; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const snapshot = await services.settings.get();
      const result: LoginResult = await services.auth.login(
        typeof body === "object" && body !== null ? (body as Record<string, unknown>).password : undefined,
        clientIp(request, snapshot.runtime.trustProxy),
        request,
      );
      if (!result.ok) {
        set.status = result.status;
        return result.code === "rate_limited"
          ? { ...consoleError("rate_limited", result.message ?? "too many failed attempts"), retryAfterSec: result.retryAfterSec }
          : consoleError(result.code ?? "unauthorized", result.message ?? "login failed");
      }
      if (result.token !== null && result.expiresInSec !== null) {
        set.headers["set-cookie"] = buildSessionCookie(
          result.token,
          result.expiresInSec,
          isHttpsRequest(request, snapshot.runtime.trustProxy),
        );
      }
      return { ok: true, expiresInSec: result.expiresInSec };
    })
    // ---- authenticated console API ----
    .guard({ beforeHandle: sessionGuard }, (group) =>
      group
        .post("/logout", ({ set }: { set: { headers: HTTPHeaders } }) => {
          set.headers["set-cookie"] = buildSessionClearCookie();
          return ok();
        })
        .get("/session", async () => services.auth.session())
        .post("/settings/password", async ({ body, set }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const result = await services.auth.changePassword(value.currentPassword, value.newPassword, value.confirmPassword);
          if (!result.ok) {
            set.status = result.status;
            return consoleError(result.code ?? "invalid_request", result.message);
          }
          return ok({ note: result.message });
        })
        .post("/settings/logout-all", async ({ body, set }: { body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const result = await services.auth.logoutAll(value.password);
          if (!result.ok) {
            set.status = result.status;
            return consoleError(result.code ?? "unauthorized", result.message);
          }
          set.headers["set-cookie"] = buildSessionClearCookie();
          return ok();
        })
        .get("/settings", async () => ({ settings: await services.settings.get() }))
        .post("/settings", async ({ body }) => ({ settings: await services.settings.patchRuntime(body) }))
        // ---- backup / restore (dashboard Settings → "Backup & Restore") ----
        // Export is config-only by design: runtime metadata (usage history,
        // console logs) lives in a separate database and is never part of a
        // configuration backup, so ?includeHistory is accepted but inert —
        // matching the legacy export contract.
        .post("/settings/reset-all", async ({ body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const result = await services.backup.resetAll(value.password, value.confirmation, deps.resetConfig, deps.resetRuntime);
          if (!result.ok) { set.status = result.status; return consoleError(result.code ?? "invalid_request", result.message); }
          return { ok: true, message: result.message };
        })
        .get("/settings/backup", async ({ request, set }: { request: Request; set: { status?: number | string; headers: HTTPHeaders } }) => {
          const verified = await services.backup.verifyPassword(request.headers.get("x-console-password"));
          if (!verified.ok) {
            set.status = verified.status;
            return consoleError(verified.code ?? "unauthorized", verified.message);
          }
          const payload = services.backup.exportBackup();
          set.headers["content-type"] = "application/json; charset=utf-8";
          set.headers["content-disposition"] = `attachment; filename="cartethyia-backup-${new Date().toISOString().slice(0, 10)}.json"`;
          set.headers["cache-control"] = "no-store";
          return payload;
        })
        .post("/settings/restore", async ({ body, request, set }) => {
          const length = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(length) && length > MAX_BACKUP_BYTES) {
            set.status = 413;
            return consoleError("request_too_large", `backup payload exceeds ${MAX_BACKUP_BYTES} bytes`);
          }
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const result = await services.backup.restore(value.password, value.backup);
          if (!result.ok) {
            set.status = result.status;
            return consoleError(result.code ?? "invalid_request", result.message);
          }
          return ok();
        })
        .post("/settings/restore/9router", async ({ body, request, set }) => {
          const length = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(length) && length > MAX_BACKUP_BYTES) { set.status = 413; return consoleError("request_too_large", "9router payload is too large"); }
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          try {
            const conversion = convert9RouterBackup(value.backup ?? value);
            const result = await services.backup.restore(value.password, conversion.backup);
            if (!result.ok) { set.status = result.status; return consoleError(result.code ?? "invalid_request", result.message); }
            return { ok: true, report: conversion.report };
          } catch (error) {
            set.status = 400;
            return consoleError("invalid_request", error instanceof Error ? error.message : "invalid 9router backup");
          }
        })
        // ---- keys ----
        .get("/keys", async () => ({ items: await services.keys.list() }))
        .post("/keys", async ({ body, set }) => {
          const result = await services.keys.create(body);
          if (!("key" in result)) {
            return conflict(set, result.message);
          }
          return { ...result.record, key: result.key, note: "store this key now; it will not be shown again" };
        })
        .patch("/keys/:id", async ({ params, body, set }) => {
          const record = await services.keys.update(params.id, body);
          if (record === null) return notFound(set);
          return record;
        })
        .post("/keys/:id/regenerate", async ({ params, set }) => {
          const result = await services.keys.regenerate(params.id);
          if (result === null) return notFound(set);
          return { ...result.record, key: result.key };
        })
        .post("/keys/:id/revoke", async ({ params, set }) => {
          if (!(await services.keys.revoke(params.id))) return notFound(set);
          return ok();
        })
        .delete("/keys/:id", async ({ params, set }) => {
          if (!(await services.keys.remove(params.id))) return notFound(set);
          return ok();
        })
        .get("/keys/:id/credential", async ({ params, set }) => {
          const secret = await services.keys.credential(params.id);
          if (secret === null) return notFound(set);
          return secret;
        })
        // ---- providers ----
        .get("/providers", async () => {
          const providers = await services.providers.list();
          const items = await Promise.all(providers.map(async (provider) => {
            const [routingResult, accountsResult, modelsResult] = await Promise.allSettled([
              services.providers.getRouting(provider.id),
              services.accounts.list(provider.id),
              services.models.list(provider.id),
            ]);
            const routing = routingResult.status === "fulfilled"
              ? routingResult.value
              : { strategy: "priority" as const, stickyLimit: 1, useStickyLimit: false };
            const accounts = accountsResult.status === "fulfilled" ? accountsResult.value : [];
            const models = modelsResult.status === "fulfilled" ? modelsResult.value : [];
            return {
              ...provider,
              routing,
              accountCount: accounts.length,
              modelCount: models.length,
              configured: provider.credentialKind === "none" || accounts.some((account) => account.active),
            };
          }));
          return { items };
        })
        .get("/providers/:id", async ({ params, set }) => {
          const [summary, config, routing, models, accounts, custom] = await Promise.all([
            services.providers.list(),
            services.providers.getConfig(params.id),
            services.providers.getRouting(params.id),
            services.models.list(params.id),
            services.accounts.list(params.id),
            services.providers.listCustom(),
          ]);
          const provider = summary.find((entry) => entry.id === params.id);
          const customRecord = custom.find((entry) => entry.id === params.id);
          if (provider === undefined && customRecord === undefined) return notFound(set, "provider not found");
          return {
            ...(provider ?? {
              id: params.id,
              name: customRecord?.name ?? params.id,
              protocol: "native",
              credentialKind: "api_key",
              surfaces: ["openai-chat"],
              enabled: config?.enabled ?? true,
              custom: true,
            }),
            enabled: config?.enabled ?? true,
            custom: customRecord !== undefined,
            routing,
            models,
            modelManagement: { canAddModels: true, canFetchModels: provider !== undefined },
            accounts,
            customProvider: customRecord ?? null,
          };
        })
        .patch("/providers/:id", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          if (typeof value.enabled !== "boolean") return badRequest(set, "enabled must be a boolean");
          const config = await services.providers.setEnabled(params.id, value.enabled);
          if (config === null) return notFound(set, "provider not found");
          return config;
        })
        .post("/providers/:id/routing", async ({ params, body }) => ({ settings: await services.providers.setRouting(params.id, body) }))
        .get("/providers/:id/models", async ({ params }) => ({ items: await services.models.list(params.id) }))
        .post("/providers/:id/models/fetch", async ({ params, set }) => {
          try {
            const discovered = await services.providers.discoverBuiltinModels(params.id);
            // Persist discovered models so they appear in the catalog and are
            // accepted by resolveTarget.
            for (const modelId of discovered) {
              await services.models.addCustom(params.id, modelId);
            }
            return { items: await services.models.list(params.id), discovered };
          } catch (error) {
            return badRequest(set, error instanceof Error ? error.message : "Model fetch failed");
          }
        })
        .post("/providers/:id/models/discover", async ({ params, set }) => {
          try {
            const models = await services.providers.discoverBuiltinModels(params.id);
            return { models };
          } catch (error) {
            return badRequest(set, error instanceof Error ? error.message : "Model discovery failed");
          }
        })
        .post("/providers/:id/models", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          if (typeof value.modelId !== "string" || value.modelId.trim().length === 0) return badRequest(set, "modelId is required");
          const model = await services.models.addCustom(params.id, value.modelId);
          if (model === null) return badRequest(set, "provider or model is invalid");
          return model;
        })
        .delete("/providers/:id/models/:modelId", async ({ params, set }) => {
          if (!(await services.models.removeCustom(params.id, params.modelId))) return notFound(set, "only custom or fetched models can be deleted");
          return ok();
        })
        .patch("/providers/:id/models/:modelId", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          if (typeof value.enabled !== "boolean") return badRequest(set, "enabled must be a boolean");
          const model = await services.models.setEnabled(params.id, params.modelId, value.enabled);
          if (model === null) return notFound(set, "model not found");
          return model;
        })
        .post("/providers/:id/models/enabled", async ({ params, body }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const enabled = value.enabled === true;
          await services.models.setAllEnabled(params.id, enabled);
          return ok({ enabled });
        })
        // ---- custom providers ----
        .get("/custom-providers", async () => ({ items: await services.providers.listCustom() }))
        .post("/custom-providers", async ({ body, set }) => {
          const result = await services.providers.createCustom(body);
          if (!("id" in result)) {
            return result.status === 400 ? badRequest(set, result.message) : conflict(set, result.message);
          }
          return result;
        })
        .patch("/custom-providers/:id", async ({ params, body, set }) => {
          const record = await services.providers.updateCustom(params.id, body);
          if (record === null) return notFound(set);
          if (!("id" in record)) return record.status === 400 ? badRequest(set, record.message) : conflict(set, record.message);
          return record;
        })
        .delete("/custom-providers/:id", async ({ params, set }) => {
          if (!(await services.providers.removeCustom(params.id))) return notFound(set);
          return ok();
        })
        .get("/custom-providers/:id/credential", async ({ params, set }) => {
          const secret = await services.providers.customCredential(params.id);
          if (secret === null) return notFound(set);
          return secret;
        })
        .post("/custom-providers/:id/models/fetch", async ({ params, set }) => {
          const result = await services.providers.fetchCustomModels(params.id);
          if (!("id" in result)) return badRequest(set, result.error);
          return result;
        })
        .post("/custom-providers/:id/health", async ({ params, set }) => {
          const result = await services.providers.checkCustomProviderHealth(params.id);
          if (!result.ok) set.status = 503;
          return result;
        })
        .post("/custom-providers/:id/models", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
          const modelId = "modelId" in value ? value.modelId : undefined;
          if (typeof modelId !== "string" || modelId.trim().length === 0) return badRequest(set, "modelId is required");
          const result = await services.providers.addCustomModel(params.id, modelId);
          if (!("id" in result)) return badRequest(set, result.error);
          return result;
        })
        .delete("/custom-providers/:id/models/:modelId", async ({ params, set }) => {
          if (!(await services.providers.deleteCustomModel(params.id, params.modelId))) return notFound(set, "model not found");
          return ok();
        })
        // ---- accounts ----
        .get("/providers/:id/accounts", async ({ params, query }) => {
          const limit = Number(query.limit) || 50;
          const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
          return await services.accounts.listPaged(params.id, { limit, cursor });
        })
        .post("/providers/:id/accounts", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), providerId: params.id } : { providerId: params.id };
          const result = await services.accounts.create(value);
          if (!("id" in result)) {
            return badRequest(set, result.message);
          }
          return result;
        })
        .post("/providers/:id/accounts/:accountId", async ({ params, body, set }) => {
          const record = await services.accounts.update(params.accountId, body);
          if (record === null) return notFound(set, "account not found");
          return record;
        })
        .delete("/providers/:id/accounts/:accountId", async ({ params, set }) => {
          if (!(await services.accounts.remove(params.accountId))) return notFound(set, "account not found");
          return ok();
        })
        // ---- batch operations ----
        .post("/providers/:id/accounts/batch-delete", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const raw = Array.isArray(value.ids) ? value.ids : undefined;
          if (raw === undefined) return badRequest(set, "ids array is required");
          const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
          if (ids.length === 0) return badRequest(set, "at least one id is required");
          const deleted = await services.accounts.removeBatch(ids);
          return { ok: true, deleted };
        })
        .patch("/providers/:id/accounts/batch", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const raw = Array.isArray(value.ids) ? value.ids : undefined;
          if (raw === undefined) return badRequest(set, "ids array is required");
          const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
          if (ids.length === 0) return badRequest(set, "at least one id is required");
          if (typeof value.active !== "boolean") return badRequest(set, "active boolean is required");
          const updated = await services.accounts.setActiveBatch(ids, value.active);
          return { ok: true, updated };
        })
        .patch("/accounts/:id", async ({ params, body, set }) => {
          const record = await services.accounts.update(params.id, body);
          if (record === null) return notFound(set);
          return record;
        })
        .delete("/accounts/:id", async ({ params, set }) => {
          if (!(await services.accounts.remove(params.id))) return notFound(set);
          return ok();
        })
        .get("/accounts/:id/credential", async ({ params, set }) => {
          const secret = await services.accounts.credential(params.id);
          if (secret === null) return notFound(set);
          return secret;
        })
        .post("/accounts/:id/quota/refresh", async ({ params, set }) => {
          const quota = await services.quota.refresh(params.id);
          if (quota === null) return notFound(set);
          return quota;
        })
        .get("/accounts/:id/quota", async ({ params, set }) => {
          const quota = await services.quota.get(params.id);
          if (quota === null) return notFound(set);
          return quota;
        })
        // ---- OAuth lifecycle ----
        // Interactive login: start returns the authorization URL; the client
        // opens it, the provider redirects back with `code`/`state`, and
        // complete() exchanges + persists the account. Poll status via
        // GET /oauth/sessions/:sessionId.
        .post("/providers/:id/oauth/start", async ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), providerId: params.id } : { providerId: params.id };
          const result = await services.oauth.start(value);
          if (!("sessionId" in result)) {
            set.status = result.status;
            return consoleError(result.code ?? "invalid_request", result.message);
          }
          return result;
        })
        .get("/oauth/sessions/:sessionId", async ({ params, set }) => {
          const session = await services.oauth.session(params.sessionId);
          if (session === null) return notFound(set, "OAuth login session not found");
          return session;
        })
        .post("/oauth/sessions/:sessionId/complete", async ({ params, body, set }) => {
          const result = await services.oauth.complete(params.sessionId, body);
          if (!("accountId" in result)) {
            set.status = result.status;
            return consoleError(result.code ?? "invalid_request", result.message);
          }
          return result;
        })
        .post("/oauth/sessions/:sessionId/cancel", async ({ params, set }) => {
          if (!(await services.oauth.cancel(params.sessionId))) return notFound(set, "OAuth login session not found");
          return ok();
        })
        .post("/oauth/refresh", async ({ body, set }) => {
          const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const result = await services.oauth.refreshAccount(typeof value.accountId === "string" ? value.accountId : "");
          if (!result.ok) {
            set.status = result.status;
            return consoleError(result.code ?? "invalid_request", result.message);
          }
          return result;
        })
        .post("/accounts/:id/revoke", async ({ params, set }) => {
          if (!(await services.oauth.revoke("", params.id))) return notFound(set, "account not found");
          return ok();
        })
        .post("/providers/:id/accounts/:accountId/revoke", async ({ params, set }) => {
          if (!(await services.oauth.revoke(params.id, params.accountId))) return notFound(set, "account not found");
          return ok();
        })
        .get("/accounts/:id/oauth-status", async ({ params, set }) => {
          const status = await services.oauth.accountStatus(params.id);
          if (status === null) return notFound(set, "account not found");
          return status;
        })
        // ---- proxies ----
        .get("/proxies", async ({ query }) => {
          const items = await services.proxies.list();
          const limit = typeof query.limit === "string" && Number.isFinite(Number(query.limit)) ? Math.min(Math.max(Number(query.limit), 1), 100) : 100;
          return { items: items.slice(0, limit) };
        })
        .post("/proxies", async ({ body, set }) => {
          const result = await services.proxies.create(body);
          if (!("id" in result)) {
            return badRequest(set, result.message);
          }
          return result;
        })
        .patch("/proxies/:id", async ({ params, body, set }) => {
          const record = await services.proxies.update(params.id, body);
          if (record === null) return notFound(set);
          return record;
        })
        .post("/proxies/:id/test", async ({ params, set }) => {
          const result = await services.proxies.test(params.id);
          if (result === null) return notFound(set);
          return result;
        })
        .post("/proxies/test", async ({ body }) => services.proxies.testAdHoc(body))
        .delete("/proxies/:id", async ({ params, set }) => {
          if (!(await services.proxies.remove(params.id))) return notFound(set);
          return ok();
        })
        .get("/proxies/:id/credential", async ({ params, set }) => {
          const secret = await services.proxies.credential(params.id);
          if (secret === null) return notFound(set);
          return secret;
        })
        .get("/proxy-settings", async () => services.proxies.getSettings())
        .post("/proxy-settings", async ({ body }) => services.proxies.patchSettings(body))
        // ---- aliases and combos ----
        .get("/aliases", async () => ({ items: await services.routing.listAliases() }))
        .post("/aliases", async ({ body, set }) => {
          const result = await services.routing.createAlias(body);
          if (!("alias" in result)) {
            return badRequest(set, result.message);
          }
          return result;
        })
        .delete("/aliases/:alias", async ({ params, set }) => {
          if (!(await services.routing.deleteAlias(params.alias))) return notFound(set);
          return ok();
        })
        .get("/combos", async () => ({ items: await services.routing.listCombos() }))
        .post("/combos", async ({ body, set }) => {
          const result = await services.routing.putCombo(body);
          if (!("id" in result)) {
            return badRequest(set, result.message);
          }
          return result;
        })
        .patch("/combos/:id", async ({ params, body, set }) => {
          const result = await services.routing.putCombo(body, params.id);
          if (!("id" in result)) {
            return badRequest(set, result.message);
          }
          return result;
        })
        .delete("/combos/:id", async ({ params, set }) => {
          if (!(await services.routing.deleteCombo(params.id))) return notFound(set);
          return ok();
        })
        // ---- filter rules ----
        .get("/filters", async () => services.filterRules.list())
        .post("/filters", async ({ body, set }) => {
          const result = await services.filterRules.create(body);
          if (!("ruleId" in result)) { set.status = result.status; return consoleError(result.code, result.message); }
          set.status = 201;
          return result;
        })
        .patch("/filters/:id", async ({ params, body, set }) => {
          const id = Number(params.id);
          if (!Number.isFinite(id)) return badRequest(set, "invalid id");
          const result = await services.filterRules.update(id, body);
          if (!("ruleId" in result)) { set.status = result.status; return consoleError(result.code, result.message); }
          return result;
        })
        .delete("/filters/:id", async ({ params, set }) => {
          const id = Number(params.id);
          if (!Number.isFinite(id)) return badRequest(set, "invalid id");
          if (!(await services.filterRules.remove(id))) return notFound(set);
          return ok();
        })
        // ---- CLI tools ----
        .use(createCliToolsApi())
        // ---- Database Map ----
        .use(createDbMapApi(dbMapPersistence))
        // ---- Warp pool ----
        .use(warpApi.app)
        .post("/resolve-preview", async ({ body }) => diagnostics.resolvePreview(body))
        // ---- usage / runtime metadata ----
        .get("/usage/summary", async ({ query }) => ({
          period: typeof query.period === "string" ? query.period : "24h",
          totals: await diagnostics.usageSummary(query.period),
        }))
        .get("/usage/cache", async ({ query }) => ({ period: typeof query.period === "string" ? query.period : "24h", ...(await diagnostics.usageCache(query.period)) }))
        .get("/usage/chart", async ({ query }) => ({ buckets: await diagnostics.usageChart(query.period) }))
        .get("/usage/by-model", async ({ query }) => ({ rows: await diagnostics.usageBy("model", query.period) }))
        .get("/usage/by-key", async ({ query }) => ({ rows: await diagnostics.usageBy("key", query.period) }))
        .get("/usage/recent", async () => ({ items: (await diagnostics.requestHistory({ limit: 10 })).items }))
        .get("/usage/requests", async ({ query }) => diagnostics.requestHistory(query))
        .get("/usage/requests/:id", async ({ params, set }) => {
          const row = await diagnostics.requestDetail(params.id);
          if (row === null) return notFound(set, "request not found");
          return row;
        })
        .get("/usage/by-provider", async ({ query }) => ({ rows: await diagnostics.usageBy("provider", query.period) }))
        // ---- IP monitoring ----
        .get("/ips/summary", async ({ query }) => {
          const limit = typeof query.limit === "string" ? Number(query.limit) : 100;
          return { items: await diagnostics.queryIpSummary(Number.isFinite(limit) ? limit : 100) };
        })
        .get("/ips/:ip/requests", async ({ params, query }) => {
          return diagnostics.requestHistory({ ...query, clientIp: params.ip });
        })
        // ---- IP bans ----
        .get("/ip-bans", async () => ({ items: await config.ipBans.list() }))
        .post("/ip-bans", async ({ body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const ip = typeof value.ip === "string" ? value.ip.trim() : "";
          if (!ip) return badRequest(set, "ip is required");
          const reason = typeof value.reason === "string" ? value.reason.trim() : "";
          return config.ipBans.add(ip, reason);
        })
        .delete("/ip-bans/:ip", async ({ params }) => {
          await config.ipBans.remove(params.ip);
          return ok();
        })
        // ---- diagnostics ----
        .get("/health/status", async () => diagnostics.status())
        .get("/health/metrics", async () => diagnostics.metrics())
        .get("/metrics", async ({ set }) => {
          set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
          return toPrometheus();
        })
        .post("/health/gc", async () => diagnostics.gc())
        .get("/live/in-flight", () => liveTrafficSnapshot(deps.liveTraffic))
        .get("/live/in-flight/stream", ({ request }) => liveTrafficStream(request, deps.liveTraffic))
        .get("/overview", async () => diagnostics.overview())
        .get("/console-logs", async ({ query }) => ({ items: await diagnostics.logs(query.limit) }))
        .delete("/console-logs", async () => {
          await deps.services.telemetry.clearLogs();
          deps.logStream.broadcastClear();
          return ok();
        })
        .get("/console-logs/stream", ({ request }) => consoleLogStream(deps.logStream, request))
        .get("/model-studio/sessions", () => ({ items: listStudioSessions() }))
        .get("/model-studio/sessions/:id", ({ params, set }) => {
          const session = getStudioSession(params.id);
          if (session === null) return notFound(set, "session not found");
          return session;
        })
        .post("/model-studio/sessions", ({ body }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          return createStudioSession({ title: typeof value.title === "string" ? value.title : undefined, model: typeof value.model === "string" ? value.model : undefined, systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined });
        })
        .patch("/model-studio/sessions/:id", ({ params, body, set }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const messages = value.messages === undefined ? undefined : normalizeStudioMessages(value.messages);
          if (value.messages !== undefined && messages === null) return badRequest(set, "messages must be a valid array");
          const session = patchStudioSession(params.id, { title: typeof value.title === "string" ? value.title : undefined, model: typeof value.model === "string" ? value.model : undefined, systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined, messages: messages ?? undefined });
          if (session === null) return notFound(set, "session not found");
          return session;
        })
        .delete("/model-studio/sessions/:id", ({ params, set }) => {
          if (!deleteStudioSession(params.id)) return notFound(set, "session not found");
          return ok();
        })
        .post("/model-studio/compact", async ({ body, request }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const messages = normalizeStudioMessages(value.messages);
          if (messages === null || messages.length === 0) return { summary: "No conversation content to compact." };
          const model = typeof value.model === "string" ? value.model : "unknown";
          const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : "";
          const maxTokens = typeof value.maxTokens === "number" && value.maxTokens > 0 ? value.maxTokens : 4096;

          // Build a summarization prompt: system instruction + conversation history.
          const conversationText = messages
            .filter((m) => m.content.trim().length > 0)
            .map((m) => `${m.role}: ${m.content.trim().replace(/\s+/g, " ").slice(0, 2000)}`)
            .join("\n\n");

          if (conversationText.trim().length === 0) return { summary: "No conversation content to compact." };

          const compactMessages = [
            { role: "system", content: `You are a conversation summarizer. Summarize the following conversation concisely, preserving key context, decisions, and any code or technical details. Keep it under 500 words.${systemPrompt ? `\n\nOriginal system prompt: ${systemPrompt.slice(0, 1000)}` : ""}` },
            { role: "user", content: `Summarize this conversation:\n\n${conversationText}` },
          ];

          const result = await runProxyRequest({
            request: {
              endpoint: "/v1/chat/completions",
              surface: "openai-chat",
              headers: new Headers({ "content-type": "application/json", "x-client-name": "pi" }),
              body: { model, messages: compactMessages, stream: false, max_tokens: Math.min(maxTokens, 2048) },
              signal: request.signal,
            },
            authorization: { apiKeyId: null, trustedIdentity: "console:model-studio", providerAllowlist: null, modelAllowlist: null, modelDenylist: null },
          }, deps.proxy);

          if (result.status >= 400 || result.body.mode !== "json") return { summary: "Compaction failed: upstream error.", usage: undefined };
          const responseBody = result.body.value as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          const summaryText = responseBody?.choices?.[0]?.message?.content?.trim() || "Compaction produced no output.";
          return { summary: summaryText, usage: responseBody?.usage };
        })
        .post("/model-studio/chat", async ({ body, request }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const result = await runProxyRequest({ request: { endpoint: "/v1/chat/completions", surface: "openai-chat", headers: new Headers({ "content-type": "application/json", "x-client-name": "pi" }), body: { model: value.model, messages: value.messages, stream: true, max_tokens: value.maxTokens }, signal: request.signal }, authorization: { apiKeyId: null, trustedIdentity: "console:model-studio", providerAllowlist: null, modelAllowlist: null, modelDenylist: null } }, deps.proxy);
          return presentProxyResult(result, "openai-chat", typeof value.model === "string" ? value.model : "unknown");
        })
        .post("/model-studio/image", async ({ body, request }) => {
          const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
          const images = Array.isArray(value.images) ? value.images : [];
          const endpoint = images.length > 0 ? "/v1/images/edits" : "/v1/images/generations";
          const result = await runProxyRequest({ request: { endpoint, surface: "images", headers: new Headers({ "content-type": "application/json", "x-client-name": "pi" }), body: { model: value.model, prompt: value.prompt, ...(images.length > 0 ? { images } : {}) }, signal: request.signal }, authorization: { apiKeyId: null, trustedIdentity: "console:model-studio", providerAllowlist: null, modelAllowlist: null, modelDenylist: null } }, deps.proxy);
          return presentProxyResult(result, "images", typeof value.model === "string" ? value.model : "unknown");
        })
        .post("/model-studio/probe", async ({ body, request, set }) => {
          const input = probeInput(body);
          if (input === null) return badRequest(set, "provider and model are required");
          beginProviderInFlight(input.provider);
          let result: Awaited<ReturnType<typeof deps.probe>>;
          try {
            result = await deps.probe({ ...input, signal: request.signal }, deps.probePorts);
          } finally {
            endProviderInFlight(input.provider);
          }
          await services.telemetry.recordProbe({
            providerId: input.provider,
            model: input.model,
            credentialMode: input.credentialMode,
            ok: result.ok,
            mode: result.mode,
            latencyMs: result.latencyMs,
            errorKind: result.ok ? null : result.error.kind,
            occurredAt: new Date().toISOString(),
          });
          return result;
        }),
    );

  return { app, warpService: warpApi.service };
}

