import type { RouteTarget } from "../../../routing/types";
import type { OpenAIChatRequest } from "../../../translate/types";
import { ProviderCallError, providerHttpError, safeReadText } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { commandCodeModelCatalog } from "./models";
import { buildCommandCodeHeaders, buildCommandCodeRequest, decodeCommandCodeNdjsonStream } from "./transport";
import { materializeFromStream, materializedToChatResponse } from "../../result";

const UPSTREAM_URL = "https://api.commandcode.ai/alpha/generate";

class CommandCodeProvider implements Provider {
  readonly id = "commandcode" as const;
  readonly display = {
    name: "Command Code",
    icon: "commandcode",
    authKind: "api-key",
    authHint:
      "Use your CommandCode CLI API key (starts with user_…) from ~/.commandcode/auth.json or commandcode.ai/studio.",
    credentialUrl: "https://commandcode.ai/studio",
  } as const;
  readonly models = commandCodeModelCatalog;

  async resolveTarget(modelId: string): Promise<RouteTarget | undefined> {
    return {
      provider: "commandcode",
      modelId,
      surface: "commandcode-ndjson",
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
      throw new ProviderCallError(401, "authentication", "A Command Code bearer credential is required.");
    }

    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Command Code currently supports the OpenAI Chat shape.");
    }

    const chatBody = request.body as OpenAIChatRequest;
    const sessionId = crypto.randomUUID();
    const upstreamBody = buildCommandCodeRequest(target.modelId, chatBody, sessionId);
    const headers = buildCommandCodeHeaders(sessionId, credential.value);

    const res = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal,
      ...(proxy ? { proxy } : {}),
    });

    if (!res.ok) {
      throw providerHttpError(res.status, "Command Code", undefined, await safeReadText(res));
    }

    if (!res.body) {
      throw new ProviderCallError(502, "unavailable", "Command Code upstream returned an empty response body.");
    }

    const events = decodeCommandCodeNdjsonStream(res.body);

    if (chatBody.stream) {
      return { type: "stream", events };
    }

    const materialized = await materializeFromStream(events);
    return { type: "json", body: materializedToChatResponse(materialized, chatBody.model) as unknown as Record<string, unknown> };
  }
}

export const commandCodeProvider = new CommandCodeProvider();
