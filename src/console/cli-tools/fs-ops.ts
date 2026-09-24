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

/** Ensure a URL ends with `/v1`. */
export function ensureV1Suffix(url: string): string {
  return url.endsWith("/v1") ? url : `${url}/v1`;
}

/** Strip a trailing `/v1` from a URL (some tools like Cline expect no /v1). */
export function stripV1Suffix(url: string): string {
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

/** Check if an endpoint URL points to a local Cartethyia instance. */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|cartethyia/i.test(url);
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
  const header = new RegExp(`^\\[${escapeRegex(section)}\\]\\s*$`, "im");
  const match = header.exec(text);
  if (match === null || match.index === undefined) return null;
  const bodyStart = match.index + match[0].length;
  const remainder = text.slice(bodyStart);
  const nextSectionOffset = remainder.search(/^\[/m);
  const bodyEnd = nextSectionOffset < 0 ? text.length : bodyStart + nextSectionOffset;
  return { start: bodyStart, end: bodyEnd };
}

/** Read a field's value; null if the field (or its section) doesn't exist. */
export function textGet(text: string, selector: TextSelector): string | null {
  switch (selector.kind) {
    case "flat": {
      if (selector.format === "env") {
        const re = new RegExp(`^${escapeRegex(selector.key)}=(.*)$`, "im");
        return re.exec(text)?.[1]?.trim() ?? null;
      }
      const re = new RegExp(`^${escapeRegex(selector.key)}\\s*=\\s*"([^"]*)"`, "im");
      return re.exec(text)?.[1] ?? null;
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return null;
      const body = text.slice(bounds.start, bounds.end);
      const re = new RegExp(`^\\s*${escapeRegex(selector.key)}\\s*=\\s*"([^"]*)"`, "im");
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
          : new RegExp(`^${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"`, "im");
      return re.test(text);
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return false;
      const body = text.slice(bounds.start, bounds.end);
      return new RegExp(`^\\s*${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"`, "im").test(body);
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
        const rootEnd = text.search(/^\[/m);
        const boundary = rootEnd < 0 ? text.length : rootEnd;
        const root = text.slice(0, boundary);
        const keyPattern = new RegExp(`^${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"\\s*$`, "im");
        if (keyPattern.test(root))
          return `${root.replace(keyPattern, line)}${text.slice(boundary)}`;
        const prefix = root.endsWith("\n") || root.length === 0 ? root : `${root}\n`;
        return `${prefix}${line}\n${text.slice(boundary)}`;
      }
      const re = env
        ? new RegExp(`^${escapeRegex(selector.key)}=.*$`, "im")
        : new RegExp(`^${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"`, "im");
      if (re.test(text)) return text.replace(re, line);
      const withNewline = env
        ? text.length > 0 && !text.endsWith("\n")
          ? `${text}\n`
          : text
        : text.endsWith("\n")
          ? text
          : `${text}\n`;
      return `${withNewline}${line}\n`;
    }
    case "sectionKey": {
      const line = `  ${selector.key} = "${value}"`;
      // Recovers a malformed file where the key ended up on the same line
      // as the section header (e.g. from an earlier buggy write).
      const malformed = new RegExp(
        `\\[${escapeRegex(selector.section)}\\][ \\t]+${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"`,
        "im",
      );
      if (malformed.test(text)) return text.replace(malformed, `[${selector.section}]\n${line}\n`);
      const header = new RegExp(`^\\[${escapeRegex(selector.section)}\\][ \\t]*$`, "im");
      const match = header.exec(text);
      if (match === null || match.index === undefined) {
        const prefix = text.endsWith("\n") ? text : `${text}\n`;
        return `${prefix}[${selector.section}]\n${line}\n`;
      }
      const bodyStart = match.index + match[0].length;
      const remainder = text.slice(bodyStart);
      const nextSectionOffset = remainder.search(/^\[/m);
      const bodyEnd = nextSectionOffset < 0 ? text.length : bodyStart + nextSectionOffset;
      const body = text.slice(bodyStart, bodyEnd);
      const keyPattern = new RegExp(`^\\s*${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"\\s*$`, "im");
      const nextBody = keyPattern.test(body)
        ? body.replace(keyPattern, line)
        : `${body.replace(/\s*$/, "")}\n${line}\n`;
      return `${text.slice(0, bodyStart)}${nextBody}${text.slice(bodyEnd)}`;
    }
    case "section": {
      const sectionRe = new RegExp(
        `^\\[${escapeRegex(selector.section)}\\]\\s*\\n(?:(?!^\\[)[^\\n]*\\n?)*`,
        "im",
      );
      const block = `[${selector.section}]\n${value}\n`;
      if (sectionRe.test(text)) return text.replace(sectionRe, block);
      const withNewline = text.endsWith("\n") ? text : `${text}\n`;
      return `${withNewline}${block}\n`;
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
        return text.replace(new RegExp(`^${escapeRegex(selector.key)}=.*\\n?`, "im"), "");
      }
      return text.replace(
        new RegExp(`^${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"\\s*\\n?`, "gim"),
        "",
      );
    }
    case "sectionKey": {
      const bounds = sectionBounds(text, selector.section);
      if (!bounds) return text;
      const body = text.slice(bounds.start, bounds.end);
      const nextBody = body.replace(
        new RegExp(`^\\s*${escapeRegex(selector.key)}\\s*=\\s*"[^"]*"\\s*\\n?`, "im"),
        "",
      );
      return `${text.slice(0, bounds.start)}${nextBody}${text.slice(bounds.end)}`;
    }
    case "section": {
      const re = new RegExp(
        `^\\[${escapeRegex(selector.section)}\\]\\s*\\n(?:(?!^\\[)[^\\n]*\\n?)*`,
        "gim",
      );
      return text.replace(re, "").replace(/^\n+/, "");
    }
    default:
      selector satisfies never;
      return text;
  }
}
