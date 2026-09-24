/**
 * Custom provider CLI identity headers.
 *
 * Emits official CLI headers for OpenAI-compatible (Codex CLI) and
 * Anthropic-compatible (Claude Code CLI) endpoints so upstream requests
 * reflect realistic first-party tooling instead of naked node/bun user agents.
 */
import { getCodexVersion } from "./client-versions";
import {
  CLAUDE_CODE_SDK_VERSION,
  CLAUDE_CODE_USER_AGENT,
} from "../integrations/claude-code/claude-fingerprint";
import type { WireFamily } from "../../transport/canonical-model";

/** Builds Codex CLI identity headers for OpenAI-compatible wire families. */
export function buildCustomCodexCliHeaders(): Record<string, string> {
  const version = getCodexVersion();
  return {
    "user-agent": `codex_cli_rs/${version}`,
    originator: "codex_cli_rs",
  };
}

/** Builds Claude Code CLI identity headers for Anthropic-compatible wire families. */
export function buildCustomClaudeCliHeaders(): Record<string, string> {
  return {
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "X-Stainless-Package-Version": CLAUDE_CODE_SDK_VERSION,
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
