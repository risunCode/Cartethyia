import { createHash, randomUUID } from "node:crypto";

import type { OpenAICompatibleAdapterConfig } from "../../compatible-adapter";
import { withBearerAuthentication } from "../../compatible-adapter";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
} from "../../provider-registry";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import {
  buildWorkBuddyUserAgent,
  resolveWorkBuddyVersion,
  getWorkBuddyClientVersion,
  getWorkBuddyCliVersion,
} from "../../operations/client-versions";

/**
 * WorkBuddy serves chat from a versioned path on a base URL that carries no
 * version segment (billing uses the unversioned `/billing/…` path), so both the
 * adapter config and the static catalog rows must state it. The generic
 * `/chat/completions` default would join into
 * `https://www.workbuddy.ai/chat/completions`, which that upstream answers with
 * a 405 HTML error page.
 */
export const WORKBUDDY_CHAT_PATH = "/v2/chat/completions" as const;

export {
  buildWorkBuddyUserAgent,
  getWorkBuddyClientVersion,
  getWorkBuddyCliVersion,
  resolveWorkBuddyVersion,
};

/** WorkBuddy international gateway domain (Origin/Referer/X-Domain). */
export const WORKBUDDY_DOMAIN = "www.workbuddy.ai";

/**
 * Stable per-account device identifiers.
 *
 * WorkBuddy's desktop client presents one fixed virtual device per account.
 * Deriving `X-Machine-ID` / `X-Session-ID` from the account id (sha256, 36 hex)
 * keeps them constant across restarts while staying distinct per account, so
 * multiple pooled accounts are not correlated by a missing or drifting device
 * fingerprint. Mirrors the reference gateway's `wb2a:<purpose>:<uid>` scheme.
 */
function deriveAccountStableId(accountId: string, purpose: string): string {
  const sum = createHash("sha256").update(`wb2a:${purpose}:${accountId}`).digest("hex");
  return sum.slice(0, 36);
}

/**
 * Per-request WorkBuddy chat headers — the exact desktop-client contract.
 *
 * The international gateway gates chat on the desktop `User-Agent` (platform
 * brand `WorkBuddy AI`; the wrong brand trips 403 code 11140), plus the
 * `X-CodeBuddy-Request` risk gate and the account-scoped device headers. The
 * version is resolved from upstream so the UA stays current; the pinned
 * fallback only applies on a real network failure.
 */
export async function workbuddyHeaders(
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): Promise<Record<string, string>> {
  await resolveWorkBuddyVersion();
  const clientVersion = getWorkBuddyClientVersion();
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "user-agent": buildWorkBuddyUserAgent(clientVersion, getWorkBuddyCliVersion()),
    origin: `https://${WORKBUDDY_DOMAIN}`,
    referer: `https://${WORKBUDDY_DOMAIN}/`,
    "accept-language": "en-US",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "x-domain": WORKBUDDY_DOMAIN,
    "x-agent-purpose": "conversation",
    "x-ide-name": "WorkBuddy",
    "x-ide-type": "WorkBuddy",
    "x-ide-version": clientVersion,
    "x-product": "WorkBuddy",
    // Personal international accounts carry no enterprise id: declare it
    // explicitly so upstream risk control does not treat the omission as
    // suspicious.
    "x-no-enterprise-id": "1",
    "x-conversation-id": resolveInboundSessionId(context, request) ?? randomUUID(),
    "x-request-id": randomUUID().replaceAll("-", ""),
  };
  const accountId = context?.credential.account_id;
  if (accountId) {
    headers["x-user-id"] = accountId;
    headers["x-machine-id"] = deriveAccountStableId(accountId, "machine");
    headers["x-session-id"] = deriveAccountStableId(accountId, "session");
  }
  return headers;
}

/**
 * Shared OpenAI-compatible chat-adapter config for WorkBuddy: bearer auth
 * (api_key and oauth both use `Authorization: Bearer`), `/v2/chat/completions`
 * endpoint, per-request desktop-client headers, and the payload hook.
 */
export function workbuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  prePayload: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  fetchImpl?: typeof fetch;
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    endpoint_paths_by_wire_family: { chat: WORKBUDDY_CHAT_PATH },
    buildExtraHeaders: (context, request) => workbuddyHeaders(context, request),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}

