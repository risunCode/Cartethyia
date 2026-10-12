// Shared template-method lifecycle for HTTP-backed provider adapters:
// header/payload preparation, upstream transport, deadline lifecycle, and
// stream transformation. Concrete adapters override the four hooks.

import type { CanonicalEvent, CanonicalRequest } from "../protocol/canonical-model";
import { GatewayError } from "../protocol/gateway-error";
import {
  abortGatewayError,
  createUpstreamDeadlineLifecycle,
} from "./operations/upstream-deadline";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
} from "./contracts";

/** Shared template-method lifecycle for HTTP-backed provider adapters. */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly provider_id: ProviderId;

  async *dispatch(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (request.model.includes("?")) {
      throw new GatewayError("invalid_request", 400, "model must not contain query string");
    }
    const headers = await this.prepareHeaders(context, request, target);
    const payload = await this.preparePayload(request, target, context);
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const transportContext: ProviderDispatchContext = { ...context, abort_signal: lifecycle.signal };
    try {
      const response = await this.executeTransport(headers, payload, transportContext, request, target);
      // The HTTP headers establish the upstream stream. The original
      // pre-stream deadline must not kill a healthy long response body; the
      // outer request watchdog now owns inter-event stall detection.
      lifecycle.release();
      // Body reads must watch the *request* abort signal. transportContext
      // still carries the released lifecycle signal, which is no longer
      // bridged to state.abortController — stall/deadline aborts would
      // otherwise never cancel the upstream reader.
      yield* this.transformStream(response, request, target, {
        ...transportContext,
        abort_signal: context.abort_signal,
      });
    } catch (error) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      if (abortError) throw abortError;
      throw error;
    } finally {
      lifecycle.release();
    }
  }

  protected abstract prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
  ): Promise<Record<string, string>>;
  protected abstract preparePayload(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<unknown>;
  protected abstract executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    target?: ProviderDispatchTarget,
  ): Promise<Response>;
  protected abstract transformStream(
    response: Response,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
}
