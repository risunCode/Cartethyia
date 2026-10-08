/**
 * Labels for the Usage request table and its detail drawer.
 */
const PROBE_USER_AGENT = "Cartethyia Probe";

export interface UsageKeyIdentity {
  readonly apiKeyId?: string | undefined;
  readonly apiKeyLabel?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly clientName?: string | undefined;
}

export function isProbeRequest(row: UsageKeyIdentity | null | undefined): boolean {
  if (!row) return false;
  // Only a real probe. A missing key is not one: an early rejection and a
  // keyless request both lack it, and labelling them probes hid that.
  return row.userAgent === PROBE_USER_AGENT;
}

export function usageApiKeyLabel(row: UsageKeyIdentity | null | undefined): string {
  if (!row) return "—";
  if (isProbeRequest(row)) return "Probe";
  if (row.apiKeyLabel) return row.apiKeyLabel;
  if (row.apiKeyId) return `${row.apiKeyId.slice(0, 8)}…`;
  return "—";
}

export function usageClientLabel(row: UsageKeyIdentity | null | undefined): string {
  if (!row) return "—";
  if (row.clientName) return row.clientName;
  if (row.userAgent) return row.userAgent;
  return isProbeRequest(row) ? "Provider test" : "—";
}
