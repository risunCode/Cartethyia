/**
 * Combos + aliases + filters — CRUD + evaluation (REQ-21, design §5.6).
 *
 * Order: qualified prefix → alias expansion → combo resolution → filter check.
 */

import { getDb } from "../client";
import type { RotationStrategy } from "../../../routing/strategy";
import { TtlCache } from "../ttl-cache";

// resolveAlias/getComboByName/listFilters (via evaluateFilter) all run on
// every proxied request that uses a legacy alias/combo/filtered model. 5s TTL
// caches, cleared immediately on the matching mutation, turn that into a
// SQLite read only once every 5s per key instead of once per request.
const aliasCache = new TtlCache<string, string | null>(5_000);
const comboCache = new TtlCache<string, ComboRecord | null>(5_000);
const filterListCache = new TtlCache<string, FilterRecord[]>(5_000);

export type FilterMode = "allow" | "deny";

interface AliasRow {
  alias: string;
  model: string;
  created_at: string;
}

export interface AliasRecord {
  alias: string;
  model: string;
  createdAt: string;
}

export function listAliases(): AliasRecord[] {
  const rows = getDb().query("SELECT * FROM model_aliases ORDER BY alias ASC").all() as AliasRow[];
  return rows.map((r) => ({ alias: r.alias, model: r.model, createdAt: r.created_at }));
}

export function upsertAlias(alias: string, model: string): boolean {
  if (!alias.trim()) return false;
  aliasCache.clear();
  getDb()
    .query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET model = excluded.model")
    .run(alias.trim(), model, new Date().toISOString());
  return true;
}

export function deleteAlias(alias: string): boolean {
  aliasCache.clear();
  const result = getDb().query("DELETE FROM model_aliases WHERE alias = ?").run(alias);
  return result.changes > 0;
}

export function resolveAlias(model: string): string | null {
  return aliasCache.get(model, () => {
    const row = getDb().query("SELECT model FROM model_aliases WHERE alias = ?").get(model) as AliasRow | null;
    return row?.model ?? null;
  });
}

// ─────────────────── Combos ──────────────────────────────────────

export interface ComboRow {
  id: string;
  name: string;
  models_json: string;
  strategy: string;
  sticky_limit: number;
  created_at: string;
  updated_at: string;
}

