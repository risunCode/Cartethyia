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
import { decryptCredential } from "../../console/crypto/credential-key";
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

function upstreamErrorKind(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

/** Combines the caller's abort signal with the provider's configured request timeout (REQ-8). */
function withTimeout(signal: AbortSignal, timeoutSeconds: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)]);
}

async function callOpenAICompatible(record: CustomProviderRecord, model: string, body: Record<string, unknown>, signal: AbortSignal, proxy: string | undefined): Promise<ProviderResult> {
  const apiKey = await decryptCredential(record.credentialEnc);
  const outboundBody: Record<string, unknown> = { ...body, model };
  const isStreaming = outboundBody.stream === true;

  const res = await fetch(`${record.baseUrl}/chat/completions`, {
    method: "POST",
    // Custom headers apply last so an operator's org/routing/WAF-bypass
    // header wins over the built-in auth/content-type on collision.
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...record.customHeaders },
    body: JSON.stringify(outboundBody),
    signal: withTimeout(signal, record.timeoutSeconds),
    ...(proxy ? { proxy } : {}),
  });

  if (!res.ok) throw new ProviderCallError(res.status, upstreamErrorKind(res.status), `Custom provider "${record.name}" returned ${res.status}.`);
  if (!res.body) throw new ProviderCallError(502, "unavailable", `Custom provider "${record.name}" returned an empty response body.`);

  if (isStreaming) return { type: "stream", events: decodeOpenAIChatStream(res.body) };

  const jsonBody: unknown = await res.json();
  if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
    throw new ProviderCallError(502, "malformed_response", `Custom provider "${record.name}" returned an unreadable JSON response.`);
  }
  return { type: "json", body: jsonBody as Record<string, unknown> };
}

async function callAnthropicCompatible(record: CustomProviderRecord, model: string, body: Record<string, unknown>, signal: AbortSignal, proxy: string | undefined): Promise<ProviderResult> {
  const apiKey = await decryptCredential(record.credentialEnc);
  const anthropicReq = translateChatRequestToAnthropic({ ...body, model } as OpenAIChatRequest);
  const isStreaming = anthropicReq.stream === true;

  const res = await fetch(`${record.baseUrl}/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", ...record.customHeaders },
    body: JSON.stringify(anthropicReq),
    signal: withTimeout(signal, record.timeoutSeconds),
    ...(proxy ? { proxy } : {}),
  });

  if (!res.ok) throw new ProviderCallError(res.status, upstreamErrorKind(res.status), `Custom provider "${record.name}" returned ${res.status}.`);
  if (!res.body) throw new ProviderCallError(502, "unavailable", `Custom provider "${record.name}" returned an empty response body.`);

  if (isStreaming) return { type: "stream", events: decodeAnthropicStream(res.body) };

  const jsonBody: unknown = await res.json();
  if (jsonBody === null || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
    throw new ProviderCallError(502, "malformed_response", `Custom provider "${record.name}" returned an unreadable JSON response.`);
  }
  return { type: "json", body: translateAnthropicResponseToChat(jsonBody as AnthropicResponse) as unknown as Record<string, unknown> };
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
    hasCapability: (): boolean => false,
  };

  resolveTarget(modelId: string): RouteTarget | undefined {
    const split = splitSlugModel(modelId);
    if (!split) return undefined;
    if (!getCustomProviderBySlug(split.slug)) return undefined;
    return { provider: "custom", modelId, surface: "openai-chat", credential: "none", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, _credential: ResolvedCredential, signal: AbortSignal, proxy?: string): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Custom providers currently support the OpenAI Chat shape.");
    }
    const split = splitSlugModel(target.modelId);
    if (!split) throw new ProviderCallError(400, "invalid_request", "Custom provider model must be qualified as <slug>/<model>.");

    const record = getCustomProviderBySlug(split.slug);
    if (!record) throw new ProviderCallError(404, "invalid_request", `Custom provider "${split.slug}" no longer exists.`);

    return record.type === "anthropic-compatible"
      ? callAnthropicCompatible(record, split.model, request.body, signal, proxy)
      : callOpenAICompatible(record, split.model, request.body, signal, proxy);
  }
}

export const dynamicProviderRouter = new DynamicProviderRouter();
