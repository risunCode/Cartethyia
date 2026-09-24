/**
 * Provider credential envelope handling.
 *
 * One implementation for stripping the token envelope a provider-issued
 * credential may carry, so adapters never emit `Bearer Bearer`. Kept in its
 * own module (rather than the provider registry) because the adapters that
 * consume it must not import the registry: the registry imports every
 * adapter, so the reverse edge is a cycle.
 */

/** Envelope labels a stored credential may carry. */
export type TokenEnvelope = "bearer" | "oauth" | "provider";

const ENVELOPE_PREFIXES: Record<TokenEnvelope, string> = {
  bearer: "Bearer ",
  oauth: "OAuth ",
  provider: "provider:",
};

/**
 * Removes one explicitly identified envelope so adapters never emit
 * `Bearer Bearer`. The bearer branch strips case-insensitively with
 * surrounding-whitespace normalization; oauth/provider envelopes keep their
 * exact byte slices. Input without the identified envelope passes through
 * untouched.
 */
export function unwrapProviderToken(
  value: string | Uint8Array,
  envelope?: TokenEnvelope,
): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const text = new TextDecoder().decode(bytes);
  if (envelope === "bearer") {
    const trimmed = text.trim();
    const match = /^bearer\s+(.+)$/is.exec(trimmed);
    return new TextEncoder().encode((match?.[1] ?? trimmed).trim());
  }
  const prefix = envelope === undefined ? undefined : ENVELOPE_PREFIXES[envelope];
  if (prefix !== undefined && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return new TextEncoder().encode(text.slice(prefix.length));
  }
  return new Uint8Array(bytes);
}
