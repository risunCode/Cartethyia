/**
 * Custom provider CLI identity headers.
 *
 * Emits official CLI headers for OpenAI-compatible (Codex CLI) and
 * Anthropic-compatible (Claude Code CLI) endpoints so upstream requests
 * reflect realistic first-party tooling instead of naked node/bun user agents.
 *
 * Both sides read their version from the live resolver getters rather than the
 * frozen `claude-fingerprint` constants: those constants are evaluated once at
 * module load from the pinned fallback and never move, so a custom Anthropic
 * endpoint would have shipped the pinned Claude CLI version forever even after
 * discovery resolved a newer one. The getters are synchronous and TTL-cached,
 * so this costs a cache read per dispatch.
 */
import {
  getClaudeCliVersion,
  getClaudeSdkVersion,
  getCodexVersion,
} from "./client-versions";
import { buildCodexUserAgent } from "./cli-platform";
import type { WireFamily } from "../../transport/canonical-model";

/** Builds Codex CLI identity headers for OpenAI-compatible wire families. */
export function buildCustomCodexCliHeaders(): Record<string, string> {
  const version = getCodexVersion();
  return {
    "user-agent": buildCodexUserAgent(version),
    originator: "codex_cli_rs",
  };
}

/** Builds Claude Code CLI identity headers for Anthropic-compatible wire families. */
export function buildCustomClaudeCliHeaders(): Record<string, string> {
  const cliVersion = getClaudeCliVersion();
  return {
    "User-Agent": `claude-cli/${cliVersion} (external, cli)`,
    "x-app": "cli",
    "X-Stainless-Package-Version": getClaudeSdkVersion(),
    "X-Stainless-Runtime": "node",
    "X-Stainless-Retry-Count": "0",
  };
}

/**
 * Returns the appropriate CLI headers based on target wire family.
 * Messages wire family gets Claude CLI headers; chat / responses get Codex CLI headers.
 */
export function resolveCustomCliHeaders(wireFamily: WireFamily): Record<string, string> {
  if (wireFamily === "messages") {
    return buildCustomClaudeCliHeaders();
  }
  return buildCustomCodexCliHeaders();
}
