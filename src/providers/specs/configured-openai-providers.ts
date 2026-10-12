import type { ApiKeyProviderSpec } from "../integrations/shared/configured-provider";
import type { ProviderId } from "../contracts";

/**
 * Builtin providers whose entire adapter contract is "bearer auth against the
 * provider's `BUNDLED_PROVIDER_METADATA` base URL, OpenAI-compatible chat +
 * responses, `/v1`-prefixed paths". They carry no catalog, no OAuth, and no
 * provider-specific payload hook, so they share one spec shape rather than
 * one module each.
 *
 * `base_url` is resolved per provider by `providerBaseUrl(provider_id)`.
 *
 * These providers list their models through live `/v1/models` discovery rather
 * than a static catalog: every one of them republishes an aggregator's whole
 * roster, which changes faster than a committed array can. Each registry row
 * pairs this spec with `openAIModelDiscovery`.
 */
export const GENERIC_API_KEY_PROVIDER_IDS = [
  "mistral",
  "fireworks",
  "nvidia",
  "gmi",
  "ollamacloud",
  "together",
  "siliconflow",
  "siliconflowcn",
  "nanogpt",
  "baseten",
  "synthetic",
  "stepfun",
  "sakana",
  "helmcode",
  "coralbricks",
  "aiand",
  "wafer",
  "coreweave",
  "qwen-portal",
  // `deepseek` is intentionally absent: it dispatches on the Anthropic Messages
  // wire at its `/anthropic` root, not the OpenAI chat/responses wires, so it
  // carries a dedicated entry in `default-registry.ts` instead.
  //
  // The aggregators below are absent for a different reason: their base URL is
  // already rooted at a version segment that the `/v1`-prefixed path this shape
  // pins would duplicate (`/openai/v1`, `/v1/openai`, `/v3/openai`, `/api/v1`,
  // `/v2`, and `/inference/v1`), so `joinUrl` would produce
  // `…/v1/v1/chat/completions`. They use `versionedRootApiKeySpec` instead,
  // which pins the path below the version root — the same reason `cerebras`
  // declares `/chat/completions` explicitly.
] as const;

/**
 * Ids whose base URL already ends at a version segment.
 *
 * `joinUrl` is plain concatenation and nothing rewrites a declared path, so a
 * base already rooted at a version plus a `/v1/…` path doubles the segment and
 * every request 404s. These specs therefore declare the path *below* the
 * version root. That is the provider stating the truth about its own wire, not
 * a correction applied to it: a wrong path now reaches the operator as the
 * wrong URL instead of being quietly rewritten into a different address.
 */
export const VERSIONED_ROOT_API_KEY_PROVIDER_IDS = [
  "groq",
  "deepinfra",
  "novita",
  "venice",
  "qianfan",
  "zhipucoding",
  "firepass",
] as const;

export type VersionedRootApiKeyProviderId =
  (typeof VERSIONED_ROOT_API_KEY_PROVIDER_IDS)[number];

function versionedRootApiKeySpec(providerId: ProviderId): ApiKeyProviderSpec {
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: {
      chat: "/chat/completions",
      responses: "/responses",
    },
  };
}

export const VERSIONED_ROOT_API_KEY_SPECS = {
  groq: versionedRootApiKeySpec("groq"),
  deepinfra: versionedRootApiKeySpec("deepinfra"),
  novita: versionedRootApiKeySpec("novita"),
  venice: versionedRootApiKeySpec("venice"),
  qianfan: versionedRootApiKeySpec("qianfan"),
  zhipucoding: versionedRootApiKeySpec("zhipucoding"),
  firepass: versionedRootApiKeySpec("firepass"),
} satisfies Readonly<Record<VersionedRootApiKeyProviderId, ApiKeyProviderSpec>>;

/**
 * One id that has both a generic spec and a registry row.
 *
 * Exported so the registry can be checked against the spec list rather than
 * repeating the id as a string: `discoveryBackedProvider` takes this type, so a
 * row naming a provider with no spec is a compile error instead of an
 * `undefined` adapter at first dispatch.
 */
export type GenericApiKeyProviderId = (typeof GENERIC_API_KEY_PROVIDER_IDS)[number];

function genericApiKeySpec(providerId: GenericApiKeyProviderId): ApiKeyProviderSpec {
  // These roots are *not* bare hosts — every one of them already ends at `/v1`
  // — so the path is declared below that root. It used to be pinned from
  // `BARE_ROOT_ENDPOINTS` and silently corrected at dispatch, which meant the
  // declared path was wrong for all of them and nothing said so. Both spec
  // shapes now declare the same thing, so this is the one implementation.
  return versionedRootApiKeySpec(providerId);
}

export const GENERIC_API_KEY_SPECS = {
  mistral: genericApiKeySpec("mistral"),
  fireworks: genericApiKeySpec("fireworks"),
  nvidia: genericApiKeySpec("nvidia"),
  gmi: genericApiKeySpec("gmi"),
  ollamacloud: genericApiKeySpec("ollamacloud"),
  together: genericApiKeySpec("together"),
  siliconflow: genericApiKeySpec("siliconflow"),
  siliconflowcn: genericApiKeySpec("siliconflowcn"),
  nanogpt: genericApiKeySpec("nanogpt"),
  baseten: genericApiKeySpec("baseten"),
  synthetic: genericApiKeySpec("synthetic"),
  stepfun: genericApiKeySpec("stepfun"),
  sakana: genericApiKeySpec("sakana"),
  helmcode: genericApiKeySpec("helmcode"),
  coralbricks: genericApiKeySpec("coralbricks"),
  aiand: genericApiKeySpec("aiand"),
  wafer: genericApiKeySpec("wafer"),
  coreweave: genericApiKeySpec("coreweave"),
  "qwen-portal": genericApiKeySpec("qwen-portal"),
} satisfies Readonly<Record<GenericApiKeyProviderId, ApiKeyProviderSpec>>;