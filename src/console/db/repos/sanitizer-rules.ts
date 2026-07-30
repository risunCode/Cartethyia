/**
 * Sanitizer rules — pattern-based outbound-text sanitizer ("Filter Rules" in
 * the console UI, REQ-9). Strips/replaces client-identifying strings (e.g.
 * "Claude Code" boilerplate, GitHub Copilot markers) from outbound requests
 * before dispatch, so upstream providers are less likely to fingerprint
 * automated coding-agent traffic.
 *
 * Built-in defaults live in `default-sanitizer-rules.ts` and are never seeded
 * into SQLite. The `sanitizer_rules` table stores operator overrides for
 * built-ins and fully custom rules only.
 *
 * Named `sanitizer_rules` (not `filter_rules`) to avoid colliding with the
 * existing, unrelated `filter_rules` table (combo model-eligibility allow/deny,
 * `console/db/repos/combos.ts`) that already owns that name in this codebase.
 */

import { getDb } from "../client";
import type { SanitizerFilterRule } from "../../../upstream/outbound";
import {
  builtinRuleIdFromSyntheticId,
  builtinSanitizerRule,
  DEFAULT_SANITIZER_RULES,
  isBuiltinSanitizerRuleId,
  syntheticBuiltinRuleId,
} from "../../default-sanitizer-rules";

interface SanitizerRuleRow {
  id: number;
  rule_id: string;
  pattern: string;
  replacement: string;
  is_active: number;
  is_regex: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SanitizerRuleRecord {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  builtin: boolean;
}

export interface SanitizerRuleInput {
  ruleId: string;
  pattern: string;
  replacement?: string;
  isActive?: boolean;
  isRegex?: boolean;
  sortOrder?: number;
}

export class InvalidPatternError extends Error {
  constructor(pattern: string) {
    super(`"${pattern}" is not a valid regular expression`);
  }
}

export class ReservedBuiltinRuleIdError extends Error {
  constructor(ruleId: string) {
    super(`"${ruleId}" is a built-in rule id — toggle or override it instead of creating a duplicate`);
  }
}

function validatePattern(pattern: string, isRegex: boolean): void {
  if (!isRegex) return;
  try {
    new RegExp(pattern);
  } catch {
    throw new InvalidPatternError(pattern);
  }
}

function toRecord(row: SanitizerRuleRow, builtin = false): SanitizerRuleRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    pattern: row.pattern,
    replacement: row.replacement,
    isActive: row.is_active === 1,
    isRegex: row.is_regex === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    builtin,
  };
}

function getSanitizerRuleRowByRuleId(ruleId: string): SanitizerRuleRow | null {
  return getDb().query("SELECT * FROM sanitizer_rules WHERE rule_id = ?").get(ruleId) as SanitizerRuleRow | null;
}

/** Raw DB rows only — operator overrides and custom rules. */
export function listSanitizerRules(): SanitizerRuleRecord[] {
  const rows = getDb().query("SELECT * FROM sanitizer_rules ORDER BY sort_order ASC, id ASC").all() as SanitizerRuleRow[];
  return rows.map((row) => toRecord(row, isBuiltinSanitizerRuleId(row.rule_id)));
}

function mergeBuiltinRule(index: number, override: SanitizerRuleRow | null): SanitizerRuleRecord {
  const builtin = DEFAULT_SANITIZER_RULES[index]!;
  return {
    id: override?.id ?? syntheticBuiltinRuleId(index),
    ruleId: builtin.ruleId,
    pattern: override?.pattern ?? builtin.pattern,
    replacement: override?.replacement ?? builtin.replacement,
    isActive: override ? override.is_active === 1 : true,
    isRegex: override ? override.is_regex === 1 : builtin.isRegex,
    sortOrder: override?.sort_order ?? index,
    createdAt: override?.created_at ?? "",
    updatedAt: override?.updated_at ?? "",
    builtin: true,
  };
}

/** Built-in defaults merged with DB overrides plus custom rules — for the console API. */
export function listEffectiveSanitizerRules(): SanitizerRuleRecord[] {
  const dbRules = listSanitizerRules();
  const dbByRuleId = new Map(dbRules.map((rule) => [rule.ruleId, rule]));
  const builtins = DEFAULT_SANITIZER_RULES.map((_, index) => mergeBuiltinRule(index, getSanitizerRuleRowByRuleId(DEFAULT_SANITIZER_RULES[index]!.ruleId)));
  const custom = dbRules.filter((rule) => !rule.builtin);
  return [...builtins, ...custom].sort((a, b) => a.sortOrder - b.sortOrder || a.ruleId.localeCompare(b.ruleId));
}

/** Active rules for the outbound hot path — defaults from code, overrides from DB. */
export function resolveEffectiveFilterRules(): SanitizerFilterRule[] {
  const dbRules = listSanitizerRules();
  const dbByRuleId = new Map(dbRules.map((rule) => [rule.ruleId, rule]));
  const rules: SanitizerFilterRule[] = [];

  for (const builtin of DEFAULT_SANITIZER_RULES) {
    const override = dbByRuleId.get(builtin.ruleId);
    if (override && !override.isActive) continue;
    rules.push({
      pattern: override?.pattern ?? builtin.pattern,
      replacement: override?.replacement ?? builtin.replacement,
      isRegex: override?.isRegex ?? builtin.isRegex,
    });
  }

  for (const custom of dbRules) {
    if (custom.builtin || !custom.isActive) continue;
    rules.push({ pattern: custom.pattern, replacement: custom.replacement, isRegex: custom.isRegex });
  }

  return rules;
}

