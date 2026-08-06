import type { AuthContext, AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions } from "./base";

const KIMCHI_WEB_URL = "https://app.kimchi.dev";
const KIMCHI_VALIDATION_URL = "https://api.cast.ai/v1/llm/openai/supported-providers";
const KIMCHI_CALLBACK_PORT = 1457;
const KIMCHI_CALLBACK_PATH = "/callback";
const KIMCHI_CALLBACK_URL = `http://127.0.0.1:${KIMCHI_CALLBACK_PORT}${KIMCHI_CALLBACK_PATH}`;

function tokenFromInput(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const token = url.searchParams.get("token") ?? url.searchParams.get("access_token");
    if (token) return token.trim().replace(/[\x00-\x1f\x7f]/g, "");
  } catch {
    // The console also accepts a token pasted directly.
  }
  return trimmed.replace(/[\x00-\x1f\x7f]/g, "");
}

function tokenFromCredential(credential: string): string {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const access = (parsed as Record<string, unknown>).accessToken;
      if (typeof access === "string") return access;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

/** Kimchi browser-token OAuth flow; access tokens are validated and non-refreshable. */
export class KimchiOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const callback = input.redirectUri ?? KIMCHI_CALLBACK_URL;
    const state = input.state ?? crypto.randomUUID();
    const params = new URLSearchParams({ callback, state });
    return { authorizationUrl: `${KIMCHI_WEB_URL}/cli-auth?${params.toString()}`, state, expiresAtMs: this.nowMs() + 300_000 };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    // parseOAuthCallbackValue extracts Kimchi's `?token=` param as `code`.
    const token = tokenFromInput(input.code);
    if (token.length === 0) throw new OAuthDriverError("validation", "Kimchi OAuth callback did not contain a token.", 400, false);
    const response = await this.http.tryGet(KIMCHI_VALIDATION_URL, { accept: "application/json", authorization: `Bearer ${token}` }, "kimchi", "token validation");
    if (!response.ok) throw new OAuthDriverError("authorization_denied", "Kimchi OAuth token was rejected.", response.status, false);
    return { accessToken: token, expiresAt: new Date(this.nowMs() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  }

  buildHeaders(input: AuthContext): Record<string, string> {
    const token = tokenFromCredential(input.credential);
    return token.length > 0 ? { authorization: `Bearer ${token}` } : {};
  }

  // Kimchi browser tokens are intentionally non-refreshable.
  refresh(_input: RefreshTokenInput): Promise<TokenSet> {
    return Promise.reject(new OAuthDriverError("validation", "Kimchi OAuth tokens do not support refresh.", 400, false));
  }
}
