/**
 * Sanitizer rules — pattern-based outbound-text sanitizer ("Filter Rules" in
 * the console UI, REQ-9). Strips/replaces client-identifying strings (e.g.
 * "Claude Code" boilerplate, GitHub Copilot markers) from outbound requests
 * before dispatch, so upstream providers are less likely to fingerprint
 * automated coding-agent traffic.
 *
 * Named `sanitizer_rules` (not `filter_rules`) to avoid colliding with the
 * existing, unrelated `filter_rules` table (combo model-eligibility allow/deny,
 * `console/db/repos/combos.ts`) that already owns that name in this codebase.
 */

import { getDb } from "../client";

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

function validatePattern(pattern: string, isRegex: boolean): void {
  if (!isRegex) return;
  try {
    new RegExp(pattern);
  } catch {
    throw new InvalidPatternError(pattern);
  }
}

function toRecord(row: SanitizerRuleRow): SanitizerRuleRecord {
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
  };
}

export function listSanitizerRules(): SanitizerRuleRecord[] {
  const rows = getDb().query("SELECT * FROM sanitizer_rules ORDER BY sort_order ASC, id ASC").all() as SanitizerRuleRow[];
  return rows.map(toRecord);
}

/** Active rules only, in application order — what `applyFilterRules` (outbound.ts) consumes. */
export function listActiveSanitizerRules(): SanitizerRuleRecord[] {
  return listSanitizerRules().filter((r) => r.isActive);
}

export function createSanitizerRule(input: SanitizerRuleInput): SanitizerRuleRecord {
  validatePattern(input.pattern, input.isRegex ?? false);
  const now = new Date().toISOString();
  const result = getDb()
    .query(
      "INSERT INTO sanitizer_rules (rule_id, pattern, replacement, is_active, is_regex, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(input.ruleId, input.pattern, input.replacement ?? "", input.isActive === false ? 0 : 1, input.isRegex ? 1 : 0, input.sortOrder ?? 0, now, now);
  return getSanitizerRuleById(Number(result.lastInsertRowid))!;
}

export function getSanitizerRuleById(id: number): SanitizerRuleRecord | null {
  const row = getDb().query("SELECT * FROM sanitizer_rules WHERE id = ?").get(id) as SanitizerRuleRow | null;
  return row ? toRecord(row) : null;
}

export function updateSanitizerRule(id: number, patch: Partial<SanitizerRuleInput>): SanitizerRuleRecord | null {
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
  const result = getDb().query("DELETE FROM sanitizer_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

// ─────────────────── Default seed set ──────────────────────────────────
// Mirrors etteum-pool's PUDIDIL_FILTERS (Public/etteum-pool/src/proxy/filters.ts).

const DEFAULT_RULES: Array<Omit<SanitizerRuleInput, "sortOrder">> = [
  { ruleId: "billing-header", pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*", replacement: "", isRegex: true },
  { ruleId: "cc-entrypoint", pattern: "cc_entrypoint=\\w+", replacement: "", isRegex: true },
  { ruleId: "cc-version", pattern: "cc_version=[\\w.]+", replacement: "", isRegex: true },
  { ruleId: "cc-hash", pattern: "c?ch=[a-f0-9]+", replacement: "", isRegex: true },
  { ruleId: "claude-code-github", pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*", replacement: "", isRegex: true },
  { ruleId: "claude-code-identity", pattern: "You are Claude Code[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "anthropic-cli-identity", pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "anxthxropic-identity", pattern: "Anxthxropic'?s official[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "cursor-identity", pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "windsurf-identity", pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "cline-identity", pattern: "You are Cline[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "github-identity", pattern: "You are GitHub Copilot[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "github-copilot-vscode-identity", pattern: "You are an expert AI programming assistant, working with a user in the VS Code editor\\.?", replacement: "", isRegex: true },
  { ruleId: "github-copilot-name", pattern: "When asked for your name, you must respond with \\\"GitHub Copilot\\\"\\.?", replacement: "", isRegex: true },
  { ruleId: "github-copilot-model", pattern: "When asked about the model you are using, you must state that you are using (?:an? )?Aliased Model\\.?", replacement: "", isRegex: true },
  { ruleId: "github-copilot-microsoft-policy", pattern: "Follow Microsoft content policies\\.?", replacement: "", isRegex: true },
  { ruleId: "github-copilot-response-style", pattern: "Keep your answers short and impersonal\\.?", replacement: "", isRegex: true },
  { ruleId: "agentic-identity", pattern: "(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "mcp-reference", pattern: "MCP (?:server|client|protocol)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "powered-by-anthropic", pattern: "powered by (?:Claude|Anthropic|Anxthxropic)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "claude-feedback", pattern: "Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", replacement: "", isRegex: false },
  { ruleId: "advanced-ai-agent", pattern: "Advanced AI Agent", replacement: "", isRegex: false },
  { ruleId: "claude-code-literal", pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.", replacement: "", isRegex: false },
  { ruleId: "claude-code-mention", pattern: "Claude Code", replacement: "the assistant", isRegex: false },
];

export function seedDefaultSanitizerRules(): void {
  for (const [index, rule] of DEFAULT_RULES.entries()) {
    const existing = getDb().query("SELECT id FROM sanitizer_rules WHERE rule_id = ?").get(rule.ruleId);
    if (!existing) createSanitizerRule({ ...rule, sortOrder: index });
  }
}
