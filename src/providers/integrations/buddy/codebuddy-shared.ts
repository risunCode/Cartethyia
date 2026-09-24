import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../compatible-adapter";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
} from "../../provider-registry";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import { buildCodeBuddyUserAgent, resolveCodeBuddyVersion } from "../../operations/client-versions";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
}


/**
 * Per-request CodeBuddy headers — exact provider contract shared by the
 * international (IDE identity) and CN (CLI identity). The stable conversation
 * header is preserved from the client when available; request IDs rotate.
 */
export async function codebuddyHeaders(
  variant: CodeBuddyVariant,
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): Promise<Record<string, string>> {
  const identity = variant === "IDE" ? "IDE" : "CLI";
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveCodeBuddyVersion();
  const ua = buildCodeBuddyUserAgent(identity);
  return {
    accept: "text/event-stream",
    "User-Agent": ua,
    "X-Product": "SaaS",
    "X-IDE-Type": identity,
    "X-IDE-Name": identity,
    "X-Domain": codebuddyDomain(variant),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "x-conversation-id": resolveInboundSessionId(context, request) ?? crypto.randomUUID(),
    "x-request-id": crypto.randomUUID().replaceAll("-", ""),
  };
}

/**
 * Shared OpenAI-compatible chat-adapter config for both CodeBuddy variants:
 * bearer auth, chat-only wire contract, per-request identity headers, and the
 * variant's payload hook.
 */
export function codebuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  variant: CodeBuddyVariant;
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
    supported_wire_families: ["chat"],
    buildExtraHeaders: (context, request) => codebuddyHeaders(args.variant, context, request),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
