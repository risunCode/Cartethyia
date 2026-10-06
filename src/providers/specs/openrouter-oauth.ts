/**
 * OpenRouter OAuth client.
 *
 * OpenRouter runs a deliberately minimal PKCE flow: there is no client
 * registration, so the S256 verifier is the only proof of identity, and the
 * authorize request names its callback `callback_url` rather than the standard
 * `redirect_uri`. The exchange then returns a durable API key — not a
 * short-lived access token — which is why this client declares no refresh
 * grant and the gateway stores the result as an ordinary credential.
 *
 * Two upstream behaviours shape the console integration rather than this file:
 * OpenRouter never echoes `state` back on the callback, so the pending flow is
 * correlated by provider; and it answers a signed-out visitor with a redirect
 * to `/sign-up` that preserves the query string, so the flow survives a login
 * that happens after the authorize URL was opened.
 */
import { nonEmptyTrimmedString, readJsonResponse, record } from "../authentication/oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthExchangeResult,
} from "../authentication/oauth-flow-store";
import { OAuthClient } from "../authentication/oauth-client";

export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth" as const;
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys" as const;

/**
 * Loopback callback this client uses.
 *
 * OpenRouter does not pre-register redirect URIs — the callback is supplied per
 * request and echoed back — so the port is free. It is still stated here rather
 * than left to the gateway default so the value is stable across the authorize
 * and exchange steps, which the token endpoint compares.
 */
export const OPENROUTER_REDIRECT_URI = "http://127.0.0.1:54549/callback" as const;

export class OpenrouterOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  override readonly browserRedirectUri = OPENROUTER_REDIRECT_URI;

  protected override readonly providerLabel = "OpenRouter";
  // No client registration exists for this flow; the field stays empty rather
  // than inventing an id the authorize server does not know.
  protected override readonly clientId = "";
  protected override readonly tokenUrl = OPENROUTER_KEY_EXCHANGE_URL;
  protected override readonly scopes = "";

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // Non-standard shape, sent verbatim: `callback_url` instead of
    // `redirect_uri`, no `client_id`, no `response_type`, no `scope`. OpenRouter
    // rejects a request carrying the standard names it does not expect.
    const params = new URLSearchParams({
      callback_url: request.redirectUri,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${OPENROUTER_AUTHORIZE_URL}?${params.toString()}`;
  }

  override async exchangeCode(
    code: string,
    codeVerifier: string,
    _redirectUri: string,
    _state?: string,
  ): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await readJsonResponse(response, "OpenRouter key exchange");
    const key = nonEmptyTrimmedString(record(payload)?.key);
    if (key === undefined) {
      throw new Error("OpenRouter key exchange returned no key");
    }
    return {
      access: key,
      // No refresh grant: the returned key is durable. The access value is
      // mirrored here only because `refresh_ciphertext` is NOT NULL and the
      // identity fingerprint keys a repeated login on the label first; no
      // refresher is registered for this provider.
      refresh: key,
      // OpenRouter publishes no expiry for the key. A far-future value keeps the
      // freshness check from scheduling a refresh that cannot happen.
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }
}

export const openrouterOAuthClient = new OpenrouterOAuthClient();
