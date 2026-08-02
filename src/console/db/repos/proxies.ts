/**
 * Outbound proxy pool - CRUD + priority-ordered failover selection.
 * Deliberately mirrors `provider_accounts` (accounts.ts): same
 * priority/active/cooldown shape - the only structural difference is scope.
 * Provider accounts rotate *within one provider*; this pool is a single
 * global set (REQ: one proxy pool for every provider that isn't excluded),
 * so there is no per-provider dimension anywhere here.
 *
 * Password is stored as plaintext, same as provider account credentials -
 * only revealed on demand via a dedicated endpoint, masked everywhere else.
 */

import { getDb } from "../client";
import type { ProxyProtocol } from "../../../upstream/proxy/types";

/** Masked display hint: last 4 chars only, same convention as account credential_hint. */
function passwordHint(value: string): string {
  return `…${value.slice(-4)}`;
}

export interface ProxyRow {
  id: string;
  name: string;
  protocol: string;
  is_relay: number;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  priority: number;
  active: number;
  cooldown_until: string | null;
  cooldown_level: number;
  created_at: string;
  updated_at: string;
}

export interface ProxyRecord {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  isRelay: boolean;
  host: string;
  port: number;
  username: string | null;
  passwordHint: string | null;
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProxyProtocol,
    isRelay: Boolean(row.is_relay),
    host: row.host,
    port: row.port,
    username: row.username,
    passwordHint: row.password ? passwordHint(row.password) : null,
    priority: row.priority,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROWS_CACHE_TTL_MS = 1_000;
let rowsCache: { rows: ProxyRow[]; expiresAt: number } | null = null;

function clearRowsCache(): void {
  rowsCache = null;
}

function listRows(): ProxyRow[] {
  const now = Date.now();
  if (rowsCache && rowsCache.expiresAt > now) return rowsCache.rows;
  const rows = getDb().query("SELECT * FROM proxies ORDER BY priority ASC, name ASC").all() as ProxyRow[];
  rowsCache = { rows, expiresAt: now + ROWS_CACHE_TTL_MS };
  return rows;
}

export function listProxies(): ProxyRecord[] {
  return listRows().map(fromRow);
}

interface ProxyCursor { priority: number; name: string; id: string; }

function decodeCursor(cursor: string | undefined): ProxyCursor | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (parsed && typeof parsed === "object" && "priority" in parsed && "name" in parsed && "id" in parsed) {
      const value = parsed as Record<string, unknown>;
      if (typeof value.priority === "number" && typeof value.name === "string" && typeof value.id === "string") return { priority: value.priority, name: value.name, id: value.id };
    }
  } catch {
    // Invalid cursors behave as the first page.
  }
  return null;
}

function encodeCursor(row: ProxyRow): string {
  return btoa(JSON.stringify({ priority: row.priority, name: row.name, id: row.id }));
}

export interface ProxyPage { items: ProxyRecord[]; nextCursor: string | null; version: string; }

/** Version token changes whenever the proxy pool changes — lets the console short-circuit an unchanged poll. */
export function proxiesVersion(): string {
  const state = getDb().query("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at FROM proxies").get() as { count: number; updated_at: string };
  return `${state.count}:${state.updated_at}`;
}

/** Returns proxies using a stable, index-backed priority/name/id keyset (same contract as `listAccountsPage`). */
export function listProxiesPage(limit: number, cursor?: string): ProxyPage {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const after = decodeCursor(cursor);
  const rows = (after
    ? db.query("SELECT * FROM proxies WHERE (priority > ? OR (priority = ? AND (name > ? OR (name = ? AND id > ?)))) ORDER BY priority ASC, name ASC, id ASC LIMIT ?").all(after.priority, after.priority, after.name, after.name, after.id, boundedLimit + 1)
    : db.query("SELECT * FROM proxies ORDER BY priority ASC, name ASC, id ASC LIMIT ?").all(boundedLimit + 1)
  ) as ProxyRow[];
  const hasNext = rows.length > boundedLimit;
  const pageRows = hasNext ? rows.slice(0, boundedLimit) : rows;
  return { items: pageRows.map(fromRow), nextCursor: hasNext ? encodeCursor(pageRows.at(-1)!) : null, version: proxiesVersion() };
}

