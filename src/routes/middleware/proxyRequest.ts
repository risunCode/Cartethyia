/**
 * Shared proxy-auth + request-tracker + upstream-error-mapping sequence
 * (REQ-5). Previously copy-pasted near-identically across `chat.ts`,
 * `messages.ts`, and `responses.ts` — now one implementation route
 * handlers wrap their surface-specific translate/dispatch/stream logic in.
 */

import { enforceProxyAuth } from "../../console/proxy-auth";
import { createRequestTracker, type RequestTracker, type TrackSurface } from "../../console/tracking/tracker";
import { UpstreamError, ProviderCallError } from "../../upstream/providers";

type UpstreamErrorMapper = (err: UpstreamError) => { status: number; body: unknown };

export interface ProxyRequestOptions {
  endpoint: string;
  surface: TrackSurface;
  model: string | undefined;
  stream: boolean;
  request: Request;
  server: { requestIP(request: Request): { address: string } | null } | null | undefined;
  set: { status?: number | string };
  /** `openAIUpstreamError` for chat/responses surfaces, `anthropicUpstreamError` for the Anthropic Messages surface. */
  errorMapper: UpstreamErrorMapper;
}

export interface ProxyRequestContext {
  tracker: RequestTracker;
  /** Call once the surface-specific request body is parsed/translated so a failure can log it. */
  recordRequestBody: (body: unknown) => void;
}

export async function withProxyRequest<T>(opts: ProxyRequestOptions, handler: (ctx: ProxyRequestContext) => Promise<T>): Promise<T | unknown> {
  const directIp = opts.server?.requestIP(opts.request)?.address;
  const auth = enforceProxyAuth(opts.model, opts.request, directIp);
  if (auth.error) {
    opts.set.status = auth.error.status;
    return auth.error.body;
  }

  const tracker = createRequestTracker({
    endpoint: opts.endpoint,
    surface: opts.surface,
    model: opts.model,
    stream: opts.stream,
    request: opts.request,
    apiKey: auth.key,
  });

  let requestBody: unknown;
  try {
    return await handler({ tracker, recordRequestBody: (body) => { requestBody = body; } });
  } catch (err) {
    if (err instanceof UpstreamError || err instanceof ProviderCallError) {
      const upstreamErr = err instanceof ProviderCallError ? err.toUpstreamError() : err;
      const friendly = opts.errorMapper(upstreamErr);
      opts.set.status = friendly.status;
      tracker.fail(friendly.status, "upstream_error", requestBody);
      return friendly.body;
    }
    tracker.fail(500, "internal_error", requestBody);
    throw err;
  }
}
