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
import type { ConfigPersistence } from "../../storage";
import type { ModelProbeInput, ModelProbeResult, ProbePorts } from "../probe";
import type { ConsoleDiagnostics } from "../diagnostics";
import type { ConsoleLogStreamHub } from "../streams";
import { createWarpApi, type WarpApiMount } from "../warp/api-routes";
import type { RuntimePersistence } from "../../storage/runtime/runtime";
import type { DbMapPersistence } from "../db-map/service";
import type { DbTarget } from "../db-map/types";
import type { ProxyRequestDependencies } from "../../application/request";
import {
  buildSessionCookie,
  clientIp,
  consoleError,
  guardConsoleRequest,
  isHttpsRequest,
  type ConsoleServices,
  type LoginResult,
} from "../services/composition";
import { registerSettingsRoutes } from "./settings-routes";
import { registerApiKeyRoutes } from "./api-key-routes";
import { registerProviderRoutes } from "./provider-routes";
import { registerAccountRoutes } from "./account-routes";
import { registerProxyRoutes } from "./proxy-routes";
import { registerRoutingRoutes } from "./routing-routes";
import { registerDiagnosticRoutes } from "./diagnostic-routes";

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

/** Session + mutation guard mapped to the console error envelope. */
function createConsoleSessionGuard(services: ConsoleServices) {
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


export function createConsoleApi(deps: ConsoleRouterDependencies) {
  const { services, diagnostics, config, runtime } = deps;
  const warpApi: WarpApiMount = createWarpApi(config, runtime);
  const sessionGuard = createConsoleSessionGuard(services);

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
    .onBeforeHandle(({ request, body, query }) => {
      if (request.method !== "QUERY" || typeof body !== "object" || body === null || Array.isArray(body)) return;
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") query[key] = String(value);
      }
    })
    // ---- public ----
    .route("QUERY", "/ip", () => ({ ips: diagnostics.localIps() }))
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
      registerDiagnosticRoutes(
        registerRoutingRoutes(
          registerProxyRoutes(
            registerAccountRoutes(
              registerProviderRoutes(
                registerApiKeyRoutes(
                  registerSettingsRoutes(group, {
                    services,
                    resetConfig: deps.resetConfig,
                    resetRuntime: deps.resetRuntime,
                  }),
                  { services, config },
                ),
                { services },
              ),
              { services },
            ),
            { services },
          ),
          { services },
        ),
        {
          services,
          diagnostics,
          config,
          runtime,
          logStream: deps.logStream,
          probe: deps.probe,
          probePorts: deps.probePorts,
          liveTraffic: deps.liveTraffic,
          proxy: deps.proxy,
          dbMapPersistence,
          warpApi,
        },
      ),
    );

  return { app, warpService: warpApi.service };
}

