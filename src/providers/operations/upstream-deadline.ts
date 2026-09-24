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
    () => controller.abort(new Error("upstream_deadline_exceeded")),
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

export async function withUpstreamDeadline<T>(
  context: ProviderDispatchContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    return await fn(lifecycle.signal);
  } catch (error: unknown) {
    if (lifecycle.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    }
    throw error;
  } finally {
    lifecycle.release();
  }
}
