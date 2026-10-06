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
 * `OpenAICompatibleAdapter` for the actual chat/responses call — the same
 * arrangement `kilo/kilo.ts` uses for its own envelope credential: the
 * decoded key is swapped into the credential the base class authenticates
 * with, so every other header the factory contributes (content type,
 * gateway identity, operator custom headers, route user-agent) stays
 * exactly as every other provider gets it.
 */
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { decodeMuseCredential } from "../../../lib/credential-codec";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import type { ProviderDispatchTarget, ProviderDispatchContext, ResolvedCredential } from "../../contracts";
import { providerBaseUrl } from "../../metadata";

export const MUSE_CODE_PROVIDER_ID = "muse" as const;
/** Root URL; model endpoint paths carry the `/v1/...` suffix. */
export const MUSE_CODE_BASE_URL = providerBaseUrl("muse");

// Model catalog — captured from provider models.json (`muse-code`)

import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

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

/**
 * Decodes the stored `{oauthAccessToken, apiKey}` envelope.
 *
 * Envelope parsing and field extraction live in `lib/credential-codec`;
 * this wrapper keeps the adapter's gateway-error semantics (a bad credential
 * is a sign-in problem, not a dispatch failure) and the Muse shape exported
 * for `muse-oauth.ts` (encoding) and `muse-quota.ts` (quota reads).
 */
export function parseMuseCodeCredential(
  secret: Uint8Array | string,
): MuseCodeCredential {
  try {
    return decodeMuseCredential(secret);
  } catch (error) {
    // Map the codec's three failure shapes back onto the original codes and
    // messages: unparseable (400, re-sign-in), parseable-but-not-an-object
    // (400), and parseable-but-incomplete (401). Same messages, same codes,
    // as before the extraction.
    const message = error instanceof Error ? error.message : "";
    if (message.endsWith("must be a JSON object")) {
      throw new GatewayError("invalid_request", 400, "muse: credential must be a JSON object");
    }
    if (message.endsWith("is not a valid JSON blob")) {
      throw new GatewayError(
        "invalid_request",
        400,
        "muse: credential is not a valid JSON blob; sign in again",
      );
    }
    throw new GatewayError(
      "authentication_failed",
      401,
      "muse: credential is missing oauthAccessToken or apiKey; sign in again",
    );
  }
}

export function encodeMuseCodeCredential(
  oauthAccessToken: string,
  apiKey: string,
): string {
  return JSON.stringify({ oauthAccessToken, apiKey });
}

// Adapter — unwraps the minted api_key, delegates to the shared base

export interface MuseCodeAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class MuseCodeAdapter extends OpenAICompatibleAdapter {
  constructor(options: MuseCodeAdapterOptions = {}) {
    super(
      withBearerAuthentication({
        provider_id: MUSE_CODE_PROVIDER_ID,
        base_url: options.baseUrl ?? MUSE_CODE_BASE_URL,
        endpoint_paths_by_wire_family: {
          chat: "/v1/chat/completions",
          responses: "/v1/responses",
        },
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      }),
    );
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
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
    const { apiKey } = decodeMuseCredential(context.credential.secret);
    // Hand the base class an `api_key` credential holding the minted key;
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
    return super.prepareHeaders({ ...context, credential: inner }, request, candidate);
  }
}

export function createMuseCodeAdapter(
  options: MuseCodeAdapterOptions = {},
): MuseCodeAdapter {
  return new MuseCodeAdapter(options);
}

export const museCodeAdapter: MuseCodeAdapter = createMuseCodeAdapter();
