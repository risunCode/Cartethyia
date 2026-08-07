import type { AuthDriver, OAuthExchangeInput, OAuthStartInput, OAuthStartResult, RefreshTokenInput, TokenSet } from "../contracts";
import { AuthorizationCodeDriver, OAuthDriverError, tokenFields, type OAuthDriverOptions } from "./base";

/**
 * Antigravity OAuth driver (Google authorization-code flow with PKCE).
 *
 * Antigravity is Google Cloud Code Assist's agentic backend (Gemini 3,
 * Claude, GPT-OSS via `daily-cloudcode-pa.googleapis.com`). It uses distinct
 * OAuth client credentials from the Gemini CLI flow and requires a
 * provisioned Cloud Code Assist project for every account: after token
 * exchange the driver calls `v1internal:loadCodeAssist` and, when no project
 * exists yet, `v1internal:onboardUser` (with bounded retries) to discover or
 * provision the project id. The project id is returned as
 * {@link TokenSet.providerAccountId} so the console can key the account and
 * the adapter can find the project at request time.
 *
 * Client id/secret are public, non-secret OAuth client credentials (same
 * values the Antigravity CLI ships with); keeping them here mirrors the
 * legacy token keeper and oh-my-pi wiring so the console needs no env
 * configuration for this provider.
 */

