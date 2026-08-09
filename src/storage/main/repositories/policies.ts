import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import type { FilterRuleRepository, IpBanRepository, IpBanView } from "../../../console/views";

interface FilterRuleRow {
  id: number;
  rule_id: string;
  pattern: string;
  replacement: string;
  is_active: number;
  is_regex: number;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
}

export function createFilterRuleRepository(db: () => Database): FilterRuleRepository { const toView = (row: FilterRuleRow) => ({
  id: row.id,
  ruleId: row.rule_id,
  pattern: row.pattern,
  replacement: row.replacement,
  isActive: row.is_active === 1,
  isRegex: row.is_regex === 1,
  sortOrder: row.sort_order,
});

return {
  async list() {
    const rows = db().query("SELECT * FROM filter_rules ORDER BY sort_order ASC, id ASC").all() as FilterRuleRow[];
    return rows.map(toView);
  },
  listSync() {
    const rows = db().query("SELECT * FROM filter_rules ORDER BY sort_order ASC, id ASC").all() as FilterRuleRow[];
    return rows.map(toView);
  },

  async create(input) {
    const pattern = input.pattern.trim();
    if (!pattern) throw new Error("pattern is required");
    // Validate regex if applicable
    if (input.isRegex !== false) {
      try { new RegExp(pattern, "gi"); } catch { throw new Error("invalid regex pattern"); }
    }
    const maxRow = db().query("SELECT COALESCE(MAX(sort_order), 0) as max_order FROM filter_rules").get() as { max_order: number };
    const sortOrder = maxRow.max_order + 1;
    const ruleId = typeof input.ruleId === "string" && input.ruleId.trim().length > 0 ? input.ruleId.trim() : `rule_${crypto.randomUUID().slice(0, 8)}`;
    const now = nowIso();
    db().query(
      "INSERT INTO filter_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      ruleId,
      pattern,
      input.replacement ?? "",
      input.isActive === false ? 0 : 1,
      input.isRegex === false ? 0 : 1,
      sortOrder,
      now,
    );
    const row = db().query("SELECT * FROM filter_rules WHERE rule_id = ?").get(ruleId) as FilterRuleRow;
    return toView(row);
  },

  async update(id, patch) {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.pattern !== undefined) {
      const trimmed = patch.pattern.trim();
      if (!trimmed) throw new Error("pattern cannot be empty");
      sets.push("pattern = ?"); params.push(trimmed);
    }
    if (patch.replacement !== undefined) { sets.push("replacement = ?"); params.push(patch.replacement); }
    if (patch.isRegex !== undefined) {
      if (patch.isRegex) { try { new RegExp(patch.pattern ?? "", "gi"); } catch { throw new Error("invalid regex pattern"); } }
      sets.push("is_regex = ?"); params.push(patch.isRegex ? 1 : 0);
    }
    if (patch.isActive !== undefined) { sets.push("is_active = ?"); params.push(patch.isActive ? 1 : 0); }
    if (patch.sortOrder !== undefined) { sets.push("sort_order = ?"); params.push(patch.sortOrder); }
    if (sets.length === 0) {
      const row = db().query("SELECT * FROM filter_rules WHERE id = ?").get(id) as FilterRuleRow | null;
      return row ? toView(row) : null;
    }
    sets.push("updated_at = ?"); params.push(nowIso());
    params.push(id);
    const result = db().query(`UPDATE filter_rules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (result.changes === 0) return null;
    const row = db().query("SELECT * FROM filter_rules WHERE id = ?").get(id) as FilterRuleRow;
    return toView(row);
  },

  async remove(id) {
    const result = db().query("DELETE FROM filter_rules WHERE id = ?").run(id);
    return result.changes > 0;
  },
}; }

// ───────────────────── IP bans ──────────────────────────────────────────────

export function createIpBanRepository(db: () => Database): IpBanRepository { const toView = (row: { ip: string; reason: string; created_at: string }): IpBanView => ({
  ip: row.ip,
  reason: row.reason,
  createdAt: row.created_at,
});

return {
  async list(): Promise<readonly IpBanView[]> {
    const rows = db().query("SELECT ip, reason, created_at FROM ip_bans ORDER BY created_at DESC").all() as { ip: string; reason: string; created_at: string }[];
    return rows.map(toView);
  },

  async add(ip: string, reason = ""): Promise<IpBanView> {
    const now = nowIso();
    db().query("INSERT INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at").run(ip, reason, now);
    return { ip, reason, createdAt: now };
  },

  async remove(ip: string): Promise<boolean> {
    const result = db().query("DELETE FROM ip_bans WHERE ip = ?").run(ip);
    return result.changes > 0;
  },

  async isBanned(ip: string): Promise<boolean> {
    return db().query("SELECT 1 FROM ip_bans WHERE ip = ?").get(ip) !== null;
  },

  async bannedSet(): Promise<ReadonlySet<string>> {
    const rows = db().query("SELECT ip FROM ip_bans").all() as { ip: string }[];
    return new Set(rows.map((row) => row.ip));
  },
}; }
