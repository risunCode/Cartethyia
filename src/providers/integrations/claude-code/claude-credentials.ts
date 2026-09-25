import { GatewayError } from "../../../transport/gateway-error";
import type { CredentialKind } from "../../provider-registry";
import { HEADER_CONTROL as CONTROL_CHARACTERS } from "../../../security/outbound-headers";
import { filterClaudeCustomHeaders } from "../claude-messages";
import { CLAUDE_CODE_SDK_VERSION, CLAUDE_CODE_VERSION } from "./claude-fingerprint";
import { assertAnthropicBetaNegotiation, negotiateAnthropicBetas, parseAnthropicBeta, type AnthropicBetaInput, type AnthropicBetaNegotiation, type AnthropicBetaUnsupportedPolicy } from "./claude-betas";

function invalidHeader(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayError {
  return new GatewayError("invalid_request", 400, message, details);
}

function decodeSecret(secret: Uint8Array | undefined): string | undefined {
  if (!secret || secret.length === 0) return undefined;
  const raw = new TextDecoder().decode(secret);
  if (raw.length === 0) return undefined;
  if (CONTROL_CHARACTERS.test(raw)) {
    throw invalidHeader("Claude credential contains control characters", {
      field: "credential",
    });
  }
  // Stored secrets sometimes carry their issuance envelope (`Bearer ...`);
  const token = raw.replace(/^(?:Bearer|OAuth)\s+/i, "").trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Resolves the Claude credential mode without reading any client-provided auth
 * value. Missing material is rejected for authenticated kinds and accepted
 * only for the explicit `none` kind.
 */
/** Header-construction inputs shared by ClaudeAdapter and deterministic tests. */
export interface ClaudeHeaderOptions {
  readonly credential_kind?: CredentialKind;
  readonly request_headers?: Readonly<Record<string, string>>;
  readonly custom_headers?: Readonly<Record<string, unknown>>;
  readonly anthropic_beta?: AnthropicBetaInput | null;
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly unsupported_beta_policy?: AnthropicBetaUnsupportedPolicy;
  readonly target_provider?: string;
  readonly session_id?: string;
  /** Whether the request carries thinking/reasoning content (gates effort beta). */
  readonly has_thinking?: boolean;
  /** Whether the request declares tools or continues a tool-call turn (selects the agent vs. utility the assistant beta profile). */
  readonly has_tools?: boolean;
  /** Whether the request is streaming (affects Accept negotiation for non-OAuth). */
  readonly stream?: boolean;
  /** Resolved CLI version, overriding the static fingerprint when provided. */
  readonly cli_version?: string;
  /** Resolved SDK version, overriding the static fingerprint when provided. */
  readonly sdk_version?: string;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return entry?.[1];
}

function safeHeaderValue(value: string | undefined): string | undefined {
  if (!value || CONTROL_CHARACTERS.test(value)) return undefined;
  return value;
}

/** Maps Node's platform identifier to the Stainless wire value. */
export function mapStainlessOs(platform: string): string {
  switch (platform.toLowerCase()) {
    case "darwin":
      return "MacOS";
    case "windows":
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return `Other::${platform.toLowerCase()}`;
  }
}

/** Maps Node's architecture identifier to the Stainless wire value. */
export function mapStainlessArch(arch: string): string {
  switch (arch.toLowerCase()) {
    case "amd64":
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "386":
    case "x86":
    case "ia32":
      return "x86";
    default:
      return `other::${arch.toLowerCase()}`;
  }
}

const OAUTH_AUTH_BETA = "oauth-2025-04-20";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const THINKING_TOKEN_COUNT_BETA = "thinking-token-count-2026-05-13";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
const CLAUDE_CODE_BETA = "claude-code-20250219";
const EFFORT_BETA = "effort-2025-11-24";
const FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";

/**
 * Non-agentic calls (no tools, no thinking): the captured utility profile,
 * exactly as the reference client sends it.
 */
const CLAUDE_CODE_UTILITY_BETA_DEFAULTS: readonly string[] = [
  OAUTH_AUTH_BETA,
  INTERLEAVED_THINKING_BETA,
  THINKING_TOKEN_COUNT_BETA,
  CONTEXT_MANAGEMENT_BETA,
  PROMPT_CACHING_SCOPE_BETA,
  STRUCTURED_OUTPUTS_BETA,
];
/**
 * Agentic calls (tools declared, or thinking requested): the captured agent
 * profile. `effort` trails only when thinking is present; `fallback-credit`
 * trails every agent request.
 */
const CLAUDE_CODE_AGENT_BETA_DEFAULTS: readonly string[] = [
  CLAUDE_CODE_BETA,
  OAUTH_AUTH_BETA,
  INTERLEAVED_THINKING_BETA,
  THINKING_TOKEN_COUNT_BETA,
  CONTEXT_MANAGEMENT_BETA,
  PROMPT_CACHING_SCOPE_BETA,
  MID_CONVERSATION_SYSTEM_BETA,
];

function buildClaudeCodeBetas(
  agentRequest: boolean,
  thinkingRequest: boolean,
): string[] {
  const betas = [
    ...(agentRequest
      ? CLAUDE_CODE_AGENT_BETA_DEFAULTS
      : CLAUDE_CODE_UTILITY_BETA_DEFAULTS),
  ];
  if (!agentRequest) return betas;
  if (thinkingRequest) betas.push(EFFORT_BETA);
  betas.push(FALLBACK_CREDIT_BETA);
  return betas;
}

function defaultBetaInput(
  credentialKind: CredentialKind,
  requested: AnthropicBetaInput | null,
  hasThinking = false,
  hasTools = false,
): readonly string[] {
  const values = parseAnthropicBeta(requested);
  if (credentialKind === "oauth" || credentialKind === "scoped_access_token") {
    const base = buildClaudeCodeBetas(hasTools || hasThinking, hasThinking);
    // Deduplicate while preserving order: base first, then caller extras not already present
    const seen = new Set(base.map((b) => b.toLowerCase()));
    const extras = values.filter((v) => !seen.has(v.toLowerCase()));
    return [...base, ...extras];
  }
  return values;
}
function standardClaudeHeaders(
  secret: Uint8Array | undefined,
  _accountId: string | undefined,
  options: ClaudeHeaderOptions,
): { headers: Record<string, string>; negotiation: AnthropicBetaNegotiation } {
  const credentialKind = options.credential_kind ?? "oauth";
  const credential =
    credentialKind === "none"
      ? { mode: "none" as const }
      : {
          mode:
            credentialKind === "api_key"
              ? ("api_key" as const)
              : ("oauth" as const),
          token: decodeSecret(secret),
        };
  const requested = defaultBetaInput(
    credentialKind,
    options.anthropic_beta,
    options.has_thinking ?? false,
    options.has_tools ?? false,
  );
  const negotiationOptions = {
    unsupported: options.unsupported_beta_policy ?? "reject",
    credential_kind: credentialKind,
    target_provider: options.target_provider ?? "claude",
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  };
  const negotiation = negotiateAnthropicBetas(requested, negotiationOptions);
  assertAnthropicBetaNegotiation(negotiation);

  const inboundUserAgent = safeHeaderValue(
    headerValue(options.request_headers, "user-agent"),
  );
  const inboundSessionId = safeHeaderValue(
    options.session_id ??
      headerValue(options.request_headers, "x-claude-code-session-id"),
  );
  // Session header only when a real identity exists (inbound header,
  // explicit session_id, or metadata-derived): the reference client never
  // synthesizes one.
  const isOAuth =
    credentialKind === "oauth" || credentialKind === "scoped_access_token";
  const acceptHeader =
    isOAuth || !options.stream ? "application/json" : "text/event-stream";
  const headers: Record<string, string> = {
    Accept: acceptHeader,
    "Content-Type": "application/json",
    "User-Agent": inboundUserAgent ?? `claude-cli/${options.cli_version ?? CLAUDE_CODE_VERSION} (external, cli)`,
    ...(inboundSessionId === undefined
      ? {}
      : { "X-Claude-Code-Session-Id": inboundSessionId }),
    "X-Stainless-Arch": mapStainlessArch(process.arch),
    "X-Stainless-Lang": "js",
    "X-Stainless-OS": mapStainlessOs(process.platform),
    "X-Stainless-Package-Version": options.sdk_version ?? CLAUDE_CODE_SDK_VERSION,
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v26.3.0",
    "X-Stainless-Timeout": "600",
    ...(negotiation.header ? { "anthropic-beta": negotiation.header } : {}),
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    ...(credential.mode === "oauth" && credential.token
      ? { Authorization: `Bearer ${credential.token}` }
      : {}),
    "x-app": "cli",
    Connection: "keep-alive",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    ...(credential.mode === "api_key" && credential.token ? { "X-Api-Key": credential.token } : {}),
  };
  return { headers, negotiation };
}

/**
 * Builds Claude-facing headers from control-plane credentials and explicit
 * route policy. Client auth headers are never consulted. Claude Code OAuth
 * request bodies receive their CCH billing attestation immediately before
 * dispatch; arbitrary caller-supplied attestation headers remain protected.
 */
export function buildClaudeHeaders(
  secret: Uint8Array | undefined,
  accountId: string | undefined,
  options: ClaudeHeaderOptions = {},
): Record<string, string> {
  const { headers } = standardClaudeHeaders(secret, accountId, options);
  const custom = filterClaudeCustomHeaders(options.custom_headers);
  return { ...headers, ...custom };
}