function insertSanitizerRuleRow(input: SanitizerRuleInput): SanitizerRuleRecord {
  validatePattern(input.pattern, input.isRegex ?? false);
  const now = new Date().toISOString();
  const result = getDb()
    .query(
      "INSERT INTO sanitizer_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.ruleId, input.pattern, input.replacement ?? "", input.isActive === false ? 0 : 1, input.isRegex ? 1 : 0, input.sortOrder ?? 0, now, now);
  const row = getDb().query("SELECT * FROM sanitizer_rules WHERE id = ?").get(Number(result.lastInsertRowid)) as SanitizerRuleRow;
  return toRecord(row, isBuiltinSanitizerRuleId(row.rule_id));
}

export function createSanitizerRule(input: SanitizerRuleInput): SanitizerRuleRecord {
  if (isBuiltinSanitizerRuleId(input.ruleId)) throw new ReservedBuiltinRuleIdError(input.ruleId);
  return insertSanitizerRuleRow(input);
}

export function getSanitizerRuleById(id: number): SanitizerRuleRecord | null {
  if (id < 0) {
    const ruleId = builtinRuleIdFromSyntheticId(id);
    if (!ruleId) return null;
    const index = DEFAULT_SANITIZER_RULES.findIndex((rule) => rule.ruleId === ruleId);
    if (index < 0) return null;
    return mergeBuiltinRule(index, getSanitizerRuleRowByRuleId(ruleId));
  }
  const row = getDb().query("SELECT * FROM sanitizer_rules WHERE id = ?").get(id) as SanitizerRuleRow | null;
  return row ? toRecord(row, isBuiltinSanitizerRuleId(row.rule_id)) : null;
}

export function upsertBuiltinSanitizerOverride(
  ruleId: string,
  patch: Partial<Pick<SanitizerRuleInput, "pattern" | "replacement" | "isActive" | "isRegex" | "sortOrder">>,
): SanitizerRuleRecord {
  const builtin = builtinSanitizerRule(ruleId);
  if (!builtin) throw new Error(`unknown built-in sanitizer rule: ${ruleId}`);

  const existing = getSanitizerRuleRowByRuleId(ruleId);
  if (existing) {
    return updateSanitizerRule(existing.id, patch)!;
  }

  const index = DEFAULT_SANITIZER_RULES.findIndex((rule) => rule.ruleId === ruleId);
  return insertSanitizerRuleRow({
    ruleId,
    pattern: patch.pattern ?? builtin.pattern,
    replacement: patch.replacement ?? builtin.replacement,
    isActive: patch.isActive ?? true,
    isRegex: patch.isRegex ?? builtin.isRegex,
    sortOrder: patch.sortOrder ?? index,
  });
}

export function updateSanitizerRule(id: number, patch: Partial<SanitizerRuleInput>): SanitizerRuleRecord | null {
  if (id < 0) {
    const ruleId = builtinRuleIdFromSyntheticId(id);
    if (!ruleId) return null;
    return upsertBuiltinSanitizerOverride(ruleId, patch);
  }

  if (patch.pattern !== undefined || patch.isRegex !== undefined) {
    const existing = getSanitizerRuleById(id);
    if (!existing) return null;
    validatePattern(patch.pattern ?? existing.pattern, patch.isRegex ?? existing.isRegex);
  }
  const cols: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.pattern !== undefined) { cols.push("pattern = ?"); vals.push(patch.pattern); }
  if (patch.replacement !== undefined) { cols.push("replacement = ?"); vals.push(patch.replacement); }
  if (patch.isActive !== undefined) { cols.push("is_active = ?"); vals.push(patch.isActive ? 1 : 0); }
  if (patch.isRegex !== undefined) { cols.push("is_regex = ?"); vals.push(patch.isRegex ? 1 : 0); }
  if (patch.sortOrder !== undefined) { cols.push("sort_order = ?"); vals.push(patch.sortOrder); }
  if (cols.length === 0) return getSanitizerRuleById(id);
  cols.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  getDb().query(`UPDATE sanitizer_rules SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return getSanitizerRuleById(id);
}

export function deleteSanitizerRule(id: number): boolean {
  if (id < 0) {
    const ruleId = builtinRuleIdFromSyntheticId(id);
    if (!ruleId) return false;
    const existing = getSanitizerRuleRowByRuleId(ruleId);
    if (!existing) return false;
    return getDb().query("DELETE FROM sanitizer_rules WHERE id = ?").run(existing.id).changes > 0;
  }
  const result = getDb().query("DELETE FROM sanitizer_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function resetBuiltinSanitizerOverride(ruleId: string): boolean {
  const existing = getSanitizerRuleRowByRuleId(ruleId);
  if (!existing) return false;
  return getDb().query("DELETE FROM sanitizer_rules WHERE id = ?").run(existing.id).changes > 0;
}
