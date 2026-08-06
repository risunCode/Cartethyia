/**
 * Shared filesystem operations for CLI tool injectors.
 *
 * Uses Bun.file / Bun.spawn — no external dependencies.
 * All JSON readers tolerate trailing commas (JSONC) and treat missing or
 * unparseable files as "no config" rather than throwing.
 */

import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

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
    // Strip trailing commas (JSONC tolerance) — same approach as 9router.
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

/** Create a directory recursively (like mkdir -p). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Check if a CLI binary is installed by running `which` (Unix) or `where` (Windows).
 * Falls back to checking if a config file exists at `fallbackPath`.
 */
export async function checkBinaryInstalled(binaryName: string, fallbackPath?: string): Promise<boolean> {
  const cmd = IS_WIN ? "where" : "which";
  const args = IS_WIN ? [cmd, binaryName] : [cmd, binaryName];
  const env: Record<string, string | undefined> = { ...process.env };
  if (IS_WIN && env.APPDATA) {
    env.PATH = `${env.APPDATA}\\npm;${env.PATH ?? ""}`;
  }
  try {
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", env: env as Record<string, string> });
    const exitCode = await proc.exited;
    if (exitCode === 0) return true;
  } catch {
    // Binary not found or command failed — fall through to fallback.
  }
  if (fallbackPath !== undefined) return fileExists(fallbackPath);
  return false;
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

/** Strip trailing slashes from a URL. */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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

// ─── Minimal TOML helpers ────────────────────────────────────────────────────
//
// These handle the simple structures the CLI tools use: flat key=value pairs
// and one-level-nested [section] tables. They are NOT a general TOML parser —
// they preserve existing file content via regex upsert/remove so user comments
// and formatting are kept intact.

/** Read a flat key=value from TOML text (first match). */
export function tomlGet(text: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"([^"]*)"`, "im");
  const match = re.exec(text);
  return match?.[1] ?? null;
}

/** Upsert a flat key="value" line in TOML text. If the key exists, replace its value. */
export function tomlUpsertFlat(text: string, key: string, value: string): string {
  const escaped = escapeRegex(key);
  const re = new RegExp(`^${escaped}\\s*=\\s*"[^"]*"`, "im");
  const line = `${key} = "${value}"`;
  if (re.test(text)) return text.replace(re, line);
  const withNewline = text.endsWith("\n") ? text : `${text}\n`;
  return `${withNewline}${line}\n`;
}

/** Remove a flat key=value line from TOML text. */
export function tomlRemoveFlat(text: string, key: string): string {
  const re = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"[^"]*"\\n?`, "im");
  return text.replace(re, "");
}

/** Upsert a [section] block with the given body text. Replaces existing section if found. */
export function tomlUpsertSection(text: string, section: string, body: string): string {
  const sectionRe = new RegExp(`^\\[${escapeRegex(section)}\\]\\s*\\n(?:(?!^\\[)[^\\n]*\\n?)*`, "im");
  const block = `[${section}]\n${body}\n`;
  if (sectionRe.test(text)) return text.replace(sectionRe, block);
  const withNewline = text.endsWith("\n") ? text : `${text}\n`;
  return `${withNewline}${block}\n`;
}

/** Remove a [section] block and all its key=value lines from TOML text. */
export function tomlRemoveSection(text: string, section: string): string {
  const re = new RegExp(`^\\[${escapeRegex(section)}\\]\\s*\\n(?:(?!^\\[)[^\\n]*\\n?)*`, "im");
  return text.replace(re, "").replace(/^\n+/, "");
}

/** Check if a TOML text contains a specific [section] header. */
export function tomlHasSection(text: string, section: string): boolean {
  return new RegExp(`^\\[${escapeRegex(section)}\\]`, "im").test(text);
}

// ─── Minimal .env file helpers ───────────────────────────────────────────────

/** Upsert a KEY=VALUE line in .env text. */
export function envUpsert(text: string, key: string, value: string): string {
  const re = new RegExp(`^${escapeRegex(key)}=.*$`, "im");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  const withNewline = text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
  return `${withNewline}${line}\n`;
}

/** Remove a KEY=VALUE line from .env text. */
export function envRemove(text: string, key: string): string {
  return text.replace(new RegExp(`^${escapeRegex(key)}=.*\\n?`, "im"), "");
}

/** Read a KEY=VALUE from .env text. */
export function envGet(text: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegex(key)}=(.*)$`, "im");
  const match = re.exec(text);
  return match?.[1]?.trim() ?? null;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
