/**
 * Cloudflare AI Gateway login.
 *
 * Not an OAuth grant: Cloudflare issues a gateway token from the dashboard, and
 * reaching a specific gateway additionally needs the account id and the gateway
 * slug, which are path segments of the base URL
 * (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`). None
 * of the three can be derived from the others, so the credential is stored as a
 * three-field envelope rather than a bare bearer.
 *
 * The console already renders a form from `importFields` and persists whatever
 * `importCredential` returns, so declaring the fields is what makes this a
 * first-class login rather than a paste-a-key flow the operator has to
 * understand.
 *
 * There is no refresh grant: the token is durable, so the stored value is used
 * exactly as issued. For the same reason the exchange result mirrors `access`
 * into the `refresh` slot — `refresh_ciphertext` is NOT NULL, and the value is
 * never sent to a token endpoint.
 */
import type {
  OAuthExchangeResult,
  OAuthImportInput,
  OAuthLoginClient,
  OAuthLoginField,
} from "../../authentication/oauth-flow-store";
import { readJsonResponse } from "../../authentication/oauth-flow-store";
import type { FetchLike } from "../../authentication/oauth-client";
import {
  encodeCloudflareAiGatewayCredential,
  type CloudflareAiGatewayEnvelope,
} from "../../../security/credential-codec";

/** Only the token is secret; the two ids are identifiers the operator can see. */
export const CLOUDFLARE_AI_GATEWAY_IMPORT_FIELDS: readonly OAuthLoginField[] = [
  {
    key: "accountId",
    label: "Cloudflare account ID",
    placeholder: "0123456789abcdef0123456789abcdef",
    required: true,
  },
  {
    key: "gatewayId",
    label: "Gateway slug",
    placeholder: "my-gateway",
    required: true,
  },
];

async function validateToken(
  envelope: CloudflareAiGatewayEnvelope,
  fetchFn: FetchLike,
): Promise<void> {
  // `/v1/models` on the gateway itself is the check: it proves the token and
  // both ids, and it costs no tokens. A single wrong field fails here rather
  // than on the operator's first real request.
  const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(envelope.accountId)}/${encodeURIComponent(envelope.gatewayId)}/anthropic/v1/models`;
  const response = await fetchFn(url, {
    headers: {
      accept: "application/json",
      "cf-aig-authorization": `Bearer ${envelope.token}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Cloudflare AI Gateway rejected the token or the account/gateway ids");
  }
  // Read the body for its shape: a 200 with an HTML body is an edge page that
  // answered before the gateway, which is a different fix than a bad key.
  await readJsonResponse(response, "Cloudflare AI Gateway model list");
}

/** Cloudflare AI Gateway login: a durable token plus its two path segments. */
export class CloudflareaiOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = false;
  readonly importFields = CLOUDFLARE_AI_GATEWAY_IMPORT_FIELDS;

  constructor(private readonly fetchFn: FetchLike = globalThis.fetch) {}

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const envelope: CloudflareAiGatewayEnvelope = {
      token: input.credential.trim(),
      accountId: (input.fields["accountId"] ?? "").trim(),
      gatewayId: (input.fields["gatewayId"] ?? "").trim(),
    };
    if (!envelope.token) throw new Error("Paste a Cloudflare AI Gateway token");
    if (!envelope.accountId) throw new Error("Cloudflare account ID is required");
    if (!envelope.gatewayId) throw new Error("Cloudflare gateway slug is required");
    await validateToken(envelope, this.fetchFn);
    const access = encodeCloudflareAiGatewayCredential(envelope);
    return {
      access,
      // No refresh grant. Mirrored because `refresh_ciphertext` is NOT NULL and
      // the value is never presented to a token endpoint.
      refresh: access,
      // Cloudflare publishes no expiry for a gateway token, so this is a
      // far-future value that keeps the freshness check from scheduling a
      // refresh nothing can perform — the same shape Kilo Code uses.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      ...(input.accountLabel === undefined || input.accountLabel.trim() === ""
        ? {}
        : { accountLabel: input.accountLabel.trim() }),
    };
  }
}

export const cloudflareaiOAuthClient = new CloudflareaiOAuthClient();