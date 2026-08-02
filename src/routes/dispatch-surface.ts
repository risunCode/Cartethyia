/**
 * Shared post-dispatch branching for /v1/* surface routes (chat, messages,
 * responses): given a `dispatchQualifiedRoute` result, map an error to the
 * surface's client-error envelope, or stream/finish the successful result.
 *
 * Previously copy-pasted near-identically across chat.ts, responses.ts, and
 * (twice - once for the standard flow, once for the compact-edit
 * "trigger not yet met" fallthrough) messages.ts, with one drift: only
 * chat.ts set `retry-after` on 429/503 and mapped 429 to `rate_limit_error`.
 * All three surfaces now share that policy - a 429 is a rate limit
 * regardless of which wire shape the client speaks.
 */

import { toSSEResponseStream } from "../upstream/sse";
import { withStreamErrorHandling } from "../upstream/bridge";
import type { StreamEvent } from "../upstream/bridge";
import type { RequestTracker } from "../console/tracking/tracker";
import type { QualifiedDispatchResult } from "../upstream/dispatch";
import type { ClientErrorKind } from "../http/errors";

type StreamFormat = "openai-chat" | "anthropic" | "openai-responses";

export interface SurfaceDispatchOptions {
  qualified: QualifiedDispatchResult;
  set: { status?: number | string; headers: Record<string, string | number> };
  tracker: RequestTracker;
  /** Original (already-translated) request body, passed to tracker calls for logging. */
  requestBody: unknown;
  clientError: (status: number, kind: Exclude<ClientErrorKind, "upstream_error">, message: string) => unknown;
  streamFormat: StreamFormat;
  encodeStream: (events: AsyncGenerator<StreamEvent>, meta: { id: string; model: string; createdAt: number }) => AsyncGenerator<string>;
  /** Prefix for the synthesized response id ("chatcmpl", "msg", "resp"). */
  idPrefix: string;
  model: string;
  /** Maps the successful non-streaming JSON body back into the surface's own response shape (identity for chat, which never leaves Chat shape). */
  toSurfaceJson: (body: Record<string, unknown>) => unknown;
}

/** Finishes a qualified-dispatch outcome for a /v1/* surface route. */
export function finishSurfaceDispatch(opts: SurfaceDispatchOptions): unknown {
  const { qualified } = opts;

  if (qualified.kind === "error") {
    opts.set.status = qualified.status;
    if (qualified.status === 429 || qualified.status === 503) opts.set.headers["retry-after"] = "60";
    opts.tracker.fail(qualified.status, "dispatch_error", opts.requestBody, qualified.message);
    const kind: Exclude<ClientErrorKind, "upstream_error"> =
      qualified.status === 401 || qualified.status === 403 ? "authentication_error" : qualified.status === 429 ? "rate_limit_error" : "invalid_request_error";
    return opts.clientError(qualified.status, kind, qualified.message);
  }

  const { result, accountLabel } = qualified;
  opts.tracker.setNetworkPath(qualified.networkPath);
  if (result.type === "stream") {
    opts.set.headers["content-type"] = "text/event-stream";
    const meta = { id: `${opts.idPrefix}-${crypto.randomUUID()}`, model: opts.model, createdAt: Math.floor(Date.now() / 1000) };
    return opts.tracker.wrapSse(
      toSSEResponseStream(withStreamErrorHandling(opts.encodeStream(result.events, meta), opts.streamFormat)),
      qualified.provider,
      opts.requestBody,
      accountLabel,
    );
  }
  return opts.tracker.finishJson(200, opts.toSurfaceJson(result.body), qualified.provider, opts.requestBody, accountLabel);
}
