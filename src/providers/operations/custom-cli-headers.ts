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
import type { WireFamily } from "../../protocol/canonical-model";

/** Builds Codex CLI identity headers for OpenAI-compatible wire families. */
export function buildCustomCodexCliHeaders(): Record<string, string> {
  const version = getCodexVersion();
  return {
    "user-agent": buildCodexUserAgent(version),
    originator: "codex_cli_rs",
  };
}

/**
 * The Claude Code User-Agent, on the live CLI version.
 *
 * This is the route-level default for a provider whose operator set no client
 * identity of their own: a bare API key identifies as the Claude Code CLI
 * rather than as nothing. It used to be the Codex CLI identity
 * (`codex_cli_rs/…`), which named a different vendor's client on requests that
 * most often reached neither — an upstream that keys on the client string
 * would act on it.
 *
 * The version comes from the live getter for the same reason
 * {@link buildCustomClaudeCliHeaders} does: the pinned `claude-fingerprint`
 * constants are evaluated once at module load and never move, so a default
 * built from them would send a Claude CLI version the client stopped shipping
 * and still answer to.
 */
export function buildClaudeCliUserAgent(): string {
  return `claude-cli/${getClaudeCliVersion()} (external, cli)`;
}

/** Builds Claude Code CLI identity headers for Anthropic-compatible wire families. */
export function buildCustomClaudeCliHeaders(): Record<string, string> {
  return {
    "User-Agent": buildClaudeCliUserAgent(),
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
