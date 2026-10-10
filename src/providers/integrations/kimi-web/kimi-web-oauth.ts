import type { OAuthExchangeResult, OAuthImportInput, OAuthLoginClient, OAuthLoginField } from "../../authentication/oauth-flow-store";
import { encodeKimiWebCredential, parseKimiWebCredential } from "./kimi-web-auth";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Paste-only login client for a Kimi web session. */
export class KimiWebOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = false;
  readonly importFields: readonly OAuthLoginField[] = [{
    key: "credential",
    label: "Kimi web token",
    placeholder: "Paste the access_token, localStorage JSON, or kimi-auth cookie",
    secret: true,
    required: true,
  }];

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const encoded = encodeKimiWebCredential(parseKimiWebCredential(input.credential));
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS), accountLabel: input.accountLabel ?? "Kimi Web" };
  }
}

export const kimiWebOAuthClient = new KimiWebOAuthClient();
