import type { AuthDriver, AuthDriverCapabilities, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, TokenSet } from "../contracts";
import { nonEmpty, OAuthDriverError, OAuthHttpClient, type OAuthDriverOptions } from "./base";

const KIMCHI_WEB_APP_URL = "https://app.kimchi.dev";
const KIMCHI_VALIDATION_URL = "https://api.cast.ai/v1/llm/openai/supported-providers";
const KIMCHI_CALLBACK_URL = "http://127.0.0.1:1457/callback";
const KIMCHI_DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Kimchi's CLI login is a browser token callback, not Kimi's device-code
 * protocol. The browser app redirects directly to the local callback with
 * `token` and `state` query parameters; no token exchange endpoint exists.
 */
export class KimchiOAuthDriver implements AuthDriver {
  readonly kind = "oauth" as const;
  readonly capabilities: AuthDriverCapabilities = {
    supportsStart: true,
    supportsPoll: false,
    supportsExchange: true,
    supportsRefresh: false,
    supportsRevoke: false,
    accessOnly: true,
    supportsBrowser: true,
    supportsDevice: false,
  };
  private readonly http: OAuthHttpClient;
  private readonly nowMs: () => number;

  constructor(options: OAuthDriverOptions = {}) {
    this.http = new OAuthHttpClient(options);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const state = input.state && input.state.length > 0 ? input.state : crypto.randomUUID();
    const callbackUrl = input.redirectUri ?? KIMCHI_CALLBACK_URL;
    const params = new URLSearchParams({ callback: callbackUrl, state });
    return {
      authorizationUrl: `${KIMCHI_WEB_APP_URL}/cli-auth?${params.toString()}`,
      state,
      expiresAtMs: this.nowMs() + KIMCHI_DEFAULT_TTL_MS,
      flow: "browser",
    };
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const token = nonEmpty(input.code);
    if (token === undefined) {
      throw new OAuthDriverError("validation", "Kimchi callback did not return an access token.", 400, false);
    }
    await this.validateToken(token);
    return { accessToken: token };
  }

  private async validateToken(token: string): Promise<void> {
    const result = await this.http.tryGet(
      KIMCHI_VALIDATION_URL,
      { Authorization: `Bearer ${token}`, Accept: "application/json" },
      "kimchi",
      "token validation",
    );
    if (result.status === 401) throw new OAuthDriverError("authentication", "Kimchi token is invalid or expired.", 401, false);
    if (result.status === 403) throw new OAuthDriverError("authorization", "Kimchi token lacks the required scope.", 403, false);
    // Match the reference client: transient validation failures do not block
    // a browser login when Kimchi's validation service is unavailable.
  }
}
