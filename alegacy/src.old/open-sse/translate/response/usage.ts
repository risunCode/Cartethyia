import type { ProviderUsage } from "../../../application/contracts";

/** Returns a bounded non-negative integer for provider usage fields. */
export function usageNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Normalizes providers whose input token field includes cache reads/writes.
 * The shared contract stores uncached input separately from cache token counts.
 */
export function usageFromTotalInput(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  totalTokens: number | null = null,
  reasoningTokens?: number | null,
): ProviderUsage {
  const input = inputTokens === null ? null : usageNumber(inputTokens);
  const output = outputTokens === null ? null : usageNumber(outputTokens);
  const cacheRead = cacheReadTokens === null ? null : usageNumber(cacheReadTokens);
  const cacheWrite = cacheWriteTokens === null ? null : usageNumber(cacheWriteTokens);
  const uncachedInput = input === null ? null : Math.max(0, input - usageNumber(cacheRead) - usageNumber(cacheWrite));
  const fullInput = uncachedInput === null ? null : uncachedInput + usageNumber(cacheRead) + usageNumber(cacheWrite);
  return {
    inputTokens: uncachedInput,
    outputTokens: output,
    totalTokens: totalTokens === null ? (fullInput !== null && output !== null ? fullInput + output : null) : usageNumber(totalTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens: reasoningTokens === null ? null : usageNumber(reasoningTokens) }),
    source: "provider",
  };
}

/** Normalizes Anthropic-style usage where input_tokens excludes cache tokens. */
export function usageFromUncachedInput(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  totalTokens: number | null = null,
  reasoningTokens?: number | null,
): ProviderUsage {
  const input = inputTokens === null ? null : usageNumber(inputTokens);
  const output = outputTokens === null ? null : usageNumber(outputTokens);
  const cacheRead = cacheReadTokens === null ? null : usageNumber(cacheReadTokens);
  const cacheWrite = cacheWriteTokens === null ? null : usageNumber(cacheWriteTokens);
  const fullInput = input === null ? null : input + usageNumber(cacheRead) + usageNumber(cacheWrite);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: totalTokens === null ? (fullInput !== null && output !== null ? fullInput + output : null) : usageNumber(totalTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens: reasoningTokens === null ? null : usageNumber(reasoningTokens) }),
    source: "provider",
  };
}

/** Returns the complete prompt size represented by normalized usage. */
export function fullPromptTokens(usage: ProviderUsage): number {
  return usageNumber(usage.inputTokens) + usageNumber(usage.cacheReadTokens) + usageNumber(usage.cacheWriteTokens);
}
