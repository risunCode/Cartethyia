/**
 * Xiaomi MiMo (Pay-as-you-go) — built-in API-key provider using the paid,
 * api.xiaomimimo.com/v1 OpenAI-compatible endpoint (NOT `xiaomi-tokenplan`,
 * the region-specific subscription variant).
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError, classifyUpstreamStatus } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeOpenAIChatStream } from "../../bridge";
import { xiaomiMimoModelCatalog } from "./models";

const XIAOMI_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";

class XiaomiMimoProvider implements Provider {
  readonly id = "xmimo" as const;
  readonly display = {
    name: "Xiaomi MiMo (PAYG)",
    icon: "mimo",
    authKind: "api-key" as const,
    authHint: "Paste your Xiaomi MiMo pay-as-you-go API key from xiaomimimo.com.",
    credentialUrl: "https://xiaomimimo.com",
  };
  readonly models = xiaomiMimoModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: "xmimo", modelId, surface: "openai-chat", credential: "provider-bearer", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Xiaomi MiMo currently supports the OpenAI Chat shape.");
    if (!credential.value) throw new ProviderCallError(401, "authentication", "Xiaomi MiMo requires an API key.");

    // request.body already went through prepareOutboundRequest once, centrally, in
    // dispatchQualifiedRoute — re-applying it here would double-inject the system
    // prompt / RTK-compress twice / re-run filter rules on already-replaced text.
    const outboundBody = { ...request.body, model: target.modelId } as Record<string, unknown>;
    const isStreaming = outboundBody.stream === true;

    const res = await fetch(`${XIAOMI_MIMO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.value}`, "content-type": "application/json" },
      body: JSON.stringify(outboundBody),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) throw new ProviderCallError(res.status, classifyUpstreamStatus(res.status), `Xiaomi MiMo returned ${res.status}.`);
    if (!res.body) throw new ProviderCallError(502, "unavailable", "Xiaomi MiMo returned an empty response body.");

    if (isStreaming) return { type: "stream", events: decodeOpenAIChatStream(res.body) };

    const jsonBody: unknown = await res.json();
    if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
      throw new ProviderCallError(502, "malformed_response", "Xiaomi MiMo returned an unreadable JSON response.");
    }
    return { type: "json", body: jsonBody as Record<string, unknown> };
  }
}

export const xiaomiMimoProvider = new XiaomiMimoProvider();
