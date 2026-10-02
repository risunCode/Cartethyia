/**
 * Per-provider proactive OAuth refresh lead.
 *
 * A single global "refresh 5 minutes before expiry" window is wrong for two
 * reasons. Some providers issue short-lived tokens that a 5-minute lead can
 * miss entirely under a loaded sweep, while others issue long-lived tokens
 * where re-minting every few minutes is pointless traffic. And some providers
 * (Google-backed) rate-limit the token endpoint aggressively, so refreshing
 * only when genuinely close to expiry matters more than reacting fast.
 *
 * The lead is how long *before* expiry the token becomes eligible for
 * proactive refresh. It is a floor: a caller may pass a larger `skewMs`
 * explicitly, and `DEFAULT_REFRESH_LEAD_MS` applies to any provider not listed.
 *
 * Values mirror the leads published by the upstream clients these providers
 * model (Claude Code ~4h, Codex ~5 days, Antigravity/Kimi ~5 min), so a token
 * is re-minted on the same schedule the first-party tooling uses.
 */
export const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * Per-provider refresh lead in milliseconds. Providers absent here use
 * {@link DEFAULT_REFRESH_LEAD_MS}. Keys are provider ids as stored on
 * `provider_accounts.provider_id`.
 */
export const REFRESH_LEAD_MS: Readonly<Record<string, number>> = Object.freeze({
  // Google-backed token endpoints throttle; a wide lead with infrequent
  // refreshes is safer than a tight one that retries often.
  antigravity: 5 * 60 * 1000,
  // Claude Code access tokens live ~8h and the CLI re-mints well ahead of
  // expiry; 4h keeps a full work session on one token.
  claude: 4 * 60 * 60 * 1000,
  // Codex/ChatGPT access tokens live for days; refresh on a 5-day lead.
  codex: 5 * 24 * 60 * 60 * 1000,
  // xAI/Grok CLI and Kimi both re-mint on a 5-minute lead.
  grok: 5 * 60 * 1000,
  kimi: 5 * 60 * 1000,
  // iFlow tokens are long-lived; a 1-day lead avoids pointless churn.
  iflow: 24 * 60 * 60 * 1000,
});

/** The refresh lead for `providerId`, falling back to the shared default. */
export function refreshLeadMs(providerId: string): number {
  return REFRESH_LEAD_MS[providerId] ?? DEFAULT_REFRESH_LEAD_MS;
}
