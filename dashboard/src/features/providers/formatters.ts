export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Returns the canonical two-line account identity used by every account table. */
export interface AccountIdentity {
  readonly primary: string;
  readonly secondary: string | null;
}

function isTokenHint(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("sk-") || value.startsWith("…");
}

/** Prioritizes an email, then falls back to provider username/name. */
export function accountIdentity(hint: string, name: string): AccountIdentity {
  const fallbackName = name.trim() || "Unnamed account";
  const normalizedHint = displayAccountHint(hint, fallbackName).trim();
  const usableHint = normalizedHint && normalizedHint !== "—" ? normalizedHint : null;
  const email = [usableHint, fallbackName].find((value): value is string => value !== null && isEmail(value)) ?? null;
  if (email !== null) {
    const secondary = [fallbackName, usableHint].find((value): value is string => value !== null && value !== email && !isTokenHint(value)) ?? null;
    return { primary: email, secondary };
  }
  const secondary = usableHint !== null && usableHint !== fallbackName && !isTokenHint(usableHint) ? usableHint : null;
  return { primary: fallbackName, secondary };
}

/** Shows an account identity instead of exposing an opaque JWT prefix. */
export function displayAccountHint(hint: string, name: string): string {
  if (hint.startsWith("eyJ") || hint === "—") return name;
  return hint;
}

/** Formats per-million provider pricing while preserving a real free-plan label. */
export function formatModelPricing(pricing: ModelPricing | undefined): string | null {
  if (!pricing) return null;
  if (pricing.input === 0 && pricing.output === 0) return "Free";
  const formatPrice = (value: number) => (value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);
  return `${formatPrice(pricing.input)} / ${formatPrice(pricing.output)} per 1M`;
}
