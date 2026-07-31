/**
 * Shared JSON array helpers for DB repos that store comma-separated or
 * JSON-serialized string arrays in TEXT columns (api_keys.provider_allowlist,
 * api_keys.model_allowlist, access_rules.entries_json, etc.).
 */

/** Parse a JSON string into a string array; returns null if the value is null, empty, or not a valid JSON array. */
export function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/** Serialize a string array for storage; returns null for null/undefined/empty arrays. */
export function serializeJsonArray(value: string[] | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.length > 0 ? JSON.stringify(value) : null;
}
