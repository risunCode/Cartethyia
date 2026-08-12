import type { ProviderQuirkPolicy } from "../../../application/contracts";

/** Applies bounded top-level provider field policies without mutating the adapter payload. */
export function applyProviderQuirkPolicy(payload: Readonly<Record<string, unknown>>, policy: ProviderQuirkPolicy | undefined): Record<string, unknown> {
  if (policy === undefined) return { ...payload };
  const result: Record<string, unknown> = { ...payload };
  for (const field of policy.droppedFields ?? []) delete result[field];
  for (const [field, bounds] of Object.entries(policy.clampedFields ?? {})) {
    const value = result[field];
    if (typeof value !== "number") continue;
    const min = bounds.min ?? value;
    const max = bounds.max ?? value;
    result[field] = Math.min(max, Math.max(min, value));
  }
  return result;
}

/** Adds only adapter-declared headers to an existing upstream header set. */
export function applyRequiredProviderHeaders(headers: Headers, policy: ProviderQuirkPolicy | undefined): Headers {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(policy?.requiredHeaders ?? {})) result.set(name, value);
  return result;
}
