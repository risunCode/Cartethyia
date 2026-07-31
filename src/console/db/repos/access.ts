/**
 * Access rules — proxy/console ACLs with IP + CIDR entries (REQ-15, design §5.8).
 * Modes: open (allow all), allowlist (only listed), denylist (all except listed).
 */

import { getDb } from "../client";
import { parseJsonArray } from "../json-helpers";

export type AccessScope = "proxy" | "console";
export type AccessMode = "open" | "allowlist" | "denylist";

interface AccessRow {
  scope: string;
  mode: string;
  entries_json: string;
  updated_at: string;
}

export interface AccessRule {
  scope: AccessScope;
  mode: AccessMode;
  entries: string[];
  updatedAt: string;
}

const DEFAULT_RULE: Omit<AccessRule, "scope"> = { mode: "open", entries: [], updatedAt: "" };

function toRule(scope: AccessScope, row: AccessRow | null): AccessRule {
  if (!row) return { scope, ...DEFAULT_RULE };
  const entries = parseJsonArray(row.entries_json) ?? [];
  const mode: AccessMode = row.mode === "allowlist" || row.mode === "denylist" ? row.mode : "open";
  return { scope, mode, entries, updatedAt: row.updated_at };
}

export function getAccessRule(scope: AccessScope): AccessRule {
  const row = getDb().query("SELECT * FROM access_rules WHERE scope = ?").get(scope) as AccessRow | null;
  return toRule(scope, row);
}

export function getAccessRules(): { proxy: AccessRule; console: AccessRule } {
  return { proxy: getAccessRule("proxy"), console: getAccessRule("console") };
}

export function setAccessRule(scope: AccessScope, mode: AccessMode, entries: string[]): AccessRule {
  const now = new Date().toISOString();
  getDb()
    .query(
      "INSERT INTO access_rules (scope, mode, entries_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET mode = excluded.mode, entries_json = excluded.entries_json, updated_at = excluded.updated_at"
    )
    .run(scope, mode, JSON.stringify(entries), now);
  return { scope, mode, entries, updatedAt: now };
}

// ─────────────────── IP / CIDR matching ──────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Expand "::" then parse eight 16-bit groups.
  let full = ip;
  if (full.includes("::")) {
    const [head, tail] = full.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    full = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups].join(":");
  }
  const groups = full.split(":");
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Validate a single IP or CIDR entry. Returns an error string or null when valid. */
export function validateAccessEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return "empty entry";
  const [address, bitsRaw] = trimmed.split("/");
  if (!address) return "missing address";

  const v4 = ipv4ToInt(address);
  if (v4 !== null) {
    if (bitsRaw === undefined) return null;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return "IPv4 prefix must be 0–32";
    return null;
  }

  const v6 = ipv6ToBigInt(address);
  if (v6 !== null) {
    if (bitsRaw === undefined) return null;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return "IPv6 prefix must be 0–128";
    return null;
  }

  return "not a valid IPv4/IPv6 address or CIDR";
}

function matchEntry(ip: string, entry: string): boolean {
  const [address, bitsRaw] = entry.split("/");
  if (!address) return false;

  // IPv4 path (incl. mapped ::ffff:a.b.c.d handled by caller normalization).
  const ipV4 = ipv4ToInt(ip);
  const entryV4 = ipv4ToInt(address);
  if (ipV4 !== null && entryV4 !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (bits === 0) return true;
    const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (ipV4 & mask) >>> 0 === (entryV4 & mask) >>> 0;
  }

  // IPv6 path.
  const ipV6 = ipv6ToBigInt(ip);
  const entryV6 = ipv6ToBigInt(address);
  if (ipV6 !== null && entryV6 !== null) {
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    if (bits === 0) return true;
    const mask = bits >= 128 ? (1n << 128n) - 1n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (ipV6 & mask) === (entryV6 & mask);
  }

  return false;
}

/** Normalize common representations (mapped v4, bracketed, port suffix). */
export function normalizeClientIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  }
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

/** Decide whether a client IP may access the given scope. */
export function checkAccess(scope: AccessScope, clientIp?: string): boolean {
  const rule = getAccessRule(scope);
  // Open mode or no entries configured → allow (fail-open by configuration).
  if (rule.mode === "open" || rule.entries.length === 0) return true;
  const ip = clientIp ? normalizeClientIp(clientIp) : "";
  const matched = ip !== "" && rule.entries.some((entry) => matchEntry(ip, entry.trim()));
  return rule.mode === "allowlist" ? matched : !matched;
}
