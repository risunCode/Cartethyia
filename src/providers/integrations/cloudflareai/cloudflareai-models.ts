/**
 * Cloudflare AI Gateway model catalog.
 *
 * A gateway rather than a model host, which shapes this file twice over:
 *
 * 1. **Only the Anthropic route is reachable.** The path suffix `/anthropic`
 *    selects the protocol Cloudflare proxies on, and the adapter builds that
 *    suffix from the stored account slugs (`cloudflareai.ts`). models.dev files
 *    47 rows for this gateway across `anthropic/`, `openai/`, `xai/`, `alibaba/`
 *    and others; every non-Anthropic namespace would be dispatched to a suffix
 *    the gateway does not serve, so those rows are absent rather than listed and
 *    broken.
 * 2. **The ids are the bare Anthropic names.** On the `/anthropic` route the
 *    gateway resolves `claude-opus-5`; the `anthropic/` prefix is how models.dev
 *    namespaces it among the gateway's 47, and oh-my-pi's own seed row for this
 *    provider carries the bare id against the same base URL.
 *
 * No cost column: a gateway bills through the operator's own Cloudflare plan,
 * so the price is not a row fact. `defineModel` resolves it from the base
 * catalog's rate for the model itself, which is the documented fallback when a
 * routed provider files no price of its own.
 *
 * Every row states its context window explicitly because they disagree by 5x —
 * Haiku and Opus 4.5 at 200k, the rest at 1M — and the shared default would
 * flatten that.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

export const CLOUDFLAREAI_PROVIDER_ID = "cloudflareai" as const;

/** Messages path below the account's `/anthropic` base. */
const MESSAGES_ENDPOINT = "/v1/messages";

type CatalogRow = readonly [id: string, context: number, output: number];

function cloudflareaiModel([id, context, output]: CatalogRow): ModelDefinition {
  return defineModel({
    id,
    providerId: CLOUDFLAREAI_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: MESSAGES_ENDPOINT,
    ctx: context,
    out: output,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  });
}

/** Static Anthropic-route catalog for one account's Cloudflare AI Gateway. */
export const CLOUDFLAREAI_MODELS: readonly ModelDefinition[] = [
  ["claude-fable-5", 1_000_000, 128_000] as const,
  ["claude-fable-5.1", 1_000_000, 128_000] as const,
  ["claude-haiku-4.5", 200_000, 64_000] as const,
  ["claude-opus-4.5", 200_000, 64_000] as const,
  ["claude-opus-4.6", 1_000_000, 128_000] as const,
  ["claude-opus-4.7", 1_000_000, 128_000] as const,
  ["claude-opus-4.8", 1_000_000, 128_000] as const,
  ["claude-opus-5", 1_000_000, 128_000] as const,
  ["claude-sonnet-4.5", 1_000_000, 64_000] as const,
  ["claude-sonnet-4.6", 1_000_000, 128_000] as const,
  ["claude-sonnet-5", 1_000_000, 128_000] as const,
].map(cloudflareaiModel);
