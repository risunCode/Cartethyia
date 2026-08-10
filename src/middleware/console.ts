import type { CartethyiaRuntime } from "../bootstrap/composition";
import { runtimeRecordFromJson } from "../console/runtime-settings";
import { guardConsoleRequest } from "../console/session";
import { secureResponse } from "../security/headers";
import { errorResponse, recordAccessLog } from "./shared";
export async function safeConsoleHandle(runtime: CartethyiaRuntime, request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "QUERY" && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "invalid_request", "QUERY requests require Content-Type: application/json");
  }

  // Fast body-size rejection: a single header parse, no crypto or DB work.
  // Restore endpoints allow up to MAX_BACKUP_BYTES (64 MiB — sidebar icon
  // data URLs alone can reach ~36 MiB). All other console routes cap at 5 MiB.
  const contentLength = request.headers.get("content-length");
  const isRestorePath = pathname === "/console/api/settings/restore" || pathname === "/console/api/settings/restore/9router";
  const maxBodyBytes = isRestorePath ? 64 * 1024 * 1024 : 5_000_000;
  if (contentLength !== null && Number(contentLength) > maxBodyBytes) {
    return errorResponse(413, "request_too_large", "Request body too large");
  }

  // Fast auth check before Elysia parses the body. Elysia's lifecycle parses
  // the request body BEFORE .guard({ beforeHandle }) runs, so under a flood of
  // unauthenticated requests the JSON parser burns CPU on bodies that are
  // immediately rejected by the session guard. Login is the only public
  // mutating endpoint — it must receive the password, so it bypasses this
  // pre-check. The Elysia .guard() remains as defense-in-depth for every
  // other route. When settings aren't initialized yet (snapshot === null)
  // there is no JWT secret or password version to validate against, so we
  // skip the pre-check and let Elysia's own guard handle it after bootstrap.
  const isPublic = pathname === "/console/api/login";
  if (!isPublic) {
    const snapshot = runtime.config.settings.get();
    if (snapshot !== null) {
      const guardSettings = runtimeRecordFromJson(snapshot.settingsJson);
      const verdict = await guardConsoleRequest(request, {
        jwtSecret: snapshot.jwtSecret ?? "",
        passwordVersion: snapshot.passwordVersion,
        trustProxy: guardSettings.trustProxy === true,
        publicOrigin: typeof Bun.env.PUBLIC_ORIGIN === "string" ? Bun.env.PUBLIC_ORIGIN : undefined,
      });
      if (!verdict.ok) {
        const code = verdict.code === "forbidden" ? "authorization_denied" : "authentication_failed";
        return errorResponse(verdict.status, code, verdict.message);
      }
    }
  }
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  try {
    const response = await runtime.consoleApp.handle(request);
    recordAccessLog(runtime, pathname, request, requestId, response.status, startedAt);
    const headers = new Headers(response.headers);
    if (request.method === "QUERY") headers.set("accept-query", "application/json");
    const secured = secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), { request, noStore: pathname.startsWith("/console/api") });
    return secured;
  } catch (error) {
    runtime.logger.system("error", "console", `${request.method} ${pathname} failed request_id=${requestId} error=${error instanceof Error ? error.name : "unknown"}`);
    return errorResponse(500, "internal_error", `Console ${request.method} request to ${pathname} failed`, requestId);
  }
}
