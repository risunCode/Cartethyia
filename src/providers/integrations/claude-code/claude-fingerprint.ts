/**
 * the assistant inference-fingerprint constants, kept in a leaf module so consumers
 * (`auth.ts`, `policy.ts`, `protocol/primitives.ts`) don't have to import the
 * heavy adapter/policy modules and no init cycle can form.
 */

import { VERSION_SOURCES } from "../../operations/client-versions";

/**
 * Claude Code CLI version stamped into the inference User-Agent and billing
 * header. Derived from `VERSION_SOURCES.claudeCli` so this fingerprint and
 * the version resolver's offline fallback can never drift apart.
 */
export const CLAUDE_CODE_VERSION = VERSION_SOURCES.claudeCli.fallback;

/**
 * `@anthropic-ai/sdk` version bundled by the current Claude Code release — the
 * value sent as `X-Stainless-Package-Version` and in the OAuth refresh
 * User-Agent. Derived from `VERSION_SOURCES.claudeSdk` for the same no-drift
 * reason.
 */
export const CLAUDE_CODE_SDK_VERSION = VERSION_SOURCES.claudeSdk.fallback;

/** User-Agent emitted by the assistant OAuth inference path. */
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */

/** the assistant's per-request output-token ceiling. */
