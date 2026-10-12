/**
 * Cloudflare AI Gateway adapter.
 *
 * A gateway, not a model host: every upstream lives behind one Cloudflare-owned
 * base URL whose path carries the account and gateway slugs
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>`). Those
 * two slugs are per-account state stored with the token, so the base URL is
 * resolved from the credential at dispatch time rather than declared in metadata.
 *
 * Two further facts keep this out of the declarative spec shape:
 *
 * 1. **The auth header is Cloudflare's own.** `cf-aig-authorization`, not
 *    `Authorization` and not `x-api-key` — a bearer under either conventional
 *    name is ignored, so a gateway token reaches the wrong place silently.
 * 2. **The wire is Anthropic Messages.** Cloudflare proxies the Anthropic
 *    protocol at the `/anthropic` path suffix, including `thinking_delta`
 *    blocks, so the Messages leg is built directly.
 */
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../contracts";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { buildClaudeMessagesRequest, filterClaudeCustomHeaders } from "../shared/claude-messages";
import { sendClaudeMessagesRequest } from "../../../protocol/upstream/send-claude-messages";
import { applyParamQuirks } from "../../../transport/translation/quirks";
import { decodeCloudflareAiGatewayCredential } from "../../../security/credential-codec";

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway" as const;

/**
 * Gateway origin, with the per-account path segments left to the credential.
 *
 * The literal suffix a stored account without ids would produce is why
 * `cloudflareBaseUrl` throws instead of returning this — it exists only as the
 * parse-failure message's subject and as the documented origin.
 */
export const CLOUDFLARE_AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";

/**
 * Base URL for one account's gateway.
 *
 * Path segments are encoded: they arrive from a pasted dashboard value and
 * reach the upstream inside a URL, so an unencoded value is a request to a host
 * the operator did not name.
 */
export function cloudflareBaseUrl(accountId: string, gatewayId: string): string {
  return `${CLOUDFLARE_AI_GATEWAY_ORIGIN}/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/anthropic`;
}

/** Decoded envelope, failing closed when the stored secret is not one. */
function cloudflareEnvelope(context: ProviderDispatchContext): {
  token: string;
  baseUrl: string;
} {
  const secret = context.credential.secret;
  if (secret === undefined || secret.length === 0) {
    throw new GatewayError("invalid_request", 400, "cloudflare-ai-gateway: credential is missing a secret value");
  }
  let envelope: ReturnType<typeof decodeCloudflareAiGatewayCredential>;
  try {
    envelope = decodeCloudflareAiGatewayCredential(secret);
  } catch (error) {
    throw new GatewayError(
      "invalid_request",
      400,
      `cloudflare-ai-gateway: ${error instanceof Error ? error.message : "stored credential is not a Cloudflare envelope"}`,
    );
  }
  return { token: envelope.token, baseUrl: cloudflareBaseUrl(envelope.accountId, envelope.gatewayId) };
}

/**
 * Cloudflare AI Gateway dispatch on the Anthropic Messages wire.
 *
 * `messages` is the only family this provider serves: Cloudflare's Anthropic
 * path is the one the gateway publishes, and a chat-family request translated
 * onto it would be accepted and then mis-routed upstream.
 */
class CloudflareAiGatewayAdapter implements ProviderAdapter {
  readonly provider_id = CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchFn = fetchImpl ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `cloudflare-ai-gateway supports messages only, got ${candidate.wire_family}`,
      );
    }
    const { token, baseUrl } = cloudflareEnvelope(context);
    const outbound = buildClaudeMessagesRequest({
      request: applyParamQuirks(request, candidate.provider_id),
      // The bearer is built by hand below under Cloudflare's header name; this
      // shape keeps the shared builder's `anthropic-version` and payload rules.
      authHeader: "bearer",
      credential: {
        secret: token,
        customHeaders: {
          ...filterClaudeCustomHeaders({ ...context.credential.custom_headers }),
        },
      },
      baseUrl,
      endpointPath: candidate.endpoint_path,
    });
    // The gateway reads this header, not `authorization`, which the shared
    // builder set. Removing it keeps a header the gateway ignores from looking
    // like a credential that was tried and rejected.
    delete outbound.headers.authorization;
    outbound.headers["cf-aig-authorization"] = `Bearer ${token}`;
    yield* sendClaudeMessagesRequest(
      outbound.url,
      outbound.headers,
      outbound.body,
      context,
      request,
      this.fetchFn,
    );
  }
}

export function createCloudflareAiGatewayAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new CloudflareAiGatewayAdapter(fetchImpl);
}

export const cloudflareAiGatewayAdapter: ProviderAdapter = new CloudflareAiGatewayAdapter();