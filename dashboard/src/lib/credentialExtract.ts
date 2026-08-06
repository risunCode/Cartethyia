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

export interface ExtractedCredential {
  value: string;
  extracted: boolean;
  source?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function extractFromObject(obj: Record<string, unknown>): ExtractedCredential | undefined {
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), extracted: true, source: field };
  }
  const data = obj.data;
  let nestedObject = asRecord(data);
  if (typeof data === "string") {
    try {
      nestedObject = asRecord(JSON.parse(data));
    } catch {
      nestedObject = undefined;
    }
  }
  if (!nestedObject) return undefined;
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = nestedObject[field];
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), extracted: true, source: `data.${field}` };
  }
  return undefined;
}

function parseKeyValueLines(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let matches = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) continue;
    result[key] = value.trim();
    matches += 1;
  }
  return matches > 0 ? result : undefined;
}

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
