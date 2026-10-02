/**
 * Shared filesystem operations for CLI tool injectors.
 *
 * Every injector uses the helpers in this module instead of importing
 * `node:fs` or `Bun.file` directly. Two reasons: (1) it keeps the FS surface
 * tiny and auditable, and (2) tests can point injectors at temp dirs by
 * stubbing `HOME` rather than mocking `fs`.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

/** Home directory — shared contract used by all injectors. */
export { homedir as homeDir };
export { join };

const IS_WIN: boolean = platform() === "win32";

/** Check if a file exists. */
export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** Read and parse a JSON file, tolerating trailing commas. Returns null if missing or unparseable. */
export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const text = await Bun.file(path).text();
    const stripped = text.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/** Write JSON to a file with 2-space indentation. */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2));
}

/** Read a text file, returning null if it doesn't exist. */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** Write text to a file. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

/** Remove a file if it exists. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Create a directory recursively (like mkdir -p). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Check if a CLI binary is installed on the current PATH.
 */
export async function checkBinaryInstalled(binaryName: string): Promise<boolean> {
  const cmd = IS_WIN ? "where" : "which";
  const env: Record<string, string | undefined> = { ...process.env };
  if (IS_WIN && env.APPDATA) env.PATH = `${env.APPDATA}\\npm;${env.PATH ?? ""}`;
  try {
    const proc = Bun.spawn([cmd, binaryName], {
      stdout: "ignore",
      stderr: "ignore",
      env: env as Record<string, string>,
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// ─── Endpoint normalization helpers ──────────────────────────────────────────

/**
 * Ensure a URL ends with `/v1`.
 *
 * Trailing slashes are normalized first. Without that, an endpoint the operator
 * typed as `http://localhost:12800/` — the form a browser address bar produces,
 * and the one the dashboard's own links use — became
 * `http://localhost:12800//v1`, which every downstream client treats as a
 * different path and 404s. `http://host/v1/` became `http://host/v1//v1`.
 */
export function ensureV1Suffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Strip a trailing `/v1` from a URL (some tools like Cline expect no /v1). */
export function stripV1Suffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Whether an endpoint URL points at a local Cartethyia instance.
 *
 * The match is anchored to the **hostname**, parsed rather than substring-
 * scanned. The previous unanchored `/localhost|127\.0\.0\.1|0\.0\.0\.0|
 * cartethyia/i` test matched anywhere in the string, so `https://notlocalhost.com`,
 * `https://mylocalhostproxy.net` and even `https://evil.com/localhost` were all
 * reported as local — and this value is what the dashboard shows the operator
 * as "configured", so a tool pointed at a remote host read as pointed at this
 * gateway. A hostname that merely *contains* one of these words is not local.
 *
 * A URL without a scheme is retried with an `http://` prefix, because the
 * operator may paste a bare `localhost:12800`.
 */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  const hostname = hostnameOf(url);
  if (hostname === null) return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized === "0.0.0.0") return true;
  if (/^127\./.test(normalized)) return true;
  // A Cartethyia *hostname*, not a path or query that happens to spell it.
  return normalized === "cartethyia" || normalized.startsWith("cartethyia.");
}

/**
 * Parses the hostname out of an endpoint, tolerating a missing scheme.
 *
 * A bare `localhost:12800` is the trap here: `new URL` *accepts* it, reading
 * `localhost:` as the scheme, and reports an **empty** hostname — so a parse
 * that only checks for a throw treats it as a host it cannot judge. Both forms
 * are therefore tried, and an empty hostname counts as a failure.
 */
function hostnameOf(url: string): string | null {
  for (const candidate of [url, `http://${url}`]) {
    try {
      const hostname = new URL(candidate).hostname;
      if (hostname.length > 0) return hostname;
    } catch {
      // Not parseable in this form; try the next.
    }
  }
  return null;
}

/** Sanitize an API key to a prefix for display (first 8 chars + ...). */
export function keyPrefix(key: string | null | undefined): string | null {
  if (!key || key.length < 8) return key ?? null;
  return `${key.slice(0, 8)}...`;
}

// ─── Structured text editing (TOML flat/section keys, .env KEY=VALUE) ───────
//
// These handle the simple structures the CLI tools use: flat key=value
// pairs and one-level-nested [section] tables. They are NOT a general TOML
// parser — they preserve existing file content via regex upsert/remove so
// user comments and formatting are kept intact.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Horizontal whitespace, never a line break.
 *
 * Every pattern below is **line-oriented**: a TOML or `.env` key/value line
 * cannot contain a newline, so each `\s` must be `[ \t]`. With `\s` a pattern
 * matches *across* a line break, and because several of these patterns drive a
 * `replace` whose replacement carries no trailing newline, the match swallows
 * the break and glues two lines together. Measured consequences of that,
 * before the fix — all of them syntactically invalid TOML, which the target
 * CLI then refuses to start on:
 *
 *   - `[agents]\n\n  k = "1"` → upserting `k` produced `[agents]  k = "9"`,
 *     putting a key on the section header's own line. `textGet` for that key
 *     then read back `null`, so the status shown to the operator was wrong too.
 *   - `[agents]\n  k = "1"\n  other = "2"\n[z]` → upserting `other` produced
 *     `other = "9"[z]`, appending the next header to the last key's line.
 *   - `model = "gpt-5"\n\n[section]` → an `insertAtTop` upsert of `model`
 *     produced `model = "new"[section]`.
 *
 * The read-only patterns (`textGet`, `textHas`) get the same treatment for
 * consistency: a key written across two lines is not a key this module should
 * claim to have found.
 */

/**
 * Addresses one field in structured text:
 *  - `flat`: a root-level `key = "value"` (toml, default) or `KEY=value`
 *    (`format: "env"`) line. `insertAtTop` (toml only) inserts new keys
 *    before the first `[section]` header instead of appending at EOF —
 *    required for keys that must precede any table per TOML syntax.
 *  - `sectionKey`: a quoted key nested one level inside `[section]`,
 *    upserted/removed without disturbing sibling keys.
 *  - `section`: the whole `[section]` block as an opaque body string.
 */
export type TextSelector =
  | {
      readonly kind: "flat";
      readonly key: string;
      readonly format?: "toml" | "env";
      readonly insertAtTop?: boolean;
    }
  | { readonly kind: "sectionKey"; readonly section: string; readonly key: string }
  | { readonly kind: "section"; readonly section: string };

/** Body boundaries of an existing `[section]`, or null if it doesn't exist. */
function sectionBounds(text: string, section: string): { start: number; end: number } | null {
  const header = new RegExp(`^\\[${escapeRegex(section)}\\][ \\t]*$`, "im");
  const match = header.exec(text);
  if (match === null || match.index === undefined) return null;
  const bodyStart = match.index + match[0].length;
  const remainder = text.slice(bodyStart);
  const nextSectionOffset = remainder.search(/^\[/m);
  const bodyEnd = nextSectionOffset < 0 ? text.length : bodyStart + nextSectionOffset;
  return { start: bodyStart, end: bodyEnd };
}

/**
 * Removes one whole line matching `pattern`, taking the line's own trailing
 * newline and nothing else.
 *
 * Removing a line must not disturb the blank lines around it: they are the
 * author's paragraphing, and in a config file the operator reads, collapsing
 * `key\n\n[next]` into `[next]` silently rewrites unrelated formatting. So the
 * match stops at the first line break — never at a run of whitespace — which is
 * the same discipline `horizontal` above enforces for the other patterns.
 */
function removeLine(text: string, pattern: RegExp): string {
  const linePattern = new RegExp(`${pattern.source}[ \\t]*\\r?\\n?`, pattern.flags);
  return text.replace(linePattern, "");
}

/**
 * Index just past the last root key, i.e. after the blank lines that precede
 * the first `[section]` header are excluded.
 *
 * Those blank lines are the header's leading separator. Keeping them out of the
 * "root keys" slice lets an in-place replacement of a root key leave them
 * untouched; the caller re-attaches them unchanged.
 */
function rootEndOfRootKeys(text: string, headerStart: number): number {
  const rootRegion = text.slice(0, headerStart);
  const trailingBreaks = /(?:\r?\n[ \t]*)+$/.exec(rootRegion);
  if (trailingBreaks === null) return headerStart;
  // The final line break is the root key's own terminator, so it stays.
  const withoutBlankTail = rootRegion.slice(0, trailingBreaks.index);
  const ownBreak = /^[ \t]*\r?\n/.exec(trailingBreaks[0]);
  return ownBreak === null
    ? withoutBlankTail.length
    : withoutBlankTail.length + ownBreak[0].length;
}

/**
 * Appends `line` to the end of a section body, preserving any blank lines the
 * author put inside it.
 *
 * The body is the text between a header and the next header, so its own
 * trailing newline belongs to the last key, not to the gap. Only the final
 * run of line breaks is trimmed, and only enough to make room for one line —
 * measured before the fix: a body `\n  k = "1"\n\n  other = "2"\n` collapsed to
 * `\n  k = "1"\n  other = "9"` with the blank line and the closing break gone.
 */
function appendSectionLine(body: string, line: string): string {
  const withoutTrailingBreaks = body.replace(/(?:\r?\n[ \t]*)+$/, "");
  return `${withoutTrailingBreaks}\n${line}\n`;
}

/** Read a field's value; null if the field (or its section) doesn't exist. */
export function textGet(text: string, selector: TextSelector): string | null {
  switch (selector.kind) {
    case "flat": {
      if (selector.format === "env") {
        const re = new RegExp(`^${escapeRegex(selector.key)}=(.*)$`, "im");
        return re.exec(text)?.[1]?.trim() ?? null;
      }
      const re = new RegExp(`^${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"([^"]*)"`, "im");
      return re.exec(text)?.[1] ?? null;
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return null;
      const body = text.slice(bounds.start, bounds.end);
      const re = new RegExp(`^[ \\t]*${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"([^"]*)"`, "im");
      return re.exec(body)?.[1] ?? null;
    }
    case "section": {
      const bounds = sectionBounds(text, selector.section);
      return bounds ? text.slice(bounds.start, bounds.end) : null;
    }
    default:
      selector satisfies never;
      return null;
  }
}

/** Check whether a field exists (or, for `section`, whether the header is present). */
export function textHas(text: string, selector: TextSelector): boolean {
  switch (selector.kind) {
    case "flat": {
      const re =
        selector.format === "env"
          ? new RegExp(`^${escapeRegex(selector.key)}=.*$`, "im")
          : new RegExp(`^${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"`, "im");
      return re.test(text);
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return false;
      const body = text.slice(bounds.start, bounds.end);
      return new RegExp(`^[ \\t]*${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"`, "im").test(body);
    }
    case "section":
      return new RegExp(`^\\[${escapeRegex(selector.section)}\\]`, "im").test(text);
    default:
      selector satisfies never;
      return false;
  }
}

/** Upsert a field's value (or, for `section`, replace/insert the whole body). */
export function textUpsert(text: string, selector: TextSelector, value: string): string {
  switch (selector.kind) {
    case "flat": {
      const env = selector.format === "env";
      const line = env ? `${selector.key}=${value}` : `${selector.key} = "${value}"`;
      if (selector.insertAtTop) {
        // Root-level insert before the first `[section]` header (TOML root
        // keys must precede all tables) rather than appending at EOF.
        //
        // The boundary is walked back over the blank lines that separate the
        // root keys from the first header, because those blank lines belong to
        // the header, not to the last root key. Replacing the key in place with
        // `keyPattern` anchored at `\\s*$` would otherwise swallow the break and
        // the indentation — measured: `model = "gpt-5"\n\n[section]` came out as
        // `model = "new"[section]`.
        const headerStart = text.search(/^\[/m);
        const boundary = headerStart < 0 ? text.length : headerStart;
        const rootEnd = headerStart < 0 ? boundary : rootEndOfRootKeys(text, headerStart);
        const root = text.slice(0, rootEnd);
        const keyPattern = new RegExp(
          `^${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"[ \\t]*$`,
          "im",
        );
        // The blank lines between the root keys and the first header are the
        // header's leading separator, and `rootEndOfRootKeys` holds them out of
        // `root` so a replacement cannot eat them. Re-attaching them verbatim
        // is what keeps the file's paragraphing intact.
        const separator = text.slice(rootEnd, boundary);
        if (keyPattern.test(root)) {
          return `${root.replace(keyPattern, line)}${separator}${text.slice(boundary)}`;
        }
        const prefix = root.endsWith("\n") || root.length === 0 ? root : `${root}\n`;
        return `${prefix}${line}\n${separator}${text.slice(boundary)}`;
      }
      const re = env
        ? new RegExp(`^${escapeRegex(selector.key)}=.*$`, "im")
        : new RegExp(`^${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"`, "im");
      if (re.test(text)) return text.replace(re, line);
      // Append at end-of-file. `text.length > 0` matters for the toml form too:
      // an empty file must not gain a leading blank line before its first key.
      if (text.length === 0) return `${line}\n`;
      const withNewline = text.endsWith("\n") ? text : `${text}\n`;
      return `${withNewline}${line}\n`;
    }
    case "sectionKey": {
      const line = `  ${selector.key} = "${value}"`;
      // Recovers a malformed file where the key ended up on the same line
      // as the section header (e.g. from an earlier buggy write).
      const malformed = new RegExp(
        `\\[${escapeRegex(selector.section)}\\][ \\t]+${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"`,
        "im",
      );
      if (malformed.test(text)) return text.replace(malformed, `[${selector.section}]\n${line}\n`);
      const header = new RegExp(`^\\[${escapeRegex(selector.section)}\\][ \\t]*$`, "im");
      const match = header.exec(text);
      if (match === null || match.index === undefined) {
        // Create the section. An empty file must not gain a leading blank line.
        if (text.length === 0) return `[${selector.section}]\n${line}\n`;
        const prefix = text.endsWith("\n") ? text : `${text}\n`;
        return `${prefix}[${selector.section}]\n${line}\n`;
      }
      const bodyStart = match.index + match[0].length;
      const remainder = text.slice(bodyStart);
      const nextSectionOffset = remainder.search(/^\[/m);
      const bodyEnd = nextSectionOffset < 0 ? text.length : bodyStart + nextSectionOffset;
      const body = text.slice(bodyStart, bodyEnd);
      const keyPattern = new RegExp(
        `^[ \\t]*${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"[ \\t]*$`,
        "im",
      );
      const nextBody = keyPattern.test(body)
        ? body.replace(keyPattern, line)
        : appendSectionLine(body, line);
      return `${text.slice(0, bodyStart)}${nextBody}${text.slice(bodyEnd)}`;
    }
    case "section": {
      // Matches the header line and every following line up to (not including)
      // the next header. `[ \t]*\r?\n` for the header's own break, and the body
      // alternation requires a line break per line, so the match can never run
      // past the section it names.
      const sectionRe = new RegExp(
        `^\\[${escapeRegex(selector.section)}\\][ \\t]*\\r?\\n(?:(?!^\\[)[^\\n]*\\n?)*`,
        "im",
      );
      const block = `[${selector.section}]\n${value}\n`;
      const existing = sectionRe.exec(text);
      if (existing === null) {
        // Append at end-of-file, adding only the break the previous line needs.
        // An empty file gets no leading blank line.
        if (text.length === 0) return block;
        return `${text.endsWith("\n") ? text : `${text}\n`}${block}`;
      }
      // The blank lines trailing the matched block are the *gap* before the next
      // header, not part of the body being replaced, so they are carried over.
      // Dropping them collapsed `[a]\n  x = "1"\n\n[b]` into
      // `[a]\n  x = "9"\n[b]` — silently rewriting the author's paragraphing on
      // every apply.
      const matched = existing[0];
      const trailingGap = /(?:\r?\n[ \t]*)+$/.exec(matched)?.[0] ?? "";
      const ownBreak = /^[ \t]*\r?\n/.exec(trailingGap)?.[0] ?? "";
      const carriedGap = trailingGap.slice(ownBreak.length);
      const replacement = `${block}${carriedGap}`;
      return `${text.slice(0, existing.index)}${replacement}${text.slice(existing.index + matched.length)}`;
    }
    default:
      selector satisfies never;
      return text;
  }
}

/**
 * Remove a field. `flat` removal is global for toml (all root occurrences,
 * matching the only variant this module ever needed) and single-match for
 * env; `sectionKey`/`section` removal is scoped to the named section.
 */
export function textRemove(text: string, selector: TextSelector): string {
  switch (selector.kind) {
    case "flat": {
      if (selector.format === "env") {
        return removeLine(text, new RegExp(`^${escapeRegex(selector.key)}=.*$`, "im"));
      }
      return removeLine(
        text,
        new RegExp(`^${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"[ \\t]*$`, "gim"),
      );
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return text;
      const body = text.slice(bounds.start, bounds.end);
      const nextBody = removeLine(
        body,
        new RegExp(`^[ \\t]*${escapeRegex(selector.key)}[ \\t]*=[ \\t]*"[^"]*"[ \\t]*$`, "im"),
      );
      return `${text.slice(0, bounds.start)}${nextBody}${text.slice(bounds.end)}`;
    }
    case "section": {
      // Matches the header line and every following line up to (not including)
      // the next header. `[ \t]*\r?\n` for the header's own break, and the body
      // alternation requires a line break per line, so the match can never run
      // past the section it names.
      const re = new RegExp(
        `^\\[${escapeRegex(selector.section)}\\][ \\t]*\\r?\\n(?:(?!^\\[)[^\\n]*\\n?)*`,
        "gim",
      );
      const removed = text.replace(re, "");
      // Collapse the gap the block left behind. The blank lines that separated
      // it from its neighbours are not part of it, so `# top\n\n\n[a]\n…` used to
      // come back as `# top\n\n\n` — trailing blanks where a section used to be.
      // Only a gap at the very start or the very end is collapsed; anywhere else
      // it still separates two real lines.
      const leadingGap = /^(?:[ \t]*\r?\n)+/.exec(removed)?.[0] ?? "";
      const body = removed.slice(leadingGap.length).replace(/(?:\r?\n[ \t]*)+$/, "");
      return body.length === 0 ? "" : `${body}\n`;
    }
    default:
      selector satisfies never;
      return text;
  }
}
