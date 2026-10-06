/**
 * Z.AI Coding Plan (ZCode) OAuth client.
 *
 * The sign-in flow is two-stage, because the OAuth access token is not what
 * the coding-plan API accepts:
 *
 *  1. Authorize on `chat.z.ai` (no PKCE — the client is not a public PKCE
 *     client) and exchange the code at `zcode.z.ai` for a short-lived access
 *     token.
 *  2. Exchange that token for a durable API key through Z.AI's business APIs:
 *     business login → resolve the default organization/project → find or
 *     create the gateway's own named key → read its secret. The credential the
 *     gateway stores and forwards is the resulting `<apiKey>.<secretKey>`.
 *
 * Stage 2 is what makes this provider usable at all: the coding-plan endpoint
 * authenticates the durable key, and the OAuth token is not a substitute. The
 * key is named after this gateway so signing in never overwrites a key another
 * Z.AI client owns.
 *
 * The redirect URI is Z.AI's own `zcode://` desktop scheme. Their server-side
 * allowlist rejects every loopback URI for this client, so the operator pastes
 * the final redirect URL instead of the gateway receiving a callback — the
 * flow is `manual-only` upstream for the same reason.
 */
import {
  nonEmptyTrimmedString,
  readJsonResponse,
  record,
} from "../authentication/oauth-flow-store";
import type {
  OAuthAuthorizeRequest,
  OAuthExchangeResult,
} from "../authentication/oauth-flow-store";
import { OAuthClient } from "../authentication/oauth-client";
import type { FetchLike } from "../authentication/oauth-client";
import { GatewayError } from "../../protocol/gateway-error";

export const ZCODE_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize" as const;
export const ZCODE_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token" as const;
export const ZCODE_REDIRECT_URI = "zcode://zai-auth/callback" as const;
/** Public client id ZCode ships; not a secret. */
export const ZCODE_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg" as const;

const ZAI_BIZ_BASE = "https://api.z.ai" as const;
const ZAI_BUSINESS_LOGIN_URL = `${ZAI_BIZ_BASE}/api/auth/z/login` as const;
const ZAI_CUSTOMER_INFO_URL = `${ZAI_BIZ_BASE}/api/biz/customer/getCustomerInfo` as const;
/**
 * Name of the key this gateway provisions. Fixed, not per-account: signing in
 * again reuses the key it created the first time instead of accumulating rows
 * in the operator's Z.AI account.
 */
const ZAI_KEY_NAME = "cartethyia" as const;

/**
 * Z.AI wraps its responses in `{ code, msg, data, success }`, with `code: 0`
 * from the OAuth token endpoint and `code: 200` from the business ones. The
 * status keys are checked only when present — some responses carry `data`
 * without them — and the `data` payload is unwrapped whenever it exists, since
 * a bare body is never what these endpoints return on success.
 */
function unwrapEnvelope(body: unknown, operation: string): unknown {
  const root = record(body);
  if (root === undefined) return body;
  if ("code" in root || "success" in root) {
    const code = root.code;
    const ok =
      code === undefined ||
      code === 0 ||
      code === 200 ||
      code === "0" ||
      code === "200";
    if (root.success === false || !ok) {
      const message = nonEmptyTrimmedString(root.msg) ?? `${operation} failed`;
      // `cartethyia` origin so the dialog shows the provider's own reason
      // instead of the generic "check the console log" fallback.
      throw new GatewayError("authentication_failed", 400, `Z.AI ${message}`, { providerId: "zcode" });
    }
  }
  return root.data ?? body;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetchFn: FetchLike,
  label: string,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return readJsonResponse(response, label);
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
  label: string,
): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  return readJsonResponse(response, label);
}

/** Exchanges the OAuth access token for a business-API token. */
async function businessLogin(oauthAccessToken: string, fetchFn: FetchLike): Promise<string> {
  const data = record(
    unwrapEnvelope(
      await postJson(ZAI_BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, fetchFn, "Z.AI business login"),
      "business login",
    ),
  );
  const bizToken =
    nonEmptyTrimmedString(data?.access_token) ?? nonEmptyTrimmedString(data?.accessToken);
  if (bizToken === undefined) {
    throw new Error("Z.AI business login returned no access token");
  }
  return bizToken;
}

