/**
 * Proxy pools — CRUD, entry validation, text import and per-entry testing
 * (REQ-14, design §5.7). Schemes: http://, https://, socks5:// (optional user:pass@).
 */

import { getDb } from "../client";
import { assertPublicUrl } from "../../../http/ssrf-guard";

export interface ProxyEntry {
  url: string;
  scheme: "http" | "https" | "socks5";
}

export type PoolPlatform = "custom" | "cloudflare" | "vercel";

interface PoolRow {
  id: string;
  name: string;
  entries_json: string;
  no_proxy: string;
  strict_proxy: number;
  platform: string;
  created_at: string;
  updated_at: string;
}

export interface PoolRecord {
  id: string;
  name: string;
  entries: ProxyEntry[];
  noProxy: string;
  strictProxy: boolean;
  platform: PoolPlatform;
  createdAt: string;
  updatedAt: string;
}

const SCHEME_PATTERN = /^(https?|socks5):\/\/(?:[^@/]+@)?[^/]+/;

/** Validate + normalize one proxy URL. Returns null when invalid or SSRF-blocked. */
export function parseProxyUrl(raw: string): ProxyEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = SCHEME_PATTERN.exec(trimmed);
  if (!match) return null;
  const scheme = match[1];
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") return null;
  try {
    // URL parsing sanity check (socks5 is understood by the URL constructor).
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return null;
    // SSRF guard — reject private/loopback/link-local/metadata IPs
    assertPublicUrl(trimmed, "proxy URL");
  } catch {
    return null;
  }
  return { url: trimmed, scheme };
}

function parseEntries(json: string): ProxyEntry[] {
  try {
    const parsed = JSON.parse(json) as ProxyEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toRecord(row: PoolRow): PoolRecord {
  return {
    id: row.id,
    name: row.name,
    entries: parseEntries(row.entries_json),
    noProxy: row.no_proxy,
    strictProxy: row.strict_proxy === 1,
    platform: (row.platform || "custom") as PoolPlatform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPools(): PoolRecord[] {
  const rows = getDb().query("SELECT * FROM proxy_pools ORDER BY name ASC").all() as PoolRow[];
  return rows.map(toRecord);
}

export function getPool(id: string): PoolRecord | null {
  const row = getDb().query("SELECT * FROM proxy_pools WHERE id = ?").get(id) as PoolRow | null;
  return row ? toRecord(row) : null;
}

export interface PoolInput {
  name: string;
  entries: ProxyEntry[];
  noProxy?: string;
  strictProxy?: boolean;
  platform?: PoolPlatform;
}

export function createPool(input: PoolInput): PoolRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO proxy_pools (id, name, entries_json, no_proxy, strict_proxy, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name.trim(), JSON.stringify(input.entries), input.noProxy ?? "", input.strictProxy ? 1 : 0, input.platform ?? "custom", now, now);
  return getPool(id)!;
}

export function updatePool(id: string, patch: Partial<PoolInput>): boolean {
  const cols: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) {
    cols.push("name = ?");
    vals.push(patch.name.trim());
  }
  if (patch.entries !== undefined) {
    cols.push("entries_json = ?");
    vals.push(JSON.stringify(patch.entries));
  }
  if (patch.noProxy !== undefined) {
    cols.push("no_proxy = ?");
    vals.push(patch.noProxy);
  }
  if (patch.strictProxy !== undefined) {
    cols.push("strict_proxy = ?");
    vals.push(patch.strictProxy ? 1 : 0);
  }
  if (patch.platform !== undefined) {
    cols.push("platform = ?");
    vals.push(patch.platform);
  }
  if (cols.length === 0) return false;
  cols.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  getDb().query(`UPDATE proxy_pools SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deletePool(id: string): boolean {
  const result = getDb().query("DELETE FROM proxy_pools WHERE id = ?").run(id);
  return result.changes > 0;
}

// ─────────────────── Import ──────────────────────────────────────

export interface ImportResult {
  added: ProxyEntry[];
  skipped: { line: number; reason: string }[];
}

/** Parse "one proxy per line" text, validating scheme per line. */
export function parseImportText(text: string): ImportResult {
  const added: ProxyEntry[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const entry = parseProxyUrl(line);
    if (!entry) {
      skipped.push({ line: index + 1, reason: "invalid proxy URL (need http://, https:// or socks5://)" });
      return;
    }
    if (seen.has(entry.url)) {
      skipped.push({ line: index + 1, reason: "duplicate" });
      return;
    }
    seen.add(entry.url);
    added.push(entry);
  });
  return { added, skipped };
}

// ─────────────────── Test ────────────────────────────────────────

export interface EntryTestResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  status: number | null;
  error?: string;
}

const TEST_TARGET = "https://www.google.com/generate_204";
const RELAY_TEST_TARGET = "https://httpbin.org";
const TEST_TIMEOUT_MS = 10_000;

/**
 * Probe one proxy entry. For HTTP/HTTPS/SOCKS5 proxies, fetches through the
 * proxy. For relay URLs (Vercel/Cloudflare), sends a relay-style request
 * with x-relay-target/x-relay-path headers to verify the relay is alive.
 */
export async function testProxyEntry(url: string, isRelay = false): Promise<EntryTestResult> {
  const started = performance.now();
  try {
    let res: Response;
    if (isRelay) {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "x-relay-target": RELAY_TEST_TARGET,
          "x-relay-path": "/get",
        },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } else {
      res = await fetch(TEST_TARGET, {
        proxy: url,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        redirect: "follow",
      });
    }
    const latencyMs = Math.round(performance.now() - started);
    await res.arrayBuffer();
    return { url, ok: res.ok, latencyMs, status: res.status };
  } catch (err) {
    return {
      url,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function testPool(id: string): Promise<EntryTestResult[] | null> {
  const pool = getPool(id);
  if (!pool) return null;
  const isRelay = pool.platform === "vercel" || pool.platform === "cloudflare";
  return Promise.all(pool.entries.map((entry) => testProxyEntry(entry.url, isRelay)));
}
