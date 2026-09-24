/**
 * Auto-detects credential kind (api_key vs oauth), extracts the actual
 * secret value, and — for multi-credential pastes — splits a batch paste
 * (JSON array, newline-delimited JSON exports, or newline-delimited plain
 * tokens) into individually named entries. Mirrors the paste-detection and
 * bulk-import UX from the reference dashboard so users never have to
 * manually pick a credential kind or add accounts one at a time.
 */

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

const OAUTH_SHAPE_FIELDS = [
  "refresh",
  "refreshToken",
  "refresh_token",
  "expires",
  "expiresAt",
  "expires_at",
  "id_token",
  "idToken",
] as const;

/** Fields consulted (in order) to auto-name an account from a parsed JSON credential. */
const IDENTITY_FIELD_PRIORITY = [
  "email",
  "name",
  "accountId",
  "account_id",
  "id",
  "login",
  "username",
] as const;

export interface ExtractedCredential {
  readonly value: string;
  readonly extracted: boolean;
  readonly source?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/** Resolves `obj.data` to a record, parsing it as JSON first when it's a string. */
function nestedRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = obj.data;
  if (typeof data === "string") {
    try {
      return asRecord(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return asRecord(data);
}

function extractFromObject(obj: Record<string, unknown>): ExtractedCredential | undefined {
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), extracted: true, source: field };
    }
  }
  const nested = nestedRecord(obj);
  if (!nested) return undefined;
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = nested[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), extracted: true, source: `data.${field}` };
    }
  }
  return undefined;
}

/** Best-effort "who owns this credential" (email/name/accountId/...), checked top-level and in `data`. */
function identityFromObject(obj: Record<string, unknown>): string | undefined {
  for (const field of IDENTITY_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const nested = nestedRecord(obj);
  if (!nested) return undefined;
  for (const field of IDENTITY_FIELD_PRIORITY) {
    const value = nested[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function oauthShapeFromObject(obj: Record<string, unknown>): boolean {
  const hasShape = (record: Record<string, unknown>) =>
    OAUTH_SHAPE_FIELDS.some(
      (field) => typeof record[field] === "string" || typeof record[field] === "number",
    );
  if (hasShape(obj)) return true;
  const nested = nestedRecord(obj);
  return nested ? hasShape(nested) : false;
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

function parsedJson(trimmed: string): unknown {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Extracts the actual secret value from a pasted JSON export or key:value block. */
export function extractCredentialFromPaste(raw: string): ExtractedCredential {
  const trimmed = raw.trim();
  const json = asRecord(parsedJson(trimmed));
  if (json) {
    const extracted = extractFromObject(json);
    if (extracted) return extracted;
  }
  const rows = parseKeyValueLines(trimmed);
  const extracted = rows && extractFromObject(rows);
  return extracted ?? { value: trimmed, extracted: false };
}

export type DetectedCredentialKind = "api_key" | "oauth";

/**
 * Auto-detects whether pasted text is an OAuth export (JSON containing
 * refresh/expiry-shaped fields) or a plain API key. Defaults to "api_key"
 * for anything that isn't a recognizable OAuth JSON shape.
 */
export function detectCredentialKind(raw: string): DetectedCredentialKind {
  const trimmed = raw.trim();
  const json = asRecord(parsedJson(trimmed)) ?? parseKeyValueLines(trimmed);
  if (!json) return "api_key";
  return oauthShapeFromObject(json) ? "oauth" : "api_key";
}

export interface ParsedCredentialEntry {
  /** The value to submit as `secret` — the whole JSON blob for OAuth, the extracted key otherwise. */
  readonly value: string;
  readonly kind: DetectedCredentialKind;
  /** Auto-detected owner (email/name/accountId/...), used to auto-name the account. */
  readonly identity?: string;
}

function entryFromObject(obj: Record<string, unknown>): ParsedCredentialEntry {
  const kind: DetectedCredentialKind = oauthShapeFromObject(obj) ? "oauth" : "api_key";
  const value =
    kind === "oauth" ? JSON.stringify(obj) : (extractFromObject(obj)?.value ?? JSON.stringify(obj));
  const identity = identityFromObject(obj);
  return identity ? { value, kind, identity } : { value, kind };
}

/**
 * Splits a pasted blob into one or more credential entries:
 * - a JSON array → one entry per object element
 * - a single JSON object, or a multi-line `key: value` block → one entry
 * - newline-delimited JSON objects, or newline-delimited plain tokens → one entry per line
 */
export function parseCredentialBatch(raw: string): ParsedCredentialEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const wholeBlob = parsedJson(trimmed);
  if (Array.isArray(wholeBlob)) {
    const objects = wholeBlob
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    if (objects.length > 0) return objects.map(entryFromObject);
  } else {
    const obj = asRecord(wholeBlob);
    if (obj) return [entryFromObject(obj)];
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  if (lines.length === 1) return [parseSingleLine(lines[0] as string)];

  // Every line matches `key: value` → one structured credential, not a batch.
  const asKeyValue = parseKeyValueLines(trimmed);
  if (asKeyValue && Object.keys(asKeyValue).length === lines.length) {
    return [entryFromObject(asKeyValue)];
  }

  return lines.map(parseSingleLine);
}

function parseSingleLine(line: string): ParsedCredentialEntry {
  const obj = asRecord(parsedJson(line));
  if (obj) return entryFromObject(obj);
  return { value: line, kind: detectCredentialKind(line) };
}

/**
 * Assigns a unique, human-meaningful name to each entry: the auto-detected
 * identity when present, else `${providerId}-N` — colliding with existing
 * names (or with each other) gets a ` (2)`, ` (3)`, ... suffix.
 */
export function assignAccountNames(
  entries: readonly ParsedCredentialEntry[],
  providerId: string,
  existingNames: readonly string[],
): string[] {
  const used = new Set(existingNames);
  let nextSequence = 1;
  return entries.map((entry) => {
    let base = entry.identity;
    if (!base) {
      while (used.has(`${providerId}-${nextSequence}`)) nextSequence += 1;
      base = `${providerId}-${nextSequence}`;
      nextSequence += 1;
    }
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    return name;
  });
}
