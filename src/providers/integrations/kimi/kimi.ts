/**
 * Kimi Code (Moonshot) — subscription OAuth adapter.
 *
 * Kimi exposes an Anthropic-compatible Messages surface at
 * `api.kimi.com/coding/v1/messages` for the catalog's coding models. The
 * device-code OAuth access token is sent as a Bearer token and the shared
 * Claude Messages request/response pipeline supplies thinking blocks,
 * tool-use pairing, streaming, and `cache_control` prompt-cache markers.
 *
 * Kimi's reference catalog carries model bootstrap metadata that is not part
 * of Cartethyia's generic `ModelDefinition`: tokenizer family and prompt-cache
 * / max-token defaults. The exported lookup keeps this metadata centralized
 * and the adapter uses it when selecting request defaults.
 *
 * Bespoke by wire protocol (Phase C5): verified Claude-pipeline reuse
 * (Messages envelope via `../claude/*`) — stays bespoke, never re-audit.
 */
import type { ModelDefinition } from "../../provider-registry";
import { createHash } from "node:crypto";
import type { CanonicalEvent, CanonicalRequest } from "../../../transport/canonical-model";
import { isRecord } from "../../../protocol/primitives";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { GatewayError } from "../../../transport/gateway-error";
import {
  canonicalToClaudeMessagesPayload,
} from "../../../protocol/request/messages";
import { sendClaudeMessagesRequest } from "../../../protocol/transport/messages";
import { endpointUrl } from "../../../protocol/primitives";
import type { ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext } from "../../provider-registry";
import {
  getKimiCommonHeaders,
  parseKimiCredential,
} from "./kimi-oauth";
import { providerBaseUrl } from "../../provider-metadata";


export const KIMI_CODE_PROVIDER_ID = "kimi" as const;
export const KIMI_CODE_BASE_URL = providerBaseUrl("kimi");

export interface KimiModelBootstrap {
  readonly tokenizer?: "kimi-k2";
  readonly supportsPromptCache: boolean;
  readonly alwaysSendMaxTokens: boolean;
  readonly maxOutputTokens: number;
}

const KIMI_MODEL_BOOTSTRAP: Readonly<Record<string, KimiModelBootstrap>> = {
  k3: {
    supportsPromptCache: true,
    alwaysSendMaxTokens: false,
    maxOutputTokens: 131_072,
  },
  "k3-256k": {
    supportsPromptCache: true,
    alwaysSendMaxTokens: false,
    maxOutputTokens: 131_072,
  },
  "kimi-for-coding": {
    tokenizer: "kimi-k2",
    supportsPromptCache: true,
    alwaysSendMaxTokens: true,
    maxOutputTokens: 32_768,
  },
  "kimi-for-coding-highspeed": {
    tokenizer: "kimi-k2",
    supportsPromptCache: true,
    alwaysSendMaxTokens: true,
    maxOutputTokens: 32_768,
  },
  "kimi-k2": {
    tokenizer: "kimi-k2",
    supportsPromptCache: true,
    alwaysSendMaxTokens: true,
    maxOutputTokens: 262_144,
  },
  "kimi-k2-turbo-preview": {
    tokenizer: "kimi-k2",
    supportsPromptCache: true,
    alwaysSendMaxTokens: true,
    maxOutputTokens: 32_000,
  },
  "kimi-k2.5": {
    tokenizer: "kimi-k2",
    supportsPromptCache: true,
    alwaysSendMaxTokens: true,
    maxOutputTokens: 65_536,
  },
};
/** Returns the reference tokenizer family for a Kimi model, when one is declared. */
export function lookupKimiTokenizer(modelId: string): "kimi-k2" | undefined {
  return lookupKimiModelBootstrap(modelId)?.tokenizer;
}
/** Looks up Kimi's bootstrap tokenizer/cache metadata by model id. */
export function lookupKimiModelBootstrap(
  modelId: string,
): KimiModelBootstrap | undefined {
  return KIMI_MODEL_BOOTSTRAP[modelId.trim().toLowerCase()];
}



import { defineModel } from "../../model-definition";

const kimiModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "messages",
    endpoint: "/v1/messages",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    toolCall: true,
    webSearch: false,
  });

