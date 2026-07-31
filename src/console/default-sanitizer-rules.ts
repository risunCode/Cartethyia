/**
 * Built-in Filter Rules — applied on every outbound request unless the
 * operator disables or overrides them from Console → Filter Rules. Not seeded
 * into SQLite; DB rows store operator overrides and custom rules only.
 *
 * Mirrors etteum-pool's PUDIDIL_FILTERS (Public/etteum-pool/src/proxy/filters.ts), with
 * `agentic-identity` and `mcp-reference` anchored to a leading identity claim
 * ("You are"/"Powered by"/"This is") — etteum-pool's unanchored versions strip
 * any sentence merely mentioning MCP or an "agentic"/"autonomous" tool, which
 * deleted legitimate tool-use instructions from client system prompts and
 * broke tool calling for MCP-style clients.
 */

export interface BuiltinSanitizerRule {
  ruleId: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
}

export const DEFAULT_SANITIZER_RULES: readonly BuiltinSanitizerRule[] = [
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
  { ruleId: "agentic-identity", pattern: "You are (?:an? )?(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "mcp-reference", pattern: "(?:You are|Powered by|This is)[^.]*\\bMCP (?:server|client|protocol)\\b[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "powered-by-anthropic", pattern: "powered by (?:Claude|Anthropic|Anxthxropic)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "claude-feedback", pattern: "Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", replacement: "", isRegex: false },
  { ruleId: "advanced-ai-agent", pattern: "Advanced AI Agent", replacement: "", isRegex: false },
  { ruleId: "claude-code-literal", pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.", replacement: "", isRegex: false },
  { ruleId: "claude-code-mention", pattern: "Claude Code", replacement: "the assistant", isRegex: false },
] as const;

const BUILTIN_RULE_IDS = new Set(DEFAULT_SANITIZER_RULES.map((rule) => rule.ruleId));

export function isBuiltinSanitizerRuleId(ruleId: string): boolean {
  return BUILTIN_RULE_IDS.has(ruleId);
}

export function builtinSanitizerRule(ruleId: string): BuiltinSanitizerRule | undefined {
  return DEFAULT_SANITIZER_RULES.find((rule) => rule.ruleId === ruleId);
}

/** Synthetic negative IDs for built-ins that have no DB override row yet. */
export function syntheticBuiltinRuleId(index: number): number {
  return -(index + 1);
}

export function builtinRuleIdFromSyntheticId(id: number): string | null {
  if (id >= 0) return null;
  return DEFAULT_SANITIZER_RULES[-id - 1]?.ruleId ?? null;
}
