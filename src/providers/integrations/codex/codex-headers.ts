/**
 * Codex ChatGPT identity headers and the `client_metadata` / turn-metadata
 * envelope. Kept with the provider (not in `src/protocol/primitives.ts`)
 * because it depends on Codex account identity via `getCodexAccountId`.
 */
import { getCodexAccountId } from "./codex-identity";
import type { ResolvedCredential } from "../../provider-registry";
import { toAsciiJsonString } from "../../../protocol/primitives";

interface CodexIdentityHeadersOptions {
  readonly credential: ResolvedCredential;
  readonly version: string;
  readonly attestation?: string | undefined;
  readonly residency?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly windowId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly parentTurnId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly installationId?: string | undefined;
  readonly turnMetadataJson?: string | undefined;
  readonly betaFeatures?: string | undefined;
  readonly subAgent?: string | undefined;
  readonly responsesLite?: boolean | undefined;
  readonly turnState?: string | undefined;
  readonly modelsEtag?: string | undefined;
  /**
   * `x-codex-routing-hint: model=<slug>[;tier=<service_tier>]` — codex-rs
   * sends this on every ChatGPT-OAuth Responses/compaction/WebSocket
   * request. Callers compute the value; absent/empty omits the header.
   */
  readonly routingHint?: string | undefined;
}

export function buildCodexIdentityHeaders(
  options: CodexIdentityHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["user-agent"] = `codex_cli_rs/${options.version}`;
  headers["originator"] = "codex_cli_rs";
  headers["version"] = options.version;
  const token =
    options.credential.secret === undefined
      ? undefined
      : new TextDecoder().decode(options.credential.secret);
  const accountId =
    options.credential.account_id ??
    (token === undefined ? undefined : getCodexAccountId(token));
  if (accountId !== undefined && accountId.length > 0)
    headers["chatgpt-account-id"] = accountId;
  headers["OpenAI-Beta"] = "responses=experimental";
  if (options.attestation !== undefined && options.attestation.length > 0)
    headers["x-oai-attestation"] = options.attestation;
  if (options.residency !== undefined && options.residency.length > 0)
    headers["x-openai-internal-codex-residency"] = options.residency;
  if (options.sessionId !== undefined && options.sessionId.length > 0) {
    headers["session-id"] = options.sessionId;
    headers["x-client-request-id"] = options.sessionId;
    if (
      options.conversationId === undefined ||
      options.conversationId.length === 0
    ) {
      headers["conversation-id"] = options.sessionId;
    }
  }
  if (options.threadId !== undefined && options.threadId.length > 0)
    headers["thread-id"] = options.threadId;
  if (options.windowId !== undefined && options.windowId.length > 0)
    headers["x-codex-window-id"] = options.windowId;
  if (options.turnId !== undefined && options.turnId.length > 0)
    headers["turn-id"] = options.turnId;
  if (options.parentTurnId !== undefined && options.parentTurnId.length > 0)
    headers["parent-turn-id"] = options.parentTurnId;
  if (options.conversationId !== undefined && options.conversationId.length > 0)
    headers["conversation-id"] = options.conversationId;
  if (
    options.installationId !== undefined &&
    options.installationId.length > 0
  ) {
    headers["x-codex-installation-id"] = options.installationId;
  }
  if (
    options.turnMetadataJson !== undefined &&
    options.turnMetadataJson.length > 0
  ) {
    headers["x-codex-turn-metadata"] = options.turnMetadataJson;
  }
  if (options.betaFeatures !== undefined && options.betaFeatures.length > 0) {
    headers["x-codex-beta-features"] = options.betaFeatures;
  }
  if (options.subAgent !== undefined && options.subAgent.length > 0) {
    headers["x-openai-subagent"] = options.subAgent;
  }
  if (options.responsesLite === true) {
    headers["x-openai-internal-codex-responses-lite"] = "true";
  }
  if (options.turnState !== undefined && options.turnState.length > 0) {
    headers["x-codex-turn-state"] = options.turnState;
  }
  if (options.modelsEtag !== undefined && options.modelsEtag.length > 0) {
    headers["x-models-etag"] = options.modelsEtag;
  }
  if (options.routingHint !== undefined && options.routingHint.length > 0) {
    headers["x-codex-routing-hint"] = options.routingHint;
  }
  return headers;
}

/**
 * Builds the Codex `client_metadata` envelope and turn-metadata JSON.
 */
export function createCodexRequestMetadata(args: {
  installationId: string;
  sessionId: string;
  threadId: string;
  windowId: string;
  turnId: string;
  parentTurnId?: string;
  requestKind?: string;
  turnStartedAtUnixMs?: number;
  compaction?: Record<string, unknown>;
}): {
  clientMetadata: Record<string, string>;
  turnMetadataJson: string;
} {
  const requestKind = args.requestKind ?? "turn";
  const turnMetadata: Record<string, unknown> = {
    installation_id: args.installationId,
    session_id: args.sessionId,
    thread_id: args.threadId,
    turn_id: args.turnId,
    window_id: args.windowId,
    request_kind: requestKind,
  };
  if (args.parentTurnId !== undefined && args.parentTurnId.length > 0)
    turnMetadata["parent_turn_id"] = args.parentTurnId;
  if (args.compaction !== undefined)
    turnMetadata["compaction"] = args.compaction;
  if (args.turnStartedAtUnixMs !== undefined)
    turnMetadata["turn_started_at_unix_ms"] = args.turnStartedAtUnixMs;
  const turnMetadataJson = toAsciiJsonString(turnMetadata);
  const clientMetadata: Record<string, string> = {
    "x-codex-installation-id": args.installationId,
    session_id: args.sessionId,
    thread_id: args.threadId,
    "x-codex-window-id": args.windowId,
    turn_id: args.turnId,
  };
  if (args.parentTurnId !== undefined && args.parentTurnId.length > 0)
    clientMetadata["parent_turn_id"] = args.parentTurnId;
  clientMetadata["x-codex-turn-metadata"] = turnMetadataJson;
  return { clientMetadata, turnMetadataJson };
}
