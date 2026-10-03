// Single-read ingress body policy: route table, size/media enforcement, depth cap.
import { Elysia } from "elysia";
import { GatewayError } from "../gateway-error";
import { assertBoundedJsonDepth } from "../../protocol/primitives";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../request/pathname";
import { NATIVE_SERVICE_PATHS } from "../dispatch/native-services";

function isProxyRequest(request: Request): boolean {
  return fastPathname(request.url).startsWith("/v1/");
}

/**
 * Canonical JSON proxy routes that read a body through the ingress pipeline.
 *
 * This list must mirror the routes `app.ts` actually mounts. It drives
 * body-read policy — a JSON route rejects a missing or non-JSON content-type
 * with 415, while an unrouted path is not read at all — so an entry with no
 * handler behind it describes a route the gateway does not serve. Three such
 * entries (`/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`) sat
 * here with no adapter and no handler: they advertised a surface that 404s.
 *
 * The native service routes (`NATIVE_SERVICE_PATHS`, System One) are included:
 * they read a JSON body through the same policy, but their bodies are opaque
 * and are excluded from the canonical parse stage (see `request-context.ts`).
 */
const PROXY_JSON_ROUTES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/completions",
  "/v1/responses/compact",
  "/v1/messages",
  ...NATIVE_SERVICE_PATHS,
] as const;

/** Whether `path` is one of the canonical JSON proxy routes. */
function isJsonProxyRoute(path: string): boolean {
  return (PROXY_JSON_ROUTES as readonly string[]).includes(path);
}

/**
 * Whether `path` is a provider-dispatching route. Discovery/surface routes
 * such as `/v1/models` are authenticated gateway routes but never dispatch, so
 * they must not be reported as proxy request lifecycle events or enqueue
 * telemetry rows.
 */
export function isProxyDispatchRoute(path: string | undefined): path is string {
  return path !== undefined && isJsonProxyRoute(path);
}

export function isJsonProxyRoutePath(path: string): boolean {
  return isJsonProxyRoute(path);
}

export interface IngressPolicyOptions {
  readonly maxBodyBytes?: number;
}

/** Reads a proxy body exactly once and enforces its encoded size and media type. */
export async function readIngressBody(
  request: Request,
  options: IngressPolicyOptions = {},
): Promise<unknown> {
  if (!isProxyRequest(request)) return undefined;
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const p = fastPathname(request.url);
  const isJsonRoute = isJsonProxyRoute(p);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType) {
    if (isJsonRoute) throw new GatewayError("unsupported_media_type", 415, "content-type must be application/json");
    return undefined;
  }
  if (contentType !== "application/json") {
    if (isJsonRoute) throw new GatewayError("unsupported_media_type", 415, "content-type must be application/json");
    return undefined;
  }
  const maxBytes = options.maxBodyBytes ?? 1_048_576;
  const declared = request.headers.get("content-length");
  const parsed = declared === null ? undefined : Number(declared);
  if (declared !== null && (!/^\d+$/.test(declared) || parsed === undefined || parsed > maxBytes))
    throw new GatewayError("invalid_request", 413, "request body exceeds configured limit");

  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError("invalid_request", 400, "malformed JSON request body");
  // Collect raw chunks then decode once. String `+=` on each chunk reallocates
  // the accumulating UTF-16 string (O(n²) for large Claude Code prompts);
  // Buffer.concat + one TextDecoder pass is linear and allocation-stable.
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GatewayError("invalid_request", 413, "request body exceeds configured limit");
      }
      chunks.push(chunk);
    }
  } finally {
    // The oversize branch above cancels the reader, and `cancel()` releases
    // the lock itself — releasing again throws ERR_INVALID_STATE, which would
    // replace the intended 413 with an opaque runtime error.
    try {
      if (request.body?.locked) reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }
  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const body = JSON.parse(text) as unknown;
    assertBoundedJsonDepth(body);
    return body;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("invalid_request", 400, "malformed JSON request body");
  }
}

export function createIngressPolicyMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly maxBodyBytes?: number;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const state = deps.stateStore.get(request);
      if (!state) return;
      state.ingressBody = await readIngressBody(
        request,
        ...(deps.maxBodyBytes === undefined ? [] : [{ maxBodyBytes: deps.maxBodyBytes }]),
      );
    })
    .as("plugin");
}
