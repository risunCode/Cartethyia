import { GatewayError } from "../../transport/gateway-error";
import type { ProviderDispatchContext } from "../provider-registry";

export interface UpstreamDeadlineLifecycle {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

export function createUpstreamDeadlineLifecycle(
  context: ProviderDispatchContext,
): UpstreamDeadlineLifecycle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(context.abort_signal.reason);
  const timeoutId = setTimeout(
    () =>
      controller.abort(
        new GatewayError(
          "deadline_exceeded",
          504,
          "upstream request deadline exceeded",
          {},
          "upstream",
        ),
      ),
    Math.max(0, context.deadline - Date.now()),
  );
  context.abort_signal.addEventListener("abort", onAbort, { once: true });
  if (context.abort_signal.aborted) controller.abort(context.abort_signal.reason);

  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) return;
      released = true;
      clearTimeout(timeoutId);
      context.abort_signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Converts a lifecycle abort into the public gateway error owned by its cause.
 * The private upstream deadline is a provider-side 504; only an inbound client
 * abort is a 499. Existing typed shutdown/deadline reasons remain authoritative.
 */
export function abortGatewayError(
  lifecycle: UpstreamDeadlineLifecycle,
  error: unknown,
  requestSignal?: AbortSignal,
): GatewayError | undefined {
  const reason = lifecycle.signal.reason ?? requestSignal?.reason;
  if (reason instanceof GatewayError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError")
    return new GatewayError("deadline_exceeded", 504, "request deadline exceeded", {}, "cartethyia");
  const abortLike =
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
  if (lifecycle.signal.aborted || requestSignal?.aborted || abortLike)
    return new GatewayError("transport_closed", 499, "request was cancelled");
  return undefined;
}

export async function withUpstreamDeadline<T>(
  context: ProviderDispatchContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    return await fn(lifecycle.signal);
  } catch (error: unknown) {
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw error;
  } finally {
    lifecycle.release();
  }
}
