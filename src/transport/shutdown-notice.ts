/**
 * Public termination notice for a draining process.
 *
 * A drain has two operator-visible shapes that a caller must tell apart: an
 * ordinary stop (`SIGTERM`/`SIGINT`/`reload`) where the process may not be
 * coming back, and an in-place image swap where a replacement is seconds away.
 * Both are 503, but the update case is safe to retry almost immediately, so it
 * carries its own code and a message that says so instead of the generic
 * "Service is shutting down" that leaves the caller guessing.
 *
 * The reason is a plain string so this module stays a leaf: the drain owner
 * (`runtime/lifecycle.ts`) owns the `ShutdownReason` union and hands it over as
 * text, and both the readiness probe (`app.ts`) and the request gate
 * (`gateway-guards.ts`) render the same notice from it.
 */
import { GatewayError, type GatewayErrorCode } from "./gateway-error";

export interface ShutdownNotice {
  readonly code: Extract<GatewayErrorCode, "shutting_down" | "restart_for_update">;
  readonly message: string;
}

/**
 * The drain reason that marks an in-place update rather than a stop. Delivered
 * by `SIGUSR2` (see `main.ts`); an update procedure signals the old container
 * with it before swapping the image so its callers are told the process is
 * coming straight back.
 */
export const UPDATE_SHUTDOWN_REASON = "update";

export function shutdownNotice(reason: string | undefined): ShutdownNotice {
  if (reason === UPDATE_SHUTDOWN_REASON) {
    return { code: "restart_for_update", message: "system will be back in a minute" };
  }
  return { code: "shutting_down", message: "Service is shutting down" };
}

/**
 * The typed abort reason a draining process hands to in-flight request
 * controllers. It is a `GatewayError` rather than a bare `AbortError` so every
 * consumer can tell a drain apart from a client disconnect: the streaming path
 * uses the code to decide whether to emit a terminal frame (a drain owes the
 * client one; a gone client does not), and the attempt loop surfaces it as a
 * 503 instead of an opaque abort. Both codes are non-retryable in practice —
 * the request is already aborted — and carry 503 so a client that retries
 * lands on the replacement.
 */
export function shutdownError(reason: string | undefined): GatewayError {
  const notice = shutdownNotice(reason);
  return new GatewayError(notice.code, 503, notice.message);
}

/**
 * The shutdown `GatewayError` carried by an aborted controller, or `undefined`
 * when the abort is something else (client disconnect, deadline, stall).
 *
 * A drain abort is a `GatewayError` with a shutdown code — never a bare
 * `AbortError` (see `state.ts` `abortAll`) — so a consumer can tell "the client
 * is gone" (release silently, a frame would go nowhere) from "we are
 * restarting" (the client is still reading and is owed a terminal frame). Both
 * the streaming dispatch path and the non-streaming attempt loop read this.
 */
export function drainAbortReason(reason: unknown): GatewayError | undefined {
  if (!(reason instanceof GatewayError)) return undefined;
  return reason.code === "shutting_down" || reason.code === "restart_for_update"
    ? reason
    : undefined;
}