export function getProxy(id: string): ProxyRow | null {
  return getDb().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
}

interface NextPriorityRow { priority: number; }

export interface ParsedProxyUrl {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** Detects relay endpoints by their Vercel or Cloudflare Worker hostname. */
export function isProxyRelayHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".vercel.app") || normalized.endsWith(".workers.dev");
}

/** Derives a stable display-name prefix from an imported proxy hostname. */
export function proxyNamePrefix(host: string): string {
  const firstLabel = host.trim().toLowerCase().split(".")[0] ?? "";
  if (!firstLabel || firstLabel.includes(":")) return "proxy";
  return firstLabel.replace(/-[a-z0-9]{6,}(?=-|$)/i, "") || firstLabel;
}

/** Parses a full proxy URL and extracts optional URL credentials. */
export function parseProxyUrl(raw: string): ParsedProxyUrl | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "socks5:") return null;
    if (!url.hostname || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) return null;
    const protocol = url.protocol.slice(0, -1) as ProxyProtocol;
    let port = 1080;
    if (url.port) port = Number(url.port);
    else if (protocol === "http") port = 80;
    else if (protocol === "https") port = 443;
    return {
      protocol,
      host: url.hostname,
      port,
      username: url.username ? decodeURIComponent(url.username) : null,
      password: url.password ? decodeURIComponent(url.password) : null,
    };
  } catch {
    return null;
  }
}

/** Parses newline-separated proxy URLs, reporting invalid and duplicate lines. */
export function parseProxyImportText(text: string): { added: ParsedProxyUrl[]; skipped: Array<{ line: number; reason: string }> } {
  const added: ParsedProxyUrl[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const parsed = parseProxyUrl(line);
    if (!parsed) {
      skipped.push({ line: index + 1, reason: "invalid proxy URL (need http://, https:// or socks5://host:port)" });
      return;
    }
    if (seen.has(line)) {
      skipped.push({ line: index + 1, reason: "duplicate" });
      return;
    }
    seen.add(line);
    added.push(parsed);
  });
  return { added, skipped };
}