/** Provisions (or reuses) this gateway's durable API key and returns `<apiKey>.<secretKey>`. */
async function mintZaiApiKey(oauthAccessToken: string, fetchFn: FetchLike): Promise<string> {
  const auth = { authorization: `Bearer ${await businessLogin(oauthAccessToken, fetchFn)}` };

  const customer = record(
    unwrapEnvelope(
      await getJson(ZAI_CUSTOMER_INFO_URL, auth, fetchFn, "Z.AI customer lookup"),
      "customer lookup",
    ),
  );
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];
  const org = organizations.map(record).find((entry) => entry?.isDefault === true) ?? record(organizations[0]);
  const projects = Array.isArray(org?.projects) ? org.projects : [];
  const project = projects.map(record).find((entry) => entry?.isDefault === true) ?? record(projects[0]);
  const organizationId = nonEmptyTrimmedString(org?.organizationId);
  const projectId = nonEmptyTrimmedString(project?.projectId);
  if (organizationId === undefined || projectId === undefined) {
    throw new Error("Z.AI key provisioning found no organization or project on the account");
  }

  const keysUrl = `${ZAI_BIZ_BASE}/api/biz/v1/organization/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/api_keys`;
  const listed = unwrapEnvelope(
    await getJson(keysUrl, auth, fetchFn, "Z.AI api key list"),
    "api key list",
  );
  const existing = (Array.isArray(listed) ? listed : [])
    .map(record)
    .find((entry) => entry?.name === ZAI_KEY_NAME);
  const created =
    existing ??
    record(
      unwrapEnvelope(
        await postJson(keysUrl, { name: ZAI_KEY_NAME }, auth, fetchFn, "Z.AI api key create"),
        "api key create",
      ),
    );
  const apiKey = nonEmptyTrimmedString(created?.apiKey);
  if (apiKey === undefined) {
    throw new Error("Z.AI key provisioning returned no apiKey");
  }

  // The secret always comes from the copy endpoint: list rows mask it and the
  // create response does not carry it reliably across account states.
  const copied = record(
    unwrapEnvelope(
      await getJson(
        `${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
        auth,
        fetchFn,
        "Z.AI api key copy",
      ),
      "api key copy",
    ),
  );
  const secretKey = nonEmptyTrimmedString(copied?.secretKey);
  if (secretKey === undefined) {
    throw new Error("Z.AI key provisioning returned no secretKey");
  }
  return `${apiKey}.${secretKey}`;
}

export class ZcodeOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = false;
  override readonly supportsBrowserCode = true;
  override readonly browserRedirectUri = ZCODE_REDIRECT_URI;

  protected override readonly providerLabel = "Z.AI Coding Plan";
  protected override readonly clientId = ZCODE_CLIENT_ID;
  protected override readonly tokenUrl = ZCODE_TOKEN_URL;
  protected override readonly scopes = "";

  override buildAuthorizeUrl(request: OAuthAuthorizeRequest): string {
    // No `code_challenge`: this client is not registered as a PKCE client and
    // Z.AI's authorize endpoint is matched verbatim against what ZCode sends.
    const params = new URLSearchParams({
      response_type: "code",
      client_id: ZCODE_CLIENT_ID,
      redirect_uri: request.redirectUri,
      state: request.state,
    });
    return `${ZCODE_AUTHORIZE_URL}?${params.toString()}`;
  }

  override async exchangeCode(
    code: string,
    _codeVerifier: string,
    redirectUri: string,
    state?: string,
  ): Promise<OAuthExchangeResult> {
    const payload = record(
      unwrapEnvelope(
        await postJson(
          ZCODE_TOKEN_URL,
          {
            provider: "zai",
            code,
            redirect_uri: redirectUri,
            state: state ?? "",
          },
          {},
          this.fetchFn,
          "Z.AI Coding Plan token exchange",
        ),
        "token exchange",
      ),
    );
    const zai = record(payload?.zai);
    const oauthAccess = nonEmptyTrimmedString(zai?.access_token);
    if (oauthAccess === undefined) {
      throw new Error("Z.AI Coding Plan token exchange returned no access token");
    }
    const user = record(payload?.user);
    const email =
      nonEmptyTrimmedString(user?.email) ?? nonEmptyTrimmedString(payload?.email);
    // The durable key replaces the OAuth token as the stored credential; the
    // account label is read from the exchange response before that replacement.
    const durableKey = await mintZaiApiKey(oauthAccess, this.fetchFn);
    return {
      access: durableKey,
      // The durable key does not expire and Z.AI publishes no refresh grant for
      // it (`refresh "none"` upstream). Mirrored into `refresh` only because
      // `refresh_ciphertext` is NOT NULL; no refresher is registered, so it is
      // never posted to a token endpoint.
      refresh: durableKey,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      ...(email === undefined ? {} : { accountLabel: email }),
    };
  }
}

export const zcodeOAuthClient = new ZcodeOAuthClient();
