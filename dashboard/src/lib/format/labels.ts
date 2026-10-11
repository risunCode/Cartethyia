/**
 * Operator-facing label for an account error category.
 *
 * The raw category is a machine value (`quota_fetch_failed`) and that is what
 * the account row used to render, which told an operator nothing about what to
 * do. The label says what is wrong; the raw category stays in the tooltip.
 */
const ACCOUNT_ERROR_LABELS: Readonly<Record<string, string>> = {
  auth_invalidated: "Re-login required",
  quota_fetch_failed: "Quota unreachable",
  quota_exhausted: "Quota exhausted",
  policy_blocked: "Policy blocked",
  rate_limit_transient: "Rate limited",
  missing_credential: "No credential",
};

export function accountErrorLabel(category: string): string {
  return ACCOUNT_ERROR_LABELS[category] ?? category;
}
