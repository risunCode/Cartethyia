/**
 * Muse Code (Meta) — subscription OAuth adapter.
 *
 * Muse Code lands on Meta's `api.meta.ai/v1` OpenAI-compatible surface
 * behind a per-subscription minted API key. The device-code login
 * (`auth.meta.com/oidc/device/*`) yields an OAuth access token; a
 * follow-up `POST /muse-code/key` exchanges that for the `api_key` the
 * model backend accepts as `Authorization: Bearer <apiKey>`.
 *
 * Credential encoding: the `oauth` credential's `secret` is a UTF-8
 * `{oauthAccessToken, apiKey}` JSON blob (matches provider's
 * `parseMuseCodeCredential` contract). The adapter unwraps the minted
 * api_key at dispatch time and hands it to the shared
 * `OpenAICompatibleAdapter` for the actual chat/responses call.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../../transport/canonical-model";
import { GatewayError } from "../../../transport/gateway-error";
import { createApiKeyAdapter } from "../configured-provider";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
  ResolvedCredential,
} from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";

export const MUSE_CODE_PROVIDER_ID = "muse" as const;
/** Root URL; model endpoint paths carry the `/v1/...` suffix. */
export const MUSE_CODE_BASE_URL = providerBaseUrl("muse");

// Model catalog — captured from provider models.json (`muse-code`)



import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

const museModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "responses",
    endpoint: "/v1/responses",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  });

export const MUSE_CODE_MODELS: readonly ModelDefinition[] = [
  museModel("muse-spark-1.1", 1_048_576, 131_072),
  museModel("muse-spark-1.2", 1_048_576, 131_072),
  museModel("muse-spark-1.2-contributor", 1_048_576, 131_072),
  museModel("muse-spark-1.3", 1_048_576, 131_072),
  museModel("muse-spark-1.3-contributor", 1_048_576, 131_072),
];


// Credential wrapping — {oauthAccessToken, apiKey} JSON blob

export interface MuseCodeCredential {
  readonly oauthAccessToken: string;
  readonly apiKey: string;
}

export function parseMuseCodeCredential(
  secret: Uint8Array | string,
): MuseCodeCredential {
  const decoded =
    typeof secret === "string" ? secret.trim() : new TextDecoder().decode(secret).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new GatewayError(
      "invalid_request",
      400,
      "muse: credential is not a valid JSON blob; sign in again",
    );
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new GatewayError(
      "invalid_request",
      400,
      "muse: credential must be a JSON object",
    );
  }
  const record = payload as Record<string, unknown>;
  const oauthAccessToken =
    typeof record["oauthAccessToken"] === "string"
      ? record["oauthAccessToken"].trim()
      : "";
  const apiKey =
    typeof record["apiKey"] === "string" ? record["apiKey"].trim() : "";
  if (!oauthAccessToken || !apiKey) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "muse: credential is missing oauthAccessToken or apiKey; sign in again",
    );
  }
  return { oauthAccessToken, apiKey };
}

export function encodeMuseCodeCredential(
  oauthAccessToken: string,
  apiKey: string,
): string {
  return JSON.stringify({ oauthAccessToken, apiKey });
}

// Adapter — unwraps the minted api_key, delegates to the shared factory

export interface MuseCodeAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class MuseCodeAdapter implements ProviderAdapter {
  readonly provider_id = MUSE_CODE_PROVIDER_ID;
  readonly #inner: ProviderAdapter;

  constructor(options: MuseCodeAdapterOptions = {}) {
    this.#inner = createApiKeyAdapter(
      {
        provider_id: MUSE_CODE_PROVIDER_ID,
        base_url: options.baseUrl ?? MUSE_CODE_BASE_URL,
        endpoint_paths_by_wire_family: {
          chat: "/v1/chat/completions",
          responses: "/v1/responses",
        },
      },
      options.fetch,
    );
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (context.credential.credential_kind !== "oauth") {
      throw new GatewayError(
        "invalid_request",
        400,
        `muse: OAuth credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    if (!context.credential.secret) {
      throw new GatewayError(
        "authentication_failed",
        401,
        "muse: OAuth credential secret is required",
      );
    }
    const { apiKey } = parseMuseCodeCredential(context.credential.secret);
    // Hand the shared factory an `api_key` credential holding the minted key;
    // the OAuth access token stays out of the request headers entirely.
    const inner: ResolvedCredential = {
      provider_id: context.credential.provider_id,
      credential_kind: "api_key",
      secret: new TextEncoder().encode(apiKey),
      ...(context.credential.account_id
        ? { account_id: context.credential.account_id }
        : {}),
      ...(context.credential.custom_headers
        ? { custom_headers: context.credential.custom_headers }
        : {}),
    };
    yield* this.#inner.dispatch(request, candidate, {
      ...context,
      credential: inner,
    });
  }
}

export function createMuseCodeAdapter(
  options: MuseCodeAdapterOptions = {},
): ProviderAdapter {
  return new MuseCodeAdapter(options);
}

export const museCodeAdapter: ProviderAdapter = createMuseCodeAdapter();

