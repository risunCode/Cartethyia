import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { kimchiModelCatalog } from "./models";

const UPSTREAM_BASE_URL = "https://llm.kimchi.dev/openai/v1";

class KimchiProvider implements Provider {
  readonly id = "kimchi" as const;
  readonly display = {
    name: "Kimchi",
    icon: "kimchi",
    authKind: "api-key",
    authHint: "Use your Kimchi bearer token from the Kimchi CLI configuration.",
    credentialUrl: "https://kimchi.dev",
  } as const;
  readonly models = kimchiModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return {
      provider: "kimchi",
      modelId,
      surface: "openai-chat",
      credential: "provider-bearer",
      weight: 1,
    };
  }

  async call(
    target: RouteTarget,
    request: ProviderRequest,
    credential: ResolvedCredential,
    signal: AbortSignal,
    proxy?: string
  ): Promise<ProviderResult> {
    if (credential.kind !== "provider-bearer") {
      throw new ProviderCallError(401, "authentication", "A Kimchi bearer credential is required.");
    }

    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Kimchi currently supports the OpenAI Chat shape.");
    }

    const body = { ...request.body, model: target.modelId };

    const res = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream,application/json",
        authorization: `Bearer ${credential.value}`,
        "user-agent": "kimchi/0.1.75",
      },
      body: JSON.stringify(body),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new ProviderCallError(res.status, "authentication", "Kimchi rejected the supplied credential.");
      if (res.status === 429) throw new ProviderCallError(429, "rate_limited", "Kimchi is rate-limiting this request.");
      if (res.status >= 400 && res.status < 500) throw new ProviderCallError(res.status, "invalid_request", "Kimchi rejected this request.");
      throw new ProviderCallError(502, "unavailable", "Kimchi is unavailable.");
    }

    if (!res.body) {
      throw new ProviderCallError(502, "unavailable", "Kimchi upstream returned an empty response body.");
    }

    if ((body as Record<string, unknown>).stream === true) {
      return { type: "stream", events: decodeOpenAIChatStream(res.body) };
    }

    const jsonBody: unknown = await res.json();
    if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
      throw new ProviderCallError(502, "malformed_response", "Kimchi upstream returned an unreadable JSON response.");
    }

    return { type: "json", body: jsonBody as Record<string, unknown> };
  }
}

import { decodeOpenAIChatStream } from "../../bridge";

export const kimchiProvider = new KimchiProvider();
