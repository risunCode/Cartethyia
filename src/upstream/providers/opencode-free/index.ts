import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeOpenAIChatStream, decodeAnthropicStream } from "../../bridge";
import { fetchOpenCodeFreeCatalog, findOpenCodeModel, selectCapability } from "./catalog";
import { openCodeFreeModelCatalog } from "./models";
import { capabilityToSurface, surfaceToCapability, capabilityPath } from "../opencode-capability";

const UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";

class OpenCodeFreeProvider implements Provider {
  readonly id = "opencode-free" as const;
  readonly display = {
    name: "OpenCode Free",
    icon: "opencode",
    authKind: "none",
    authHint:
      "This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.",
  } as const;
  readonly models = openCodeFreeModelCatalog;

  async resolveTarget(modelId: string): Promise<RouteTarget | undefined> {
    const catalog = await fetchOpenCodeFreeCatalog();
    const entry = findOpenCodeModel(catalog, modelId);
    if (!entry) return undefined;

    const capability = selectCapability(entry, "chat");
    if (!capability) return undefined;

    return {
      provider: "opencode-free",
      modelId,
      surface: capabilityToSurface(capability),
      credential: "none",
      weight: 1,
    };
  }

  async call(
    target: RouteTarget,
    request: ProviderRequest,
    _credential: ResolvedCredential,
    signal: AbortSignal,
    proxy?: string
  ): Promise<ProviderResult> {
    const catalog = await fetchOpenCodeFreeCatalog();
    const entry = findOpenCodeModel(catalog, target.modelId);
    if (!entry) {
      throw new ProviderCallError(400, "invalid_request", "The requested OpenCode Free model is not available.");
    }

    const requestedCapability = surfaceToCapability(request.surface);
    const capability = selectCapability(entry, requestedCapability) ?? selectCapability(entry, "chat");
    if (!capability) {
      throw new ProviderCallError(400, "invalid_request", "The requested OpenCode Free model does not support this API surface.");
    }

    const path = capabilityPath(capability);
    const body = { ...request.body, model: target.modelId };
    const isStreaming = (body as Record<string, unknown>).stream === true;

    const res = await fetch(`${UPSTREAM_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: "Bearer public",
        "x-opencode-client": "desktop",
      },
      body: JSON.stringify(body),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) {
      if (res.status === 429) throw new ProviderCallError(429, "rate_limited", "OpenCode Free is rate-limiting this request.");
      if (res.status >= 400 && res.status < 500) throw new ProviderCallError(res.status, "invalid_request", "OpenCode Free rejected this request.");
      throw new ProviderCallError(502, "unavailable", "OpenCode Free is unavailable.");
    }

    if (!res.body) {
      throw new ProviderCallError(502, "unavailable", "OpenCode Free upstream returned an empty response body.");
    }

    if (capability === "chat") {
      if (isStreaming) return { type: "stream", events: decodeOpenAIChatStream(res.body) };
      const jsonBody: unknown = await res.json();
      if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
        throw new ProviderCallError(502, "malformed_response", "OpenCode Free returned an unreadable JSON response.");
      }
      return { type: "json", body: jsonBody as Record<string, unknown> };
    }

    if (capability === "messages") {
      if (isStreaming) return { type: "stream", events: decodeAnthropicStream(res.body) };
      const jsonBody: unknown = await res.json();
      if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
        throw new ProviderCallError(502, "malformed_response", "OpenCode Free returned an unreadable JSON response.");
      }
      return { type: "json", body: jsonBody as Record<string, unknown> };
    }

    throw new ProviderCallError(501, "invalid_request", "OpenCode Free responses capability is not yet implemented.");
  }
}

export const openCodeFreeProvider = new OpenCodeFreeProvider();
