/**
 * Best-effort credential extraction from a pasted blob. Providers export
 * session/OAuth credentials in wildly different shapes (a bare token, a
 * `{access, refresh}` pair, an exported DB row with a stringified `data`
 * field, ...). Instead of asking the operator to hand-edit JSON before
 * pasting, we try to recognize the common shapes and pull out just the
 * value the provider's `call()` actually needs.
 *
 * Falls back to the raw trimmed input whenever nothing recognizable is
 * found — plain-string API keys/PATs (the common case) pass through
 * unchanged.
 */

/** Field names checked, in priority order, at both the top level and inside a nested `data` object. */
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

function firstStringField(obj: Record<string, unknown>): string | undefined {
  for (const field of CREDENTIAL_FIELD_PRIORITY) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export interface ExtractedCredential {
  value: string;
  /** True when the value was pulled out of a recognized JSON shape rather than used as-is. */
  extracted: boolean;
  /** Which field it came from, for a confirmation toast (e.g. "data.access"). */
  source?: string;
}

/** Pulls a credential out of a parsed object, checking top level then a nested `data` field (string-JSON or object). */
function extractFromObject(obj: Record<string, unknown>): ExtractedCredential | undefined {
  const topLevel = firstStringField(obj);
  if (topLevel) return { value: topLevel, extracted: true, source: CREDENTIAL_FIELD_PRIORITY.find((f) => obj[f] === topLevel) };

  // Cursor CLI export shape: `data` is a JSON-encoded string (or already an
  // object) holding `{"access": "...", "refresh": "..."}`.
  const dataField = obj.data;
  let dataObj: Record<string, unknown> | undefined;
  if (typeof dataField === "string") {
    try {
      const inner: unknown = JSON.parse(dataField);
      if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) dataObj = inner as Record<string, unknown>;
    } catch {
      // not JSON — ignore
    }
  } else if (typeof dataField === "object" && dataField !== null && !Array.isArray(dataField)) {
    dataObj = dataField as Record<string, unknown>;
  }
  if (dataObj) {
    const nested = firstStringField(dataObj);
    if (nested) {
      const field = CREDENTIAL_FIELD_PRIORITY.find((f) => dataObj![f] === nested);
      return { value: nested, extracted: true, source: field ? `data.${field}` : "data" };
    }
  }
  return undefined;
}

/**
 * Parses a plain-text `key: value` dump (one field per line — the shape a
 * DB row export/debug print produces, e.g. `id: 8934`, `provider: cursor`,
 * `data: {"access":"..."}`) into an object. Only lines matching
 * `identifier: rest-of-line` are kept; anything else is ignored so stray
 * blank lines or comments don't break parsing.
 */
function parseKeyValueLines(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/);
  const obj: Record<string, unknown> = {};
  let matched = 0;
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    obj[m[1]!] = m[2]!.trim();
    matched++;
  }
  return matched > 0 ? obj : undefined;
}

/**
 * Tries to pull a credential value out of a pasted blob. Recognizes:
 *  - a bare JSON object with one of the known field names at the top level
 *  - a JSON object with a nested `data` field (string-JSON or object) that
 *    itself has one of the known field names — the Cursor/CLI-exported
 *    account shape
 *  - a plain-text `key: value` line dump (id/provider/credential_type/data/
 *    ... one per line) whose `data` line embeds the same JSON shape —
 *    what a raw DB row export/debug print looks like
 * Returns the original trimmed input, unmodified, when nothing recognizable
 * is found (plain API keys/PATs are the common case and pass through as-is).
 */
export function extractCredentialFromPaste(raw: string): ExtractedCredential {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const found = extractFromObject(parsed as Record<string, unknown>);
        if (found) return found;
      }
    } catch {
      // not JSON — fall through to line-based parsing below
    }
  }

  const kv = parseKeyValueLines(trimmed);
  if (kv) {
    const found = extractFromObject(kv);
    if (found) return found;
  }

  return { value: trimmed, extracted: false };
}
