# Filter Rules (archived)

Removed in the `1.0.4-alpha` cutoff pass. This document preserves the design
so it can be referenced or rebuilt later — it is not a promise to do so.

## What it did

A pattern-based outbound-text sanitizer, exposed in the console as "Filter
Rules". On every outbound request (unless the operator disabled it), it
stripped or replaced client-identifying strings — e.g. "You are Claude
Code…" boilerplate, GitHub Copilot's system-prompt markers, Cursor/Windsurf/
Cline identity claims — so upstream providers were less likely to
fingerprint which coding-agent client actually made the call.

Built-in rules lived in code (`src/console/default-sanitizer-rules.ts`,
now deleted) and were never seeded into SQLite; the `sanitizer_rules` table
stored only operator overrides of built-ins plus fully custom rules. At
request time the two were merged: DB override replaces a built-in's
pattern/replacement/active state when present, otherwise the built-in
default applied.

## Built-in rules (verbatim from `default-sanitizer-rules.ts`)

| Rule ID | Pattern | Replacement | Regex |
|---|---|---|---|
| `billing-header` | `x-(?:anthropic-)?billing-header:?\s*[^\n]*` | `""` | yes |
| `cc-entrypoint` | `cc_entrypoint=\w+` | `""` | yes |
| `cc-version` | `cc_version=[\w.]+` | `""` | yes |
| `cc-hash` | `c?ch=[a-f0-9]+` | `""` | yes |
| `claude-code-github` | `https?://github\.com/anthropics/claude-code[^\s]*` | `""` | yes |
| `claude-code-identity` | `You are Claude Code[^.]*\.` | `""` | yes |
| `anthropic-cli-identity` | `Anthropic'?s official (?:CLI\|tool\|agent)[^.]*\.?` | `""` | yes |
| `anxthxropic-identity` | `Anxthxropic'?s official[^.]*\.?` | `""` | yes |
| `cursor-identity` | `You are (?:a )?(?:powerful )?(?:AI )?(?:assistant\|agent) (?:made\|built\|created) by (?:Cursor\|Anysphere)[^.]*\.?` | `""` | yes |
| `windsurf-identity` | `You are (?:Windsurf\|Cascade\|Codeium)[^.]*\.` | `""` | yes |
| `cline-identity` | `You are Cline[^.]*\.` | `""` | yes |
| `github-identity` | `You are GitHub Copilot[^.]*\.` | `""` | yes |
| `github-copilot-vscode-identity` | `You are an expert AI programming assistant, working with a user in the VS Code editor\.?` | `""` | yes |
| `github-copilot-name` | `When asked for your name, you must respond with \"GitHub Copilot\"\.?` | `""` | yes |
| `github-copilot-model` | `When asked about the model you are using, you must state that you are using (?:an? )?Aliased Model\.?` | `""` | yes |
| `github-copilot-microsoft-policy` | `Follow Microsoft content policies\.?` | `""` | yes |
| `github-copilot-response-style` | `Keep your answers short and impersonal\.?` | `""` | yes |
| `agentic-identity` | `You are (?:an? )?(?:autonomous\|agentic) (?:AI \|coding )?(?:agent\|assistant)[^.]*\.` | `""` | yes |
| `mcp-reference` | `(?:You are\|Powered by\|This is)[^.]*\bMCP (?:server\|client\|protocol)\b[^.]*\.?` | `""` | yes |
| `powered-by-anthropic` | `powered by (?:Claude\|Anthropic\|Anxthxropic)[^.]*\.?` | `""` | yes |
| `claude-feedback` | `Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues` | `""` | no |
| `advanced-ai-agent` | `Advanced AI Agent` | `""` | no |
| `claude-code-literal` | `You are Claude Code, Anxthxropic's official CLI for Claude.` | `""` | no |
| `claude-code-mention` | `Claude Code` | `the assistant` | no |

Two rules (`agentic-identity`, `mcp-reference`) were deliberately anchored to
a leading identity claim ("You are"/"Powered by"/"This is …") rather than
matching any sentence mentioning MCP or "agentic" — an unanchored version
was found to strip legitimate tool-use instructions out of client system
prompts, breaking tool calling for MCP-style clients.

## Data model

```sql
CREATE TABLE sanitizer_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  pattern TEXT NOT NULL,
  replacement TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_regex INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Named `sanitizer_rules`, not `filter_rules` — that name was already taken by
an unrelated, still-active concept (combo model-eligibility allow/deny,
`console/db/repos/combos.ts`).

Built-in rule rows used synthetic negative IDs (`-(index + 1)`) when no DB
override existed yet, so the console could always address a built-in by a
stable id even before an operator ever touched it.

## API shape (removed)

Base: `/console/api/filter.sanitize`

- `GET /` — merged built-ins + DB overrides + custom rules, sorted by
  `sortOrder` then `ruleId`.
- `POST /` — create a custom rule (`ruleId`, `pattern` required). Rejected
  with `409` if `ruleId` collides with a built-in id.
- `POST /:id` — patch a rule. A negative (synthetic) id patches/creates a
  built-in override; a positive id patches an existing DB row.
- `DELETE /:id` — delete a custom rule, or remove a built-in's override
  (reverting it to the coded default) for a synthetic id.

A master kill switch (`filterRulesEnabled` runtime setting, default off on
a fresh install) skipped every rule — built-in and custom — regardless of
each rule's own active state, without touching per-rule state in the DB.

## Why it was removed

Part of the `1.0.4-alpha` cutoff pass to simplify the base before larger
work: low usage relative to its maintenance surface (a full CRUD API,
console page, and a hot-path regex pass on every outbound request). See
`CHANGELOG.md` under `1.0.4-alpha` for the full list of features cut in the
same pass.
