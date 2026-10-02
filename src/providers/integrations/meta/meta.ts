/**
 * Meta Model API — direct API-key access to Meta's first-party Responses wire.
 *
 * Distinct from `muse` (Muse Code): both land on the same `api.meta.ai/v1`
 * OpenAI-Responses-compatible surface and serve the same `muse-spark-*`
 * catalog, but the Model API is authenticated with an operator-supplied API
 * key from the Meta developer dashboard, whereas Muse Code mints its key from a
 * subscription OAuth device login. Because the wire and models are identical,
 * the adapter is the shared `createApiKeyAdapter` with the `/v1`-prefixed
 * paths, and the catalog is the same list `muse` uses — one declaration of the
 * `muse-spark` roster, not a copy that can drift.
 */
import { createApiKeyAdapter } from "../configured-provider";
import type { ProviderAdapter } from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";
import { MUSE_CODE_MODELS } from "../muse/muse";

export const META_PROVIDER_ID = "meta" as const;
/** Root URL; the Responses path carries the `/v1` prefix. */
export const META_BASE_URL = providerBaseUrl("meta");

/** The `muse-spark` roster, shared with Muse Code (same upstream catalog). */
export const META_MODELS = MUSE_CODE_MODELS;

export const META_SPEC = {
  provider_id: META_PROVIDER_ID,
  base_url: META_BASE_URL,
  endpoint_paths_by_wire_family: {
    chat: "/v1/chat/completions",
    responses: "/v1/responses",
  },
} as const;

export function createMetaAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return createApiKeyAdapter(META_SPEC, fetchImpl);
}

export const metaAdapter: ProviderAdapter = createMetaAdapter();
