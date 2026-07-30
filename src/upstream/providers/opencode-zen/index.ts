/**
 * OpenCode Zen — opencode.ai's curated, billed model gateway. Same base URL
 * and model catalog as OpenCode Free (https://opencode.ai/zen/v1) — the only
 * difference is Zen requires a real, billed API key (higher rate limits /
 * reliability) instead of Free's shared public credential.
 * @see https://opencode.ai/docs/zen/
 */

import type { RouteTarget } from "../../../routing/types";
import { ProviderCallError, providerHttpError, safeReadText } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { decodeOpenAIChatStream, decodeAnthropicStream } from "../../bridge";
import { fetchOpenCodeZenCatalog, findOpenCodeModel, selectCapability } from "./catalog";
import { openCodeZenModelCatalog } from "./models";
import { capabilityToSurface, surfaceToCapability, capabilityPath } from "../opencode-capability";

const UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";

class OpenCodeZenProvider implements Provider {
  readonly id = "opencode-zen" as const;
  readonly display = {
    name: "OpenCode Zen",
    icon: "opencode",
    authKind: "api-key",
    authHint: "Paste your OpenCode Zen API key from opencode.ai (sign in, add billing, then copy the key).",
    credentialUrl: "https://opencode.ai/zen",
  } as const;
  readonly models = openCodeZenModelCatalog;

  async resolveTarget(modelId: string): Promise<RouteTarget | undefined> {
    const catalog = await fetchOpenCodeZenCatalog();
    const entry = findOpenCodeModel(catalog, modelId);
    if (!entry) return undefined;

    const capability = selectCapability(entry, "chat");
    if (!capability) return undefined;

    return {
      provider: "opencode-zen",
      modelId,
      surface: capabilityToSurface(capability),
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
    if (!credential.value) throw new ProviderCallError(401, "authentication", "OpenCode Zen requires an API key.");

    const catalog = await fetchOpenCodeZenCatalog();
    const entry = findOpenCodeModel(catalog, target.modelId);
    if (!entry) {
      throw new ProviderCallError(400, "invalid_request", "The requested OpenCode Zen model is not available.");
    }

    const requestedCapability = surfaceToCapability(request.surface);
    const capability = selectCapability(entry, requestedCapability) ?? selectCapability(entry, "chat");
    if (!capability) {
      throw new ProviderCallError(400, "invalid_request", "The requested OpenCode Zen model does not support this API surface.");
    }

    const path = capabilityPath(capability);
    const body = { ...request.body, model: target.modelId };
    const isStreaming = (body as Record<string, unknown>).stream === true;

    const res = await fetch(`${UPSTREAM_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${credential.value}`,
        "x-opencode-client": "desktop",
      },
      body: JSON.stringify(body),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) {
      // The real upstream error text (via `bodyText`) is preferred over this
      // hardcoded fallback whenever OpenCode Zen's response actually says why.
      throw providerHttpError(res.status, "OpenCode Zen", undefined, await safeReadText(res));
    }

    if (!res.body) {
      throw new ProviderCallError(502, "unavailable", "OpenCode Zen upstream returned an empty response body.");
    }

    if (capability === "chat") {
      if (isStreaming) return { type: "stream", events: decodeOpenAIChatStream(res.body) };
      const jsonBody: unknown = await res.json();
      if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
        throw new ProviderCallError(502, "malformed_response", "OpenCode Zen returned an unreadable JSON response.");
      }
      return { type: "json", body: jsonBody as Record<string, unknown> };
    }

    if (capability === "messages") {
      if (isStreaming) return { type: "stream", events: decodeAnthropicStream(res.body) };
      const jsonBody: unknown = await res.json();
      if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
        throw new ProviderCallError(502, "malformed_response", "OpenCode Zen returned an unreadable JSON response.");
      }
      return { type: "json", body: jsonBody as Record<string, unknown> };
    }

    throw new ProviderCallError(501, "invalid_request", "OpenCode Zen responses capability is not yet implemented.");
  }
}

export const openCodeZenProvider = new OpenCodeZenProvider();