export function createProxy(input: {
  name: string;
  protocol: ProxyProtocol;
  isRelay?: boolean;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  priority?: number;
  active?: boolean;
}): { id: string; passwordHint: string | null } {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const active = input.active ?? true;
  const nextPriority = db.query("SELECT COALESCE(MAX(priority), 90) + 10 AS priority FROM proxies").get() as NextPriorityRow;
  const priority = typeof input.priority === "number" && Number.isFinite(input.priority) ? input.priority : nextPriority.priority;
  const password = input.password ?? null;
  const isRelay = input.isRelay === true || isProxyRelayHost(input.host);

  db.transaction(() => {
    db.query(
      "INSERT INTO proxies (id, name, protocol, is_relay, host, port, username, password, priority, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, input.name, input.protocol, isRelay ? 1 : 0, input.host, input.port, input.username ?? null, password, priority, active ? 1 : 0, now, now);
  })();
  clearRowsCache();

  return { id, passwordHint: password ? passwordHint(password) : null };
}

export function patchProxy(id: string, patch: {
  name?: string;
  protocol?: ProxyProtocol;
  isRelay?: boolean;
  host?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  priority?: number;
  active?: boolean;
}): void {
  const current = getProxy(id);
  if (!current) throw new Error("proxy not found");

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
  if (patch.protocol !== undefined) { fields.push("protocol = ?"); values.push(patch.protocol); }
  if (patch.host !== undefined) { fields.push("host = ?"); values.push(patch.host); }
  if (patch.isRelay !== undefined || patch.host !== undefined) {
    const isRelay = patch.isRelay === true || (patch.isRelay === undefined && patch.host !== undefined ? isProxyRelayHost(patch.host) : Boolean(current.is_relay));
    fields.push("is_relay = ?");
    values.push(isRelay ? 1 : 0);
  }
  if (patch.port !== undefined) { fields.push("port = ?"); values.push(patch.port); }
  if (patch.username !== undefined) { fields.push("username = ?"); values.push(patch.username); }
  if (patch.password !== undefined) { fields.push("password = ?"); values.push(patch.password); }
  if (patch.priority !== undefined) { fields.push("priority = ?"); values.push(patch.priority); }
  if (patch.active !== undefined) { fields.push("active = ?"); values.push(patch.active ? 1 : 0); }

  if (fields.length === 0) return;

  const now = new Date().toISOString();
  getDb().transaction(() => {
    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);
    getDb().query(`UPDATE proxies SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  })();
  clearRowsCache();
}

export function deleteProxy(id: string): boolean {
  const current = getProxy(id);
  if (!current) return false;
  const result = getDb().query("DELETE FROM proxies WHERE id = ?").run(id);
  if (result.changes > 0) {
    clearRowsCache();
    purgeProxyRoutingState(id);
  }
  return result.changes > 0;
}

function purgeProxyRoutingState(proxyId: string): void {
  cooldowns.delete(proxyId);
}

// ── Cooldown — identical shape/timing to account cooldown (C5) ────────────

interface ProxyCooldown { unavailableUntil: number; backoffLevel: number; }

const cooldowns = new Map<string, ProxyCooldown>();
interface StickyAssignment { proxyIds: string[]; currentIndex: number; }
const stickyAssignments = new Map<string, StickyAssignment>();
let rotationCursor = 0;
let cooldownsHydrated = false;

const COOLDOWN_BASE_MS = 2_000;
const COOLDOWN_MAX_MS = 5 * 60_000;
const COOLDOWN_MAX_LEVEL = 15;

/** Rebuilds the in-memory cooldown index from persisted state (call once at startup, same as accounts). */
export function hydrateProxyCooldownCache(): void {
  const db = getDb();
  const now = new Date().toISOString();
  cooldowns.clear();

  const rows = db.query("SELECT id, cooldown_until, cooldown_level FROM proxies WHERE cooldown_until > ?").all(now) as Array<{ id: string; cooldown_until: string; cooldown_level: number }>;
  for (const row of rows) cooldowns.set(row.id, { unavailableUntil: Date.parse(row.cooldown_until), backoffLevel: row.cooldown_level });

  db.query("UPDATE proxies SET cooldown_until = NULL, cooldown_level = 0 WHERE cooldown_until <= ?").run(now);
  cooldownsHydrated = true;
}

function ensureCooldownCache(): void {
  if (!cooldownsHydrated) hydrateProxyCooldownCache();
}

function isProxyCooledDown(proxyId: string): boolean {
  const cooldown = cooldowns.get(proxyId);
  return cooldown !== undefined && cooldown.unavailableUntil > Date.now();
}

/** Marks a proxy unavailable with bounded exponential backoff after a connection/handshake failure. */
export function markProxyUnavailable(proxyId: string): void {
  for (const [clientKey, assignment] of stickyAssignments) {
    const proxyIds = assignment.proxyIds.filter((id) => id !== proxyId);
    if (proxyIds.length === 0) stickyAssignments.delete(clientKey);
    else stickyAssignments.set(clientKey, { proxyIds, currentIndex: Math.min(assignment.currentIndex, proxyIds.length - 1) });
  }
  const existing = cooldowns.get(proxyId);
  const backoffLevel = Math.min((existing?.backoffLevel ?? -1) + 1, COOLDOWN_MAX_LEVEL);
  const unavailableUntil = Date.now() + Math.min(COOLDOWN_BASE_MS * Math.pow(2, backoffLevel), COOLDOWN_MAX_MS);
  cooldowns.set(proxyId, { unavailableUntil, backoffLevel });
  getDb().query("UPDATE proxies SET cooldown_until = ?, cooldown_level = ? WHERE id = ?").run(new Date(unavailableUntil).toISOString(), backoffLevel, proxyId);
}

export function clearProxyCooldown(proxyId: string): void {
  cooldowns.delete(proxyId);
  getDb().query("UPDATE proxies SET cooldown_until = NULL, cooldown_level = 0 WHERE id = ?").run(proxyId);
}

/** Get the shortest Retry-After seconds across all cooled-down proxies, or null if none are cooling down. */
export function getProxyRetryAfterSeconds(): number | null {
  ensureCooldownCache();
  let minRemaining = Infinity;
  for (const proxy of listRows()) {
    const cooldown = cooldowns.get(proxy.id);
    if (!cooldown) continue;
    const remaining = Math.ceil((cooldown.unavailableUntil - Date.now()) / 1000);
    if (remaining > 0 && remaining < minRemaining) minRemaining = remaining;
  }
  return minRemaining === Infinity ? null : minRemaining;
}

/**
 * Selects the highest-priority active proxy from the global pool, skipping
 * any in cooldown - failover to the next one happens automatically once the
 * top proxy lands in cooldown, since it's already excluded from `active`.
 * Priority order is auto-assigned by add order (see `createProxy`); there is
 * no separate strategy or sticky-affinity setting to configure.
 */
export function pickProxyForRotation(clientKey?: string, smartDynamicRouting = false, stickyProxyCount = 2): ProxyRow | null {
  ensureCooldownCache();
  const active = listRows().filter((proxy) => Boolean(proxy.active) && !isProxyCooledDown(proxy.id));
  if (active.length === 0) return null;
  if (!smartDynamicRouting || !clientKey) return active[0] ?? null;

  const assignment = stickyAssignments.get(clientKey);
  if (assignment) {
    const currentId = assignment.proxyIds[assignment.currentIndex];
    const current = active.find((proxy) => proxy.id === currentId);
    if (current) return current;
    const activeIds = new Set(active.map((proxy) => proxy.id));
    const proxyIds = assignment.proxyIds.filter((id) => activeIds.has(id));
    if (proxyIds.length > 0) {
      const next = { proxyIds, currentIndex: Math.min(assignment.currentIndex, proxyIds.length - 1) };
      stickyAssignments.set(clientKey, next);
      return active.find((proxy) => proxy.id === next.proxyIds[next.currentIndex]) ?? null;
    }
    stickyAssignments.delete(clientKey);
  }

  const count = Math.max(1, Math.min(Math.floor(stickyProxyCount), active.length));
  const assignedIds = new Set([...stickyAssignments.values()].flatMap((item) => item.proxyIds));
  const available = active.filter((proxy) => !assignedIds.has(proxy.id));
  const candidates = available.length >= count ? available : active;
  const proxyIds = Array.from({ length: count }, (_, index) => candidates[(rotationCursor + index) % candidates.length]?.id).filter((id): id is string => id !== undefined);
  rotationCursor = (rotationCursor + count) % candidates.length;
  const next = { proxyIds, currentIndex: 0 };
  stickyAssignments.set(clientKey, next);
  return active.find((proxy) => proxy.id === proxyIds[0]) ?? null;
}

/** Advances a client's sticky assignment after a provider rate limit. */
export function rotateSmartProxyAssignment(clientKey?: string): void {
  if (!clientKey) return;
  const assignment = stickyAssignments.get(clientKey);
  if (!assignment || assignment.proxyIds.length === 0) return;
  if (assignment.currentIndex < assignment.proxyIds.length - 1) {
    assignment.currentIndex += 1;
    return;
  }

  ensureCooldownCache();
  const active = listRows().filter((proxy) => Boolean(proxy.active) && !isProxyCooledDown(proxy.id));
  const ownIds = new Set(assignment.proxyIds);
  const assignedToOthers = new Set([...stickyAssignments.entries()]
    .filter(([key]) => key !== clientKey)
    .flatMap(([, value]) => value.proxyIds));
  const available = active.filter((proxy) => !ownIds.has(proxy.id) && !assignedToOthers.has(proxy.id));
  const candidates = available.length > 0
    ? available
    : active.filter((proxy) => !ownIds.has(proxy.id));
  if (candidates.length === 0) {
    assignment.currentIndex = 0;
    return;
  }
  const count = Math.min(assignment.proxyIds.length, candidates.length);
  const proxyIds = Array.from({ length: count }, (_, index) => candidates[(rotationCursor + index) % candidates.length]?.id).filter((id): id is string => id !== undefined);
  rotationCursor = (rotationCursor + count) % candidates.length;
  stickyAssignments.set(clientKey, { proxyIds, currentIndex: 0 });
}

/** Test-only: clear all cooldown state between isolated databases. */
export function resetProxyRoutingForTests(): void {
  cooldowns.clear();
  stickyAssignments.clear();
  rotationCursor = 0;
  cooldownsHydrated = false;
  clearRowsCache();
}
