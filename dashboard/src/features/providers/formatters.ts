export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
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
