/**
 * Custom Providers dispatch (REQ-8) — one internal provider (id "custom"),
 * data-driven by `custom_providers` DB rows instead of a compiled module per
 * endpoint. Each row's own `slug` is what callers actually address
 * (`<slug>/<model>`, no `custom/` wrapper — see `routing/resolve.ts`'s
 * `parseQualifiedModel`, which resolves that slug back to this provider).
 * `target.modelId` internally still carries `<slug>/<model>`; this provider
 * re-splits it at resolve and call time to find the record.
 *
 * `openai-compatible` forwards the OpenAI Chat Completions-shaped body as-is
 * (it's already in that shape by the time a request reaches a provider).
 * `anthropic-compatible` runs it through the existing bidirectional
 * OpenAI↔Anthropic translators — the same ones `routes/responses.ts` and
 * `routes/messages.ts` already use for their Anthropic fallback paths.
 */

import type { RouteTarget } from "../../routing/types";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import { decodeAnthropicStream, decodeOpenAIChatStream } from "../bridge";
import { callSimpleProvider } from "./simple-call";
import { fetchWithSsrfGuard } from "../../http/ssrf-guard";
import { getCustomProviderBySlug, type CustomProviderRecord } from "../../console/db/repos/custom-providers";
import type { ProviderModelEntry } from "./models";
import { translateAnthropicResponseToChat, translateChatRequestToAnthropic } from "../../translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatRequest } from "../../translate/types";

function splitSlugModel(modelId: string): { slug: string; model: string } | undefined {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex === -1) return undefined;
  const slug = modelId.slice(0, slashIndex);
  const model = modelId.slice(slashIndex + 1);
  if (!slug || !model) return undefined;
  return { slug, model };
}

/** Combines the caller's abort signal with the provider's configured request timeout (REQ-8). */
function withTimeout(signal: AbortSignal, timeoutSeconds: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)]);
}

async function callOpenAICompatible(record: CustomProviderRecord, model: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResult> {
  const outboundBody: Record<string, unknown> = { ...body, model };

  return callSimpleProvider({
    url: `${record.baseUrl}/chat/completions`,
    // Custom headers apply last so an operator's org/routing/WAF-bypass
    // header wins over the built-in auth/content-type on collision.
    headers: { authorization: `Bearer ${record.credential}`, "content-type": "application/json", ...record.customHeaders },
    body: outboundBody,
    signal: withTimeout(signal, record.timeoutSeconds),
    providerLabel: `Custom provider "${record.name}"`,
    isStreaming: outboundBody.stream === true,
    decodeStream: decodeOpenAIChatStream,
    fetcher: fetchWithSsrfGuard,
  });
}

async function callAnthropicCompatible(record: CustomProviderRecord, model: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResult> {
  const anthropicReq = translateChatRequestToAnthropic({ ...body, model } as OpenAIChatRequest);

  return callSimpleProvider({
    url: `${record.baseUrl}/messages`,
    headers: { "x-api-key": record.credential, "anthropic-version": "2023-06-01", "content-type": "application/json", ...record.customHeaders },
    body: anthropicReq,
    signal: withTimeout(signal, record.timeoutSeconds),
    providerLabel: `Custom provider "${record.name}"`,
    isStreaming: anthropicReq.stream === true,
    decodeStream: decodeAnthropicStream,
    translateJson: (json) => translateAnthropicResponseToChat(json as unknown as AnthropicResponse) as unknown as Record<string, unknown>,
    fetcher: fetchWithSsrfGuard,
  });
}

class DynamicProviderRouter implements Provider {
  readonly id = "custom" as const;
  readonly display = {
    name: "Custom Providers",
    icon: "custom",
    authKind: "api-key",
    authHint: "Each custom provider stores its own bearer credential.",
  } as const;
  readonly models = {
    // Custom providers accept arbitrary upstream model ids per registered
    // endpoint — there is no fixed catalog to list or resolve against.
    list: (): ProviderModelEntry[] => [],
    resolve: (): ProviderModelEntry | undefined => undefined,
  };

  resolveTarget(modelId: string): RouteTarget | undefined {
    const split = splitSlugModel(modelId);
    if (!split) return undefined;
    if (!getCustomProviderBySlug(split.slug)) return undefined;
    return { provider: "custom", modelId, surface: "openai-chat", credential: "none", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, _credential: ResolvedCredential, signal: AbortSignal): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Custom providers currently support the OpenAI Chat shape.");
    }
    const split = splitSlugModel(target.modelId);
    if (!split) throw new ProviderCallError(400, "invalid_request", "Custom provider model must be qualified as <slug>/<model>.");

    const record = getCustomProviderBySlug(split.slug);
    if (!record) throw new ProviderCallError(404, "invalid_request", `Custom provider "${split.slug}" no longer exists.`);

    return record.type === "anthropic-compatible"
      ? callAnthropicCompatible(record, split.model, request.body, signal)
      : callOpenAICompatible(record, split.model, request.body, signal);
  }

  async countTokens(target: RouteTarget, body: Record<string, unknown>, _credential: ResolvedCredential, signal: AbortSignal): Promise<{ inputTokens: number }> {
    const split = splitSlugModel(target.modelId);
    if (!split) throw new ProviderCallError(400, "invalid_request", "Custom provider model must be qualified as <slug>/<model>.");

    const record = getCustomProviderBySlug(split.slug);
    if (!record) throw new ProviderCallError(404, "invalid_request", `Custom provider "${split.slug}" no longer exists.`);
    if (record.type !== "anthropic-compatible") {
      throw new ProviderCallError(400, "invalid_request", `Custom provider "${record.name}" is OpenAI-compatible; count_tokens requires an Anthropic-compatible endpoint.`);
    }

    const { stream: _stream, max_tokens: _maxTokens, ...rest } = body;
    const outbound = { ...rest, model: split.model };

    const result = await callSimpleProvider({
      url: `${record.baseUrl}/messages/count_tokens`,
      headers: { "x-api-key": record.credential, "anthropic-version": "2023-06-01", "content-type": "application/json", ...record.customHeaders },
      body: outbound,
      signal: withTimeout(signal, record.timeoutSeconds),
      providerLabel: `Custom provider "${record.name}"`,
      isStreaming: false,
      decodeStream: decodeAnthropicStream,
      fetcher: fetchWithSsrfGuard,
    });
    const json = result.type === "json" ? result.body : {};
    const inputTokens = typeof json.input_tokens === "number" ? json.input_tokens : 0;
    return { inputTokens };
  }
}

export const dynamicProviderRouter = new DynamicProviderRouter();
