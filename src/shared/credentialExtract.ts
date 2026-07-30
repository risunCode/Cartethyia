/** Isomorphic best-effort extraction of credentials from pasted account exports. */

const CREDENTIAL_FIELD_PRIORITY = [
  "access",
  "accessToken",
  "access_token",
  "sessionToken",
  "session_token",
  "token",
  "apiKey",
  "api_key",
  "key",
  "credential",
  "pat",
  "secret",
] as const;

function firstStringField(obj: Record<string, unknown>): { value: string; field: string } | undefined {
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), field };
  }
  return undefined;
}

export interface ExtractedCredential {
  value: string;
  extracted: boolean;
  source?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractFromObject(obj: Record<string, unknown>): ExtractedCredential | undefined {
  const topLevel = firstStringField(obj);
  if (topLevel) return { value: topLevel.value, extracted: true, source: topLevel.field };

  const data = obj.data;
  let nestedObject = asRecord(data);
  if (typeof data === "string") {
    try {
      nestedObject = asRecord(JSON.parse(data));
    } catch {
      nestedObject = undefined;
    }
  }
  const nested = nestedObject && firstStringField(nestedObject);
  return nested ? { value: nested.value, extracted: true, source: `data.${nested.field}` } : undefined;
}

function parseKeyValueLines(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let matches = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]!] = match[2]!.trim();
    matches++;
  }
  return matches > 0 ? result : undefined;
}

/** Extracts a credential from JSON, nested `data`, or `key: value` paste text. */
export function extractCredentialFromPaste(raw: string): ExtractedCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      const extracted = parsed && extractFromObject(parsed);
      if (extracted) return extracted;
    } catch {
      // Fall through to line-based parsing.
    }
  }

  const rows = parseKeyValueLines(trimmed);
  const extracted = rows && extractFromObject(rows);
  return extracted ?? { value: trimmed, extracted: false };
}
