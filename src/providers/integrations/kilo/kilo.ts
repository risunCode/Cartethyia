/**
 * Kilo Code adapter.
 *
 * Kilo Code resells the OpenRouter catalog behind a bearer device token on an
 * OpenAI-compatible chat surface, so this adapter reuses the shared factory for
 * payload translation, transport, and SSE decoding.
 *
 * One thing sits outside the declarative `ApiKeyProviderSpec`: the stored
 * credential is a JSON envelope (`{ accessToken, orgId }`) because the gateway
 * scopes every request to the account's organization and the console stores one
 * opaque string per account. The factory forwards that string as the bearer
 * verbatim, so the envelope is decoded at the auth boundary here — the same
 * arrangement `kimi/kimi.ts` uses for its own envelope credential.
 *
 * The base URL is the completions path itself, because that is the path Kilo
 * Code publishes (`/api/openrouter/chat/completions`) and it is not derivable
 * from an origin plus a wire-family suffix.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../../provider-registry";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import { providerBaseUrl } from "../../provider-metadata";
import { decodeKiloCredential } from "../../../lib/credential-codec";

export const KILO_PROVIDER_ID = "kilo" as const;
export const KILO_BASE_URL = providerBaseUrl("kilo");

/**
 * Endpoint path recorded on this provider's model rows and used by the adapter.
 *
 * The base URL carries Kilo Code's API prefix (`/api/openrouter`), so this is
 * the wire suffix that completes it — the same split Cline uses for
 * `/api/v1` + `/chat/completions`.
 */
export const KILO_ENDPOINT_PATH = "/chat/completions" as const;

interface KiloModelOptions {
  readonly vision?: boolean;
  readonly document?: boolean;
  readonly audio?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
}

function kiloModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: KiloModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: KILO_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: KILO_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    document: options.document ?? false,
    audio: options.audio ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: options.toolCall ?? true,
  });
}

/**
 * Static fallback catalog, read from the live `/api/gateway/models` directory.
 *
 * Live discovery replaces this list whenever an account is available, so these
 * rows are the offline floor: the gateway's own routing aliases plus one
 * current model per family it resells. Limits and capability come from the
 * directory entry's own `top_provider` / `architecture` /
 * `supported_parameters` fields rather than from the base catalog, which prices
 * the underlying model and not this reseller's serving.
 */
export const KILO_MODELS: readonly ModelDefinition[] = [
  kiloModel("kilo-auto/frontier", 1_000_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("kilo-auto/balanced", 1_000_000, 65_536, { vision: true, reasoning: true }),
  kiloModel("kilo-auto/efficient", 1_000_000, 65_536, { vision: true, reasoning: true }),
  kiloModel("kilo-auto/small", 262_144, 32_768, { vision: true, reasoning: true }),
  kiloModel("kilo-auto/free", 256_000, 32_768, { reasoning: true }),
  kiloModel("anthropic/claude-opus-4.8", 1_000_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("anthropic/claude-opus-4.7", 1_000_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("anthropic/claude-sonnet-4.6", 1_000_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("openai/gpt-6-sol", 1_050_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("openai/gpt-6-luna", 1_050_000, 128_000, { vision: true, document: true, reasoning: true }),
  kiloModel("openai/gpt-4.1", 1_047_576, 32_768, { vision: true, document: true }),
  kiloModel("openai/o3", 200_000, 100_000, { vision: true, document: true, reasoning: true }),
  kiloModel("google/gemini-2.5-pro", 1_048_576, 65_536, { vision: true, document: true, audio: true, reasoning: true }),
  kiloModel("google/gemini-2.5-flash", 1_048_576, 65_535, { vision: true, document: true, audio: true, reasoning: true }),
  kiloModel("x-ai/grok-4.7", 500_000, 450_000, { vision: true, document: true, reasoning: true }),
  kiloModel("moonshotai/kimi-k3", 1_048_576, 943_718, { vision: true, reasoning: true }),
  kiloModel("z-ai/glm-5.3-flash", 1_048_576, 131_072, { vision: true, reasoning: true }),
  kiloModel("deepseek/deepseek-chat", 163_840, 16_384),
];

/**
 * Adapter that decodes the credential envelope before the shared pipeline
 * authenticates the request.
 *
 * `prepareHeaders` is corrected rather than rebuilt: every other header the
 * factory contributes (content type, gateway identity, operator custom headers,
 * route user-agent) stays exactly as every other provider gets it.
 */
class KiloAdapter extends OpenAICompatibleAdapter {
  constructor(fetchImpl?: typeof fetch) {
    super(
      withBearerAuthentication({
        provider_id: KILO_PROVIDER_ID,
        base_url: KILO_BASE_URL,
        endpoint_paths_by_wire_family: { chat: KILO_ENDPOINT_PATH },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers = await super.prepareHeaders(context, request, candidate);
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return headers;
    // A credential that does not decode is left as the factory sent it: the
    // request then fails closed at the upstream auth boundary, and the parse
    // error belongs to the credential boundary rather than to this hook.
    let credential: ReturnType<typeof decodeKiloCredential>;
    try {
      credential = decodeKiloCredential(secret);
    } catch {
      return headers;
    }
    headers.authorization = `Bearer ${credential.accessToken}`;
    // The upstream's own header name, not ours: renaming the Cartethyia
    // provider id does not rename a field the upstream reads.
    if (credential.orgId !== undefined) headers["X-Kilocode-OrganizationID"] = credential.orgId;
    return headers;
  }
}

/** Kilo Code provider adapter. */
export const kiloAdapter: ProviderAdapter = new KiloAdapter();