export const KIMI_CODE_MODELS: readonly ModelDefinition[] = [
  kimiModel("k3", 1_048_576, 131_072, true),
  kimiModel("k3-256k", 262_144, 131_072, true),
  kimiModel("kimi-for-coding", 262_144, 32_768, true),
  kimiModel("kimi-for-coding-highspeed", 262_144, 32_768, true),
  kimiModel("kimi-k2", 262_144, 262_144, false),
  kimiModel("kimi-k2-turbo-preview", 262_144, 32_000, false),
  kimiModel("kimi-k2.5", 262_144, 65_536, true),
];


export interface KimiCodeAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

/** Kimi adapter that delegates Messages translation and streaming to Claude's shared pipeline. */
class KimiCodeAdapter implements ProviderAdapter {
  readonly provider_id = KIMI_CODE_PROVIDER_ID;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: KimiCodeAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? KIMI_CODE_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `kimi supports messages only, got ${candidate.wire_family}`,
      );
    }
    if (context.credential.credential_kind !== "oauth") {
      throw new GatewayError(
        "invalid_request",
        400,
        `kimi: OAuth credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    if (!context.credential.secret) {
      throw new GatewayError(
        "authentication_failed",
        401,
        "kimi: OAuth credential secret is required",
      );
    }
    const credential = parseKimiCredential(
      new TextDecoder().decode(context.credential.secret),
    );
    const modelId = candidate.model_id || request.model;
    const bootstrap = lookupKimiModelBootstrap(modelId);
    const payload = canonicalToClaudeMessagesPayload(request, {
      // Kimi's bearer is an OAuth access token, but its API is not Claude's
      // OAuth endpoint: do not apply Claude Code tool-name prefixing or OAuth
      // max-token caps. Kimi's own per-model caps are applied below.
      isOAuth: false,
    });
    applyKimiBootstrap(payload, bootstrap, request);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      ...getKimiCommonHeaders(credential.deviceId),
    };
    const url = endpointUrl(
      this.#baseUrl,
      candidate.endpoint_path || "/v1/messages",
    );
    yield* sendClaudeMessagesRequest(
      url,
      headers,
      JSON.stringify(payload),
      context,
      request,
      this.#fetch,
      false,
    );
  }
}
function applyKimiBootstrap(
  payload: Record<string, unknown>,
  bootstrap: KimiModelBootstrap | undefined,
  request: CanonicalRequest,
): void {
  if (!bootstrap) return;
  // `canonicalToClaudeMessagesPayload` already emits the provider-native
  // `cache_control` marker whenever `request.cache_hint` is active. Keep this
  // guard explicit so a future model without prompt-cache support cannot
  // accidentally inherit one from a generic translation change.
  if (!bootstrap.supportsPromptCache && request.cache_hint !== undefined) {
    removeKimiCacheControls(payload);
  }
  const promptCacheKey = lookupKimiPromptCacheKey(request);
  if (bootstrap.supportsPromptCache && promptCacheKey !== undefined) {
    const metadata = isRecord(payload["metadata"])
      ? (payload["metadata"] as Record<string, unknown>)
      : {};
    metadata["user_id"] = promptCacheKey;
    payload["metadata"] = metadata;
  }
  const currentMax = payload["max_tokens"];
  if (typeof currentMax === "number") {
    payload["max_tokens"] = Math.min(currentMax, bootstrap.maxOutputTokens);
  } else if (bootstrap.alwaysSendMaxTokens) {
    payload["max_tokens"] = bootstrap.maxOutputTokens;
  }
}

/** Looks up Kimi's normalized prompt-cache affinity key from canonical controls. */
export function lookupKimiPromptCacheKey(
  request: CanonicalRequest,
): string | undefined {
  const raw = resolvePromptCacheKey(request);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 64) return trimmed;
  return `pc_${createHash("sha256").update(trimmed).digest("hex").slice(0, 61)}`;
}

function removeKimiCacheControls(payload: Record<string, unknown>): void {
  const removeFrom = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      delete (item as Record<string, unknown>)["cache_control"];
      const content = (item as Record<string, unknown>)["content"];
      removeFrom(content);
    }
  };
  removeFrom(payload["system"]);
  removeFrom(payload["messages"]);
  removeFrom(payload["tools"]);
}

export function createKimiCodeAdapter(
  options: KimiCodeAdapterOptions = {},
): ProviderAdapter {
  return new KimiCodeAdapter(options);
}

export const kimiCodeAdapter: ProviderAdapter = createKimiCodeAdapter();
