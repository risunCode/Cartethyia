import type { CartethyiaRuntime } from "../bootstrap/composition";

export type ProxyErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "authorization_denied"
  | "rate_limit_error"
  | "request_too_large"
  | "not_found"
  | "internal_error"
  | "model_not_found"
  | "provider_unavailable"
  | "uri_too_long";

export function errorResponse(status: number, code: ProxyErrorCode, message: string, requestId = crypto.randomUUID()): Response {
  return Response.json({ error: { type: "error", code, message, request_id: requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

export function recordAccessLog(runtime: CartethyiaRuntime, pathname: string, request: Request, requestId: string, status: number, startedAt: number): void {
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  runtime.logger.web(level, `${request.method} ${pathname} ${status} ${Math.max(0, performance.now() - startedAt).toFixed(1)}ms request_id=${requestId}`);
}
