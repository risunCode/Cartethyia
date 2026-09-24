/**
 * Devin browser PKCE OAuth client.
 *
 * Flow from `provider implementation/packages/catalog/src/compat/rules/auth/devin.kdl`:
 * authorize `https://app.devin.ai/auth/cli/continue` (PKCE S256, `prompt=select_account`)
 * → console callback → token `POST https://api.devin.ai/auth/cli/token`
 * with JSON `{ code, code_verifier }` → `{ token }`.
 *
 * The Devin authorize page only completes inside a real user browser session
 * (it requires an interactive login before issuing a code). Opening the
 * authorize URL with curl/fetch returns the SPA shell with no error and no
 * code — that is expected, not a broken redirect. If the browser page itself
 * rejects the request it renders `Invalid authorize request`; that verdict
 * comes from Devin's server-side client/redirect validation, not from the
 * query parameters Cartethyia builds (response_type/code_challenge/
 * code_challenge_method/state/redirect_uri/prompt all match the catalog
 * contract). Registered redirect URIs are allowlisted per OAuth client on
 * Devin's side, so a self-hosted `http://127.0.0.1`/`http://localhost`
 * callback is rejected there — use the device-code path or a public
 * `CARTETHYIA_PUBLIC_ORIGIN` the Devin application trusts.
 *
 * Access and refresh are the same JWT; expiry comes from the JWT `exp` claim
 * with a 365-day fallback. There is no refresh grant (`refresh "none"`), so
 * this client intentionally declares no `refresher` capability.
 */
import { decodeJwtPayload, readJsonResponse, record } from "../../authentication/oauth-flow-store";
import { sanitizeUpstreamLabel } from "../../provider-metadata";
import type {
  OAuthAuthorizeRequest,
  OAuthExchangeResult,
} from "../../authentication/oauth-flow-store";
import { OAuthClient } from "../../authentication/oauth-client";

export const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue" as const;
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token" as const;
const DEVIN_JWT_FALLBACK_MS = 31_536_000_000;

/** JWT `exp` claim; falls back to 365 days for opaque tokens. */
export function expiryFromDevinJwt(token: string): Date {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    const date = new Date(exp * 1000);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(Date.now() + DEVIN_JWT_FALLBACK_MS);
}

/** Devin exposes its account identity through these claims, in priority order. */
function accountLabelFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  for (const key of ["email", "sub", "user_id", "org_id", "name"]) {
    const value = sanitizeUpstreamLabel(payload[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractToken(payload: unknown): string | undefined {
  const root = record(payload);
  if (!root) return undefined;
  for (const key of ["token", "access_token", "accessToken", "jwt", "id_token"]) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = record(root.data);
  if (nested) {
    for (const key of ["token", "access_token", "accessToken", "jwt", "id_token"]) {
      const value = nested[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

export class DevinOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;

  protected override readonly providerLabel = "Devin";
  protected override readonly clientId = "";
  protected override readonly tokenUrl = DEVIN_TOKEN_URL;
  protected override readonly scopes = "";

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    const params = new URLSearchParams({
      response_type: "code",
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      state: request.state,
      redirect_uri: request.redirectUri,
      prompt: "select_account",
    });
    return `${DEVIN_AUTHORIZE_URL}?${params.toString()}`;
  }

  override async exchangeCode(code: string, codeVerifier: string): Promise<OAuthExchangeResult> {
    const response = await this.fetchFn(DEVIN_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
    const payload = await readJsonResponse(response, "Devin token exchange");
    const token = extractToken(payload);
    if (!token) {
      throw new Error("Devin token exchange returned no token (expected { token })");
    }
    const label = accountLabelFromJwt(token);
    return {
      access: token,
      refresh: token,
      expiresAt: expiryFromDevinJwt(token),
      ...(label ? { accountLabel: label } : {}),
    };
  }

  override async refresh(_refreshToken: string, _signal?: AbortSignal): Promise<never> {
    throw new Error("Devin does not support token refresh");
  }
}

export const devinOAuthClient = new DevinOAuthClient();
