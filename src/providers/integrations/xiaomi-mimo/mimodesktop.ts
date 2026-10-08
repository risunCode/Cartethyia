import { defineModel } from "../../model-definition";
import type { ModelDefinition, ProviderDispatchTarget } from "../../provider-registry";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type { ApiKeyProviderSpec } from "../configured-provider";
import { acquireMimoServiceSession, MIMO_API_UA } from "./mimodesktop-sso";
import { parseMimoCredential } from "./mimodesktop-oauth";

export const MIMODESKTOP_PROVIDER_ID = "mimodesktop" as const;
export const MIMODESKTOP_CHAT_ENDPOINT = "/api/route/chat/completions" as const;
export const MIMODESKTOP_BASE_URL = "https://mimo-server-sgp.xiaomimimo.com" as const;

/**
 * Model aliases accepted by MiMo Desktop, mapped to upstream canonical identifiers.
 * 2.5 is completely removed; user requested 2.6 flash and pro.
 */
export const MIMODESKTOP_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "mimo-v2.6-flash": "mimo-v2.6-flash",
  "mimo-v2.6-pro": "mimo-v2.6-pro",
  "mimo-x-flash": "mimo-v2.6-flash",
  "mimo-x-pro": "mimo-v2.6-pro",
  "MiMo-X-Flash-Preview": "mimo-v2.6-flash",
  "MiMo-X-Pro-Preview": "mimo-v2.6-pro",
  "mimo-flash": "mimo-v2.6-flash",
  "mimo-pro": "mimo-v2.6-pro",
  "mimo-auto": "mimo-v2.6-pro",
});

export function resolveMimoDesktopModelId(requestedModel: string): string {
  const trimmed = requestedModel.trim();
  return MIMODESKTOP_MODEL_ALIASES[trimmed] ?? trimmed;
}

function mimoModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: {
    readonly vision?: boolean;
    readonly reasoning?: boolean;
    readonly toolCall?: boolean;
  } = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: MIMODESKTOP_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: MIMODESKTOP_CHAT_ENDPOINT,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: options.toolCall ?? true,
  });
}

/**
 * Static catalog for MiMo Desktop: 2.6 series only (V2.5 removed).
 */
export const MIMODESKTOP_MODELS: readonly ModelDefinition[] = [
  mimoModel("mimo-v2.6-flash", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoModel("mimo-v2.6-pro", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoModel("mimo-x-flash", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoModel("mimo-x-pro", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoModel("MiMo-X-Flash-Preview", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
  mimoModel("MiMo-X-Pro-Preview", 1_048_576, 65_536, { reasoning: true, toolCall: true }),
];

export const MIMODESKTOP_SPEC: ApiKeyProviderSpec = {
  provider_id: MIMODESKTOP_PROVIDER_ID,
  base_url: MIMODESKTOP_BASE_URL,
  // The passToken is only for the SSO exchange; inference authenticates with
  // the resulting service cookie, never an Authorization bearer token.
  credential_forwarding: "never",
  endpoint_paths_by_wire_family: {
    chat: MIMODESKTOP_CHAT_ENDPOINT,
  },
  extra_headers: {
    "User-Agent": MIMO_API_UA,
    "X-Mimo-Source": "mimocode-cli-free",
    "X-Client-Version": "26.924.240030",
  },
  buildExtraHeaders: async (context, request) => {
    const rawSecret = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret)
      : "";
    const parsed = parseMimoCredential(rawSecret);
    const sessionCookie = await acquireMimoServiceSession({
      passToken: parsed.passToken,
      ...(parsed.userId ? { userId: parsed.userId } : {}),
      apiBase: MIMODESKTOP_BASE_URL,
    });
    return {
      Cookie: sessionCookie,
      Accept: request?.stream === true ? "text/event-stream" : "application/json",
    };
  },
  prePayload: (
    payload: Record<string, unknown>,
    _request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => {
    const rawModel = typeof payload["model"] === "string" ? payload["model"] : candidate.model_id;
    payload["model"] = resolveMimoDesktopModelId(rawModel);
  },
};
