/** Blended-rate cost estimate — see `RuntimeSettings.costPerMillion*Tokens` for why this isn't per-model. */

export function estimateCostUsd(inputTokens: number, outputTokens: number, ratePerMillionInput: number, ratePerMillionOutput: number): number {
  return (inputTokens * ratePerMillionInput + outputTokens * ratePerMillionOutput) / 1_000_000;
}
