import type { OAuthExchangeResult, OAuthImportInput, OAuthLoginClient, OAuthLoginField } from "../../authentication/oauth-flow-store";
import { encodeClaudeWebCredential, parseClaudeWebCredential } from "./claude-web-auth";
import { validateClaudeWebSession } from "./claude-web";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Paste-only login client for a Claude web session. */
export class ClaudeWebOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = false;
  readonly importFields: readonly OAuthLoginField[] = [{
    key: "credential",
    label: "Claude web cookie",
    placeholder: "Paste the extension cookie JSON, Cookie header, or sessionKey",
    secret: true,
    required: true,
  }];

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const encoded = encodeClaudeWebCredential(parseClaudeWebCredential(input.credential));
    await validateClaudeWebSession(encoded);
    return { access: encoded, refresh: encoded, expiresAt: new Date(Date.now() + SESSION_TTL_MS), accountLabel: input.accountLabel ?? "Claude Web" };
  }
}

export const claudeWebOAuthClient = new ClaudeWebOAuthClient();
