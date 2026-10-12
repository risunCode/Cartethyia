/**
 * Operator-facing label for an account error category.
 *
 * The raw category is a machine value (`quota_fetch_failed`) and that is what
 * the account row used to render, which told an operator nothing about what to
 * do. The label says what is wrong; the raw category stays in the tooltip.
 */

/** One credential kind; mirrors `CREDENTIAL_KINDS` in the catalog contracts. */
type CredentialKind = "api_key" | "oauth" | "none";

const ACCOUNT_ERROR_LABELS: Readonly<Record<string, string>> = {
  quota_fetch_failed: "Quota unreachable",
  quota_exhausted: "Quota exhausted",
  policy_blocked: "Policy blocked",
  rate_limit_transient: "Rate limited",
  missing_credential: "No credential",
};

/**
 * What the operator must actually do about a rejected credential.
 *
 * `auth_invalidated` used to render "Re-login required" for every credential,
 * which is only true of an OAuth account: a BYOK API key has no login to
 * return to, and telling an operator to re-login sends them hunting for a
 * sign-in button their provider does not have. The fix for an API key is to
 * paste a different one.
 */
export function authInvalidatedLabel(credentialKind: string | undefined): string {
  return credentialKind === "oauth" ? "Re-login required" : "Replace API key";
}

export function accountErrorLabel(category: string, credentialKind?: CredentialKind): string {
  if (category === "auth_invalidated") return authInvalidatedLabel(credentialKind);
  return ACCOUNT_ERROR_LABELS[category] ?? category;
}