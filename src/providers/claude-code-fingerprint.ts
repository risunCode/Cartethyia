/**
 * Claude Code compatibility constants kept in a leaf module. This avoids an
 * import cycle between the provider, OAuth driver, and registry.
 *
 * These constants describe the supported OAuth wire contract. Cartethyia does
 * not invent a User-Agent; an incoming Claude Code User-Agent is forwarded
 * only by the Claude adapter when the client actually supplied one.
 */
export const claudeCodeVersion = "2.1.165";
export const claudeAgentSdkVersion = "0.3.165";
export const claudeClientVersion = "1.11187.4";
export const claudeBillingHeaderPrefix = "x-anthropic-billing-header:";
export const claudeCchPlaceholder = "cch=00000";
export const claudeCchSeed = 0x4d659218e32a3268n;
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const claudeToolPrefix = "_";
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
export const claudeCodeOAuthBetas = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
] as const;
