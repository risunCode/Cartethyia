import type { RouteTarget } from "../../routing/types";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import { decodeOpenAIChatStream } from "../bridge";
import { callSimpleProvider } from "./simple-call";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "./models";

const UPSTREAM_BASE_URL = "https://llm.kimchi.dev/openai/v1";

const MODELS: ProviderModelEntry[] = [
  { id: "kimi-k2.7", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 64000, description: "Kimi K2.7 via Kimchi", pricing: { input: 0, output: 0 } },
  { id: "minimax-m3", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "MiniMax M3 via Kimchi", pricing: { input: 0, output: 0 } },
  { id: "deepseek-v4-flash", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "DeepSeek V4 Flash via Kimchi", pricing: { input: 0, output: 0 } },
  { id: "nemotron-3-ultra-fp4", reasoning: true, contextWindow: 128000, maxOutputTokens: 8192, description: "Nemotron 3 Ultra FP4 via Kimchi", pricing: { input: 0, output: 0 } },
];

export const kimchiModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);

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
    proxy?: ProxyTarget | null,
  ): Promise<ProviderResult> {
    if (credential.kind !== "provider-bearer") {
      throw new ProviderCallError(401, "authentication", "A Kimchi bearer credential is required.");
    }

    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Kimchi currently supports the OpenAI Chat shape.");
    }

    const body = { ...request.body, model: target.modelId };

    return callSimpleProvider({
      url: `${UPSTREAM_BASE_URL}/chat/completions`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream,application/json",
        authorization: `Bearer ${credential.value}`,
        "user-agent": "kimchi/0.1.75",
      },
      body,
      signal,
      providerLabel: "Kimchi",
      isStreaming: (body as Record<string, unknown>).stream === true,
      decodeStream: decodeOpenAIChatStream,
      fetcher: proxy ? buildProxyFetcher(proxy) : undefined,
    });
  }
}

export const kimchiProvider = new KimchiProvider();