export interface ComboRecord {
  id: string;
  name: string;
  models: string[];
  strategy: RotationStrategy;
  stickyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateComboInput {
  name: string;
  models: string[];
  strategy: RotationStrategy;
  stickyLimit: number;
}

function toCombo(row: ComboRow): ComboRecord {
  let models: string[] = [];
  try {
    models = JSON.parse(row.models_json) as string[];
  } catch {
    // corrupt JSON → empty model list
  }
  const strategy: ComboRecord["strategy"] = row.strategy === "round-robin" ? "round-robin" : "fallback";
  return { id: row.id, name: row.name, models, strategy, stickyLimit: row.sticky_limit, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listCombos(): ComboRecord[] {
  const rows = getDb().query("SELECT * FROM combos ORDER BY name ASC").all() as ComboRow[];
  return rows.map(toCombo);
}

export function getComboByName(name: string): ComboRecord | null {
  return comboCache.get(name, () => {
    const row = getDb().query("SELECT * FROM combos WHERE name = ?").get(name) as ComboRow | null;
    return row ? toCombo(row) : null;
  });
}

export function createCombo(input: CreateComboInput): ComboRecord {
  comboCache.clear();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().query(
    "INSERT INTO combos (id, name, models_json, strategy, sticky_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.name.trim(), JSON.stringify(input.models), input.strategy, Math.max(0, Math.floor(input.stickyLimit)), now, now);
  return toCombo({ id, name: input.name.trim(), models_json: JSON.stringify(input.models), strategy: input.strategy, sticky_limit: Math.max(0, Math.floor(input.stickyLimit)), created_at: now, updated_at: now });
}

export function updateCombo(id: string, patch: Partial<CreateComboInput>): boolean {
  comboCache.clear();
  const cols: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) { cols.push("name = ?"); vals.push(patch.name.trim()); }
  if (patch.models !== undefined) { cols.push("models_json = ?"); vals.push(JSON.stringify(patch.models)); }
  if (patch.strategy !== undefined) { cols.push("strategy = ?"); vals.push(patch.strategy); }
  if (patch.stickyLimit !== undefined) { cols.push("sticky_limit = ?"); vals.push(Math.max(0, Math.floor(patch.stickyLimit))); }
  if (cols.length === 0) return false;
  cols.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  getDb().query(`UPDATE combos SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteCombo(id: string): boolean {
  comboCache.clear();
  const result = getDb().query("DELETE FROM combos WHERE id = ?").run(id);
  return result.changes > 0;
}


// ─────────────────── Filters ─────────────────────────────────────

export interface FilterRow {
  id: string;
  provider: string;
  mode: string;
  patterns_json: string;
  created_at: string;
  updated_at: string;
}

export interface FilterRecord {
  id: string;
  provider: string;
  mode: FilterMode;
  patterns: string[]; // exact or suffix wildcard (e.g., "kimchi/*")
  createdAt: string;
  updatedAt: string;
}

export function listFilters(provider?: string): FilterRecord[] {
  return filterListCache.get(provider ?? "*", () => {
    const rows = (
      provider
        ? getDb().query("SELECT * FROM filter_rules WHERE provider = ? ORDER BY id ASC").all(provider)
        : getDb().query("SELECT * FROM filter_rules ORDER BY provider ASC, id ASC").all()
    ) as FilterRow[];
    return rows.map((r) => {
      let patterns: string[] = [];
      try {
        patterns = JSON.parse(r.patterns_json) as string[];
      } catch {
        // keep empty
      }
      const mode: FilterMode = r.mode === "deny" ? "deny" : "allow";
      return { id: r.id, provider: r.provider, mode, patterns, createdAt: r.created_at, updatedAt: r.updated_at };
    });
  });
}

export function createFilter(provider: string, mode: FilterMode, patterns: string[]): FilterRecord {
  filterListCache.clear();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().query(
    "INSERT INTO filter_rules (id, provider, mode, patterns_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, provider, mode, JSON.stringify(patterns), now, now);
  return { id, provider, mode, patterns, createdAt: now, updatedAt: now };
}

export function updateFilter(id: string, patch: Partial<{ provider?: string; mode?: FilterMode; patterns?: string[] }>): boolean {
  filterListCache.clear();
  const cols: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.provider !== undefined) { cols.push("provider = ?"); vals.push(patch.provider); }
  if (patch.mode !== undefined) { cols.push("mode = ?"); vals.push(patch.mode); }
  if (patch.patterns !== undefined) { cols.push("patterns_json = ?"); vals.push(JSON.stringify(patch.patterns)); }
  if (cols.length === 0) return false;
  cols.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  getDb().query(`UPDATE filter_rules SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return true;
}

export function deleteFilter(id: string): boolean {
  filterListCache.clear();
  const result = getDb().query("DELETE FROM filter_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Test-only: drop cached alias/combo/filter lookups so isolated test databases don't leak into each other. */
export function resetComboCachesForTests(): void {
  aliasCache.clear();
  comboCache.clear();
  filterListCache.clear();
}

/**
 * Evaluate filter rules for a provider/model (REQ-21).
 * Semantics: any matching deny rule denies; if allow rules exist for the
 * provider, at least one must match; otherwise allowed.
 */
export function evaluateFilter(provider: string, modelId: string): { result: "allowed" | "denied"; reason?: string } {
  const rules = listFilters(provider).filter((f) => f.provider === provider);
  if (rules.length === 0) return { result: "allowed" };

  const matches = (pattern: string, id: string): boolean => {
    if (pattern.endsWith("*")) return id.startsWith(pattern.slice(0, -1));
    return pattern === id;
  };

  const denyRules = rules.filter((r) => r.mode === "deny");
  for (const rule of denyRules) {
    if (rule.patterns.some((p) => matches(p, modelId))) {
      return { result: "denied", reason: `denied by filter rule ${rule.id}` };
    }
  }

  const allowRules = rules.filter((r) => r.mode === "allow");
  if (allowRules.length > 0) {
    const allowed = allowRules.some((rule) => rule.patterns.some((p) => matches(p, modelId)));
    if (!allowed) return { result: "denied", reason: "not matched by any allow rule" };
  }

  return { result: "allowed" };
}
