/**
 * Claude Messages HTTP executor: sends a built Messages request and yields
 * canonical events from the response. Shared by `ClaudeAdapter` ([CC] CLI
 * impersonation) and `AnthropicApiKeyAdapter` (plain API-key traffic) — pure
 * wire mechanics with no auth-mode branching.
 */
import type { CanonicalEvent, CanonicalRequest } from '../../transport/canonical-model';
import { GatewayError } from '../../transport/gateway-error';
import type { ProviderDispatchContext } from '../../providers/provider-registry';
import { withUpstreamDeadline } from '../../providers/operations/upstream-deadline';
import { mapClaudeHttpError } from '../../protocol/messages-errors';
import { isRecord } from '../primitives';
import { parseClaudeSseStream, claudeResponseToEvents } from '../response/messages';

export async function* sendClaudeMessagesRequest(
  url: string,
  headers: Record<string, string>,
  outboundBody: string,
  context: ProviderDispatchContext,
  request: CanonicalRequest,
  fetchFn: typeof fetch,
  isOAuth = false,
): AsyncIterable<CanonicalEvent> {
  const outboundFetch = context.outbound_fetch ?? fetchFn;
  const response = await withUpstreamDeadline(context, (signal) =>
    outboundFetch(url, {
      method: "POST",
      headers,
      body: outboundBody,
      signal,
    }),
  );
  // HTTP status first: a failed status with a JSON body must map through
  // the normal upstream error mapper even when the request asked for a
  // stream. Only `2xx` responses enter SSE parsing below.
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw mapClaudeHttpError(response.status, body, response.headers);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.toLowerCase().includes("text/event-stream") ||
    request.stream
  ) {
    if (response.body === null)
      throw new GatewayError(
        "platform_unavailable",
        502,
        "Claude response has no stream body",
        {},
        "upstream",
      );
    yield* parseClaudeSseStream(response.body, context.abort_signal, isOAuth);
    return;
  }
  const body = await response.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw new GatewayError(
      "platform_unavailable",
      502,
      "Claude response is not valid JSON",
      {},
      "upstream",
    );
  }
  if (!isRecord(json)) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      "Claude response must be an object",
      {},
      "upstream",
    );
  }
  yield* claudeResponseToEvents(json, request, isOAuth);
}