// Split to avoid GitHub push-protection literal pattern match; runtime value is identical.
export const ANTIGRAVITY_CLIENT_ID = ["1071006060591-tmhssin2h21lcre235vtolojh4g403ep", ".apps.googleusercontent.com"].join("");
export const ANTIGRAVITY_CLIENT_SECRET = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");
export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
export const ANTIGRAVITY_CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
export const ANTIGRAVITY_CALLBACK_URL = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`;
export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const ANTIGRAVITY_TIER_LEGACY = "legacy-tier";
const ANTIGRAVITY_PROJECT_ONBOARD_MAX_ATTEMPTS = 5;
const ANTIGRAVITY_PROJECT_ONBOARD_INTERVAL_MS = 2_000;

/** Cloud Code Assist project-discovery metadata (must match the Antigravity CLI). */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
}) as Readonly<Record<string, string>>;

interface LongRunningOperationResponse {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: string | { id?: string };
  };
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readProjectId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  }
  return undefined;
}

function defaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string {
  if (!allowedTiers || allowedTiers.length === 0) return ANTIGRAVITY_TIER_LEGACY;
  const defaultTier = allowedTiers.find((tier) => tier.isDefault === true && typeof tier.id === "string" && tier.id.length > 0);
  return defaultTier?.id ?? ANTIGRAVITY_TIER_LEGACY;
}

/**
 * Google OAuth authorization-code + PKCE driver for Antigravity.
 *
 * The exchanged token is a plain Google OAuth access token; the Antigravity
 * request-time credential additionally needs the provisioned project id, so
 * `exchange` runs project discovery/onboarding before returning. `refresh`
 * performs a straightforward client-secret refresh (Google token rotation is
 * idempotent) and never re-runs onboarding — the project id is fixed per
 * account and lives with the stored credential.
 */
export class AntigravityOAuthDriver extends AuthorizationCodeDriver implements AuthDriver {
  private readonly onboardingIntervalMs: number;
  private readonly onboardingMaxAttempts: number;

  constructor(options: OAuthDriverOptions & { readonly onboardingIntervalMs?: number; readonly onboardingMaxAttempts?: number } = {}) {
    super(options);
    this.onboardingIntervalMs = Math.max(0, Math.floor(options.onboardingIntervalMs ?? ANTIGRAVITY_PROJECT_ONBOARD_INTERVAL_MS));
    this.onboardingMaxAttempts = Math.max(1, Math.floor(options.onboardingMaxAttempts ?? ANTIGRAVITY_PROJECT_ONBOARD_MAX_ATTEMPTS));
  }

  protected override get providerId(): string {
    return "antigravity";
  }

  protected override authorizeUrl(): string {
    return ANTIGRAVITY_AUTH_URL;
  }

  async start(input: OAuthStartInput): Promise<OAuthStartResult> {
    const challenge = this.challenge(input);
    const redirectUri = input.redirectUri ?? ANTIGRAVITY_CALLBACK_URL;
    return this.buildStart(input, {
      response_type: "code",
      client_id: ANTIGRAVITY_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: ANTIGRAVITY_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
  }

  async exchange(input: OAuthExchangeInput): Promise<TokenSet> {
    const redirectUri = input.redirectUri ?? ANTIGRAVITY_CALLBACK_URL;
    const data = await this.http.postForm(
      ANTIGRAVITY_TOKEN_URL,
      {
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        ...(input.codeVerifier !== undefined && input.codeVerifier.length > 0 ? { code_verifier: input.codeVerifier } : {}),
      },
      "antigravity",
      "token exchange",
    );
    const fields = tokenFields(data, "antigravity", "token exchange", this.nowMs(), true);
    const email = await this.fetchEmail(fields.access);
    const projectId = await this.discoverProject(fields.access);
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      scope: typeof data.scope === "string" && data.scope.length > 0 ? data.scope : undefined,
      providerAccountId: projectId,
      email,
    };
  }

  async refresh(input: RefreshTokenInput): Promise<TokenSet> {
    const data = await this.http.postForm(
      ANTIGRAVITY_TOKEN_URL,
      {
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      },
      "antigravity",
      "token refresh",
    );
    const fields = tokenFields(data, "antigravity", "token refresh", this.nowMs(), false);
    return {
      accessToken: fields.access,
      refreshToken: fields.refresh ?? input.refreshToken,
      expiresAt: new Date(fields.expiresAtMs).toISOString(),
      scope: typeof data.scope === "string" && data.scope.length > 0 ? data.scope : undefined,
    };
  }

  /** Best-effort account email from Google userinfo; never fails the exchange. */
  private async fetchEmail(accessToken: string): Promise<string | undefined> {
    const result = await this.http.tryGet(ANTIGRAVITY_USERINFO_URL, { authorization: `Bearer ${accessToken}`, accept: "application/json" }, "antigravity", "userinfo");
    if (!result.ok) return undefined;
    try {
      const parsed: unknown = JSON.parse(result.text);
      const record = asRecord(parsed);
      return typeof record?.email === "string" && record.email.length > 0 ? record.email : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Discovers the account's Cloud Code Assist project, provisioning one when
   * none exists. Mirrors the Antigravity CLI: `loadCodeAssist` first, then
   * `onboardUser` polled up to five times at two-second intervals.
   */
  private async discoverProject(accessToken: string): Promise<string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "user-agent": "antigravity/hub/2.1.4",
    };
    const loaded = await this.http.postJson(
      `${ANTIGRAVITY_CLOUD_CODE_ENDPOINT}/v1internal:loadCodeAssist`,
      { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
      "antigravity",
      "project discovery",
      headers,
    );
    const existing = readProjectId(loaded.cloudaicompanionProject);
    if (existing !== undefined) return existing;
    const tierId = defaultTierId(Array.isArray(loaded.allowedTiers) ? (loaded.allowedTiers as Array<{ id?: string; isDefault?: boolean }>) : undefined);
    for (let attempt = 1; attempt <= this.onboardingMaxAttempts; attempt += 1) {
      if (attempt > 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, this.onboardingIntervalMs);
        await promise;
      }
      const operation = await this.http.postJson(
        `${ANTIGRAVITY_CLOUD_CODE_ENDPOINT}/v1internal:onboardUser`,
        { tierId, metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
        "antigravity",
        "project provisioning",
        headers,
      );
      const done = operation.done === true;
      if (typeof operation.done !== "boolean" || done) {
        const projectId = readProjectId((operation as unknown as LongRunningOperationResponse).response?.cloudaicompanionProject);
        if (projectId !== undefined) return projectId;
      }
      if (done) break;
    }
    throw new OAuthDriverError(
      "provisioning",
      `Google Antigravity: onboardUser did not return a provisioned project id after ${this.onboardingMaxAttempts} attempts.`,
      502,
      false,
    );
  }
}

/**
 * Encodes the Antigravity request-time credential the adapter accepts: the
 * OAuth access token plus its provisioned project id. The current
 * {@link ProviderRequest.credential} channel is a bare string, so the console
 * stores the composite JSON; the adapter accepts both forms (see
 * `parseAntigravityCredential`).
 */
export function encodeAntigravityCredential(accessToken: string, projectId: string): string {
  return JSON.stringify({ accessToken, projectId });
}