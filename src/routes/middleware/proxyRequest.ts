/**
 * Shared proxy-auth + request-tracker + upstream-error-mapping sequence
 * (REQ-5). Previously copy-pasted near-identically across `chat.ts`,
 * `messages.ts`, and `responses.ts` — now one implementation route
 * handlers wrap their surface-specific translate/dispatch/stream logic in.
 */

import { enforceProxyAuth } from "../../console/proxy-auth";
import { consumeOneTimeTokensForKey } from "../../console/db/repos/api-keys";
import { openAIClientError } from "../../http/errors";
import { createRequestTracker, type RequestTracker, type TrackSurface } from "../../console/tracking/tracker";
import { tryAcquireKeySlot, releaseKeySlot, releaseTokenReservationForKey } from "../../console/tracking/key-in-flight";
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

  const keyId = auth.key?.id;
  const maxConcurrent = auth.key?.maxConcurrentRequests;
  const tokensReserved = auth.tokensReserved;
  if (keyId && maxConcurrent && !tryAcquireKeySlot(keyId, maxConcurrent)) {
    if (keyId && tokensReserved > 0) releaseTokenReservationForKey(keyId, tokensReserved);
    opts.set.status = 429;
    return openAIClientError(429, "rate_limit_error", "This key exceeded its concurrent request limit.");
  }

  const tracker = createRequestTracker({
    endpoint: opts.endpoint,
    surface: opts.surface,
    model: opts.model,
    stream: opts.stream,
    request: opts.request,
    apiKey: auth.key,
    onTokenUsage: auth.holdTokenReservation && keyId
      ? (tokens) => {
          consumeOneTimeTokensForKey(keyId, tokens);
          releaseTokenReservationForKey(keyId, tokensReserved);
        }
      : undefined,
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
  } finally {
    if (keyId && maxConcurrent) releaseKeySlot(keyId);
    // One-time budgets release only after the tracker has measured usage;
    // regular daily/monthly reservations can be released with the request.
    if (keyId && tokensReserved > 0 && !auth.holdTokenReservation) releaseTokenReservationForKey(keyId, tokensReserved);
  }
}
