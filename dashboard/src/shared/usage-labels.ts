/**
 * Labels for the Usage request table and its detail drawer.
 *
 * The API Key column renders two lines: the key's label, and the client that
 * sent the request. Provider probes (the "Test" button on a model card) have
 * neither — they carry no API key and no client identity — so both lines used
 * to fall back to an em dash and the row read as "— / —".
 *
 * Probes are identified by the absence of an API key rather than by user agent.
 * `probing-service.ts` never sets a User-Agent header, so the legacy
 * `userAgent === "Cartethyia Probe"` check in this file could never match; it is
 * kept only as a forward-compatible signal. The key-less rule is exact against
 * production data: every one of the 11,782 telemetry rows is either
 * (key + user agent + client IP) or (none of the three), with no overlap — so
 * "no key" and "probe" are the same set. `dashboard/test/shared/usage-labels.test.ts`
 * pins that contract, including the case that matters most: a live request that
 * HAS a key must never be relabelled as a probe.
 */

/** User-Agent a probe would send if it ever set one. Not set today. */
const PROBE_USER_AGENT = "Cartethyia Probe";

/** The slice of a usage row these helpers read. */
export interface UsageKeyIdentity {
  readonly apiKeyId?: string | undefined;
  readonly apiKeyLabel?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly clientName?: string | undefined;
}

/**
 * True when the row was produced by a provider probe rather than by a client
 * request. Absent key ⇒ probe; the user-agent branch only fires if the backend
 * starts sending that header.
 */
export function isProbeRequest(row: UsageKeyIdentity | null | undefined): boolean {
  if (!row) return false;
  if (row.userAgent === PROBE_USER_AGENT) return true;
  return !row.apiKeyId;
}

/** First line of the API Key cell: the key's label, "Probe", or an em dash. */
export function usageApiKeyLabel(row: UsageKeyIdentity | null | undefined): string {
  if (!row) return "—";
  if (isProbeRequest(row)) return "Probe";
  if (row.apiKeyLabel) return row.apiKeyLabel;
  if (row.apiKeyId) return `${row.apiKeyId.slice(0, 8)}…`;
  return "—";
}

/** Second line of the API Key cell: the calling client. */
export function usageClientLabel(row: UsageKeyIdentity | null | undefined): string {
  if (!row) return "—";
  if (row.clientName) return row.clientName;
  if (row.userAgent) return row.userAgent;
  return isProbeRequest(row) ? "Provider test" : "—";
}
