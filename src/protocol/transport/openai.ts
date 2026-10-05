/**
 * Shared upstream JSON executor for [OpenAI]-compatible adapters: POSTs a payload
 * with deadline/abort wiring and returns the response plus a release hook.
 */
import type { ProviderDispatchContext, ValidatedOutboundFetch } from "../../providers/provider-registry";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../providers/operations/upstream-deadline";

export async function postUpstreamJson(
  fetchUrl: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  context: ProviderDispatchContext,
  outboundFetch: ValidatedOutboundFetch,
): Promise<{ res: Response; signal: AbortSignal; release: () => void }> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    const res = await outboundFetch(fetchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: lifecycle.signal,
    });
    return {
      res,
      signal: lifecycle.signal,
      release: lifecycle.release,
    };
  } catch (error: unknown) {
    lifecycle.release();
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw error;
  }
}
