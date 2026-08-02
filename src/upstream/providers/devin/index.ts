import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError, extractUpstreamErrorMessage, safeReadText } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { buildDevinChatRequest, decodeDevinChatStream, fetchDevinAuthMetadata } from "./transport";
import { materializeFromStream, materializedToChatResponse } from "../../result";
import { devinModelCatalog } from "./models";
import { buildProxyFetcher } from "../../proxy/adapter";
import type { ProxyTarget } from "../../proxy/types";

class DevinProvider implements Provider {
  readonly id = "devin" as const;
  readonly display = {
    name: "Devin",
    icon: "devin",
    authKind: "session",
    authHint:
      "Use your Devin/Windsurf session token. The bare token works too — the devin-session-token$ prefix is added for you.",
    credentialUrl: "https://app.devin.ai",
  } as const;
  readonly models = devinModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return {
      provider: "devin",
      modelId,
      surface: "devin-connect",
      credential: "devin-session",
      weight: 1,
    };
  }

  async call(
    target: RouteTarget,
    request: ProviderRequest,
    credential: ResolvedCredential,
    signal: AbortSignal,
    proxy?: ProxyTarget | null,
  ): Promise<ProviderResult> {
    if (credential.kind !== "devin-session") {
      throw new ProviderCallError(401, "authentication", "A Devin session credential is required.");
    }

    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Devin currently supports the OpenAI Chat shape.");
    }

    const fetcher = proxy ? buildProxyFetcher(proxy) : fetch;
    const auth = await fetchDevinAuthMetadata(credential.value, signal, fetcher);
    const chatBody = request.body as Record<string, unknown>;
    const upstreamRequest = buildDevinChatRequest(credential.value, auth.userJwt, target.modelId, chatBody, auth.baseUrl);

    const res = await fetcher(upstreamRequest.url, {
      method: "POST",
      headers: upstreamRequest.headers,
      body: upstreamRequest.body,
      signal,
    });

    if (!res.ok) {
      const upstreamMessage = extractUpstreamErrorMessage(await safeReadText(res));
      throw new ProviderCallError(
        res.status >= 400 && res.status < 500 ? 401 : 502,
        res.status >= 400 && res.status < 500 ? "authentication" : "unavailable",
        upstreamMessage ?? "Devin chat request failed."
      );
    }

    if (!res.body) {
      throw new ProviderCallError(502, "unavailable", "Devin upstream returned an empty response body.");
    }

    const events = decodeDevinChatStream(res.body);

    if (chatBody.stream === true) {
      return { type: "stream", events };
    }

    const materialized = await materializeFromStream(events);
    return { type: "json", body: materializedToChatResponse(materialized, chatBody.model as string) as unknown as Record<string, unknown> };
  }
}

export const devinProvider = new DevinProvider();
