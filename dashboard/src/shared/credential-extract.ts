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

/**
 * Fields whose presence identifies one record as a Cartethyia account export
 * row (`ProviderAccountExport`). Such a row carries its credential under
 * `accessToken` and its kind under `credentialKind`; without this, an exported
 * row is read as an opaque blob and loses its credential during re-import.
 */
const EXPORT_ROW_FIELDS = ["credentialKind", "providerId", "accessToken"] as const;

/**
 * Wrapper keys a batch export nests its rows under. Cartethyia's own export
 * uses `accounts`; the batch-import shape shared by the reference dashboards
 * uses the same key, so one unwrap serves both.
 */
const ACCOUNTS_WRAPPER_KEYS = ["accounts", "items", "connections"] as const;

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

/**
 * Unified browser cookie/session detection:
 * Detects whether an array of objects represents a set of cookies belonging to a single
 * session/origin rather than a batch of individual accounts:
 * - Cookie-Editor flat export: [{ name: "...", value: "...", domain: "..." }, ...]
 * - SessionBox / Storage Viewer format: [{ domain: "...", cookies: [...] }]
 */
function isCookieArrayExport(items: readonly Record<string, unknown>[]): boolean {
  if (items.length === 0) return false;

  // Pattern 1: SessionBox container export with nested cookies array
  const hasNestedCookies = items.some(
    (item) => Array.isArray(item["cookies"]) && (typeof item["domain"] === "string" || typeof item["originalUrl"] === "string"),
  );
  if (hasNestedCookies) return true;

  // Pattern 2: Flat cookie export from Cookie-Editor / EditThisCookie
  // Every item has `name` and `value`, and commonly `domain`, `path`, or `expirationDate`
  const allAreCookies = items.every(
    (item) =>
      typeof item["name"] === "string" &&
      typeof item["value"] === "string" &&
      (item["domain"] !== undefined || item["path"] !== undefined || item["expirationDate"] !== undefined),
  );
  if (allAreCookies) return true;

  return false;
}

/**
 * Extracts identity and OAuth character from a cookie export bundle.
 */
function entryFromCookieBundle(
  rawJsonStr: string,
  items: readonly Record<string, unknown>[],
): ParsedCredentialEntry {
  let identity: string | undefined;
  let isOAuth = false;

  const inspectCookie = (name: string, val: string) => {
    const n = name.toLowerCase();
    if (n === "userid" || n === "uid" || n === "accountid" || n === "cuserid") {
      if (!identity) identity = val.replace(/^"|"$/g, "").trim();
    }
    if (n.includes("token") || n.includes("ph") || n.includes("auth") || n.includes("session")) {
      isOAuth = true;
    }
  };

  for (const item of items) {
    if (Array.isArray(item["cookies"])) {
      for (const c of item["cookies"]) {
        if (c && typeof c === "object") {
          const rec = c as Record<string, unknown>;
          if (typeof rec["name"] === "string" && typeof rec["value"] === "string") {
            inspectCookie(rec["name"], rec["value"]);
          }
        }
      }
    } else if (typeof item["name"] === "string" && typeof item["value"] === "string") {
      inspectCookie(item["name"], item["value"]);
    }
  }

  return {
    value: rawJsonStr,
    kind: isOAuth ? "oauth" : "api_key",
    ...(identity ? { identity } : {}),
  };
}

function entryFromObject(obj: Record<string, unknown>): ParsedCredentialEntry {
  const exportKind = obj["credentialKind"];
  if (
    typeof exportKind === "string" &&
    typeof obj["accessToken"] === "string" &&
    EXPORT_ROW_FIELDS.every((field) => field in obj)
  ) {
    const label = typeof obj["label"] === "string" && obj["label"].trim().length > 0
      ? obj["label"].trim()
      : undefined;
    return {
      value: obj["accessToken"],
      kind: exportKind === "oauth" ? "oauth" : "api_key",
      ...(label ? { identity: label } : {}),
    };
  }
  const kind: DetectedCredentialKind = oauthShapeFromObject(obj) ? "oauth" : "api_key";
  const value =
    kind === "oauth" ? JSON.stringify(obj) : (extractFromObject(obj)?.value ?? JSON.stringify(obj));
  const identity = identityFromObject(obj);
  return identity ? { value, kind, identity } : { value, kind };
}

/**
 * Rows a batch export nests under a wrapper key, or `undefined` when the blob
 * is not a wrapper. Cartethyia's own export is `{ exportedAt, accounts: [...] }`
 * and the reference batch-import shape is `{ accounts: [...] }`, so without
 * this an export re-import became one opaque entry.
 */
function wrapperRows(obj: Record<string, unknown>): readonly Record<string, unknown>[] | undefined {
  for (const key of ACCOUNTS_WRAPPER_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const rows = value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    if (rows.length > 0) return rows;
  }
  return undefined;
}

/**
 * Splits a pasted blob into one or more credential entries:
 * - a unified cookie bundle (Cookie-Editor, SessionBox, EditThisCookie) → exactly ONE entry preserving the whole JSON bundle
 * - a JSON array of accounts → one entry per account
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

    if (objects.length > 0) {
      // Global Unified Check: Is this a single cookie session bundle exported as an array?
      if (isCookieArrayExport(objects)) {
        return [entryFromCookieBundle(trimmed, objects)];
      }

      return objects.map(entryFromObject);
    }
  } else {
    const obj = asRecord(wholeBlob);
    if (obj) {
      const rows = wrapperRows(obj);
      if (rows) return rows.map(entryFromObject);
      return [entryFromObject(obj)];
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  if (lines.length === 1) return parseSingleLine(lines[0] as string);

  // A `key: value` block is ONE structured credential, not a batch — and that
  // holds even when some of its lines do not parse as `key: value`. A comment
  // header, an indented continuation, or a repeated key all made the old
  // `keys.length === lines.length` guard fail, which dropped the whole block into
  // the per-line path. There, `parseSingleLine` cannot parse `apiKey: sk-...` as
  // JSON, so it returned the LINE'S LITERAL TEXT as the secret: the operator got
  // an account whose stored credential was the string `"apiKey: sk-..."`, and the
  // real key was discarded or demoted to a sibling entry.
  //
  // The single-credential path (`extractCredentialFromPaste`) already resolved
  // these inputs correctly by consulting `parseKeyValueLines` first. Matching it
  // here is what makes the two exported parsers agree.
  const asKeyValue = parseKeyValueLines(trimmed);
  if (asKeyValue) {
    // A block that names a credential field is one credential, however many of
    // its other lines failed to parse.
    if (extractFromObject(asKeyValue)) return [entryFromObject(asKeyValue)];
    // No credential field, but every line was `key: value` — still one
    // structured blob rather than one entry per field.
    if (Object.keys(asKeyValue).length === lines.length) return [entryFromObject(asKeyValue)];
  }

  return lines.flatMap(parseSingleLine);
}

function parseSingleLine(line: string): ParsedCredentialEntry[] {
  const obj = asRecord(parsedJson(line));
  if (obj) {
    const rows = wrapperRows(obj);
    if (rows) return rows.map(entryFromObject);
    return [entryFromObject(obj)];
  }
  return [{ value: line, kind: detectCredentialKind(line) }];
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
