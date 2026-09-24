import type { FetchLike } from "../quota/quota-contracts";
import type { ModelDefinition } from "../model-definition";

/**
 * Credential-scoped model-discovery input.
 *
 * Every adapter's `discover*Models` entry point takes the same three fields, so
 * the shape lives here instead of being redeclared per adapter. `fetcher` is the
 * transport seam tests inject; an adapter that always uses the global `fetch`
 * simply ignores it.
 */
export interface DiscoveryInput {
  readonly credential: string;
  readonly signal?: AbortSignal | undefined;
  readonly fetcher?: FetchLike | undefined;
}

/** Inputs supplied by model-discovery orchestration to a provider capability. */
interface ModelDiscoveryContext {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}

/** Provider-owned model discovery boundary. */
export type ProviderModelDiscovery = (
  context: ModelDiscoveryContext,
) => Promise<readonly ModelDefinition[] | null>;

/**
 * One-shot model connectivity probe contracts, shared by the provider
 * discovery orchestrator and the console catalog route layer. Lived here
 * (not in `console/`) so the lower discovery layer never imports console
 * presentation types.
 */

/**
 * Reasoning efforts a probe accepts, as a runtime tuple.
 *
 * Deliberately narrower than the canonical `REASONING_EFFORTS`: `none` says
 * nothing to probe and `max` is a provider-side ceiling the probe cannot
 * request usefully. Declared here beside `ProbeModelRequest` so the request
 * type and the route's Elysia schema project the same list.
 */
export const PROBE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Request accepted for a one-shot model connectivity test. `route`
 * disambiguates when a model id is registered under multiple endpoint
 * paths; omit it to probe against the model's already-registered wire
 * shape, or provide `wireFamily` to test a not-yet-registered candidate. */
export interface ProbeModelRequest {
  modelId: string;
  route?: string;
  wireFamily?: string;
  accountId?: string;
  prompt?: string;
  reasoningEffort?: (typeof PROBE_REASONING_EFFORTS)[number];
  maxOutputTokens?: number;
  stream?: boolean;
}
export interface ProbeModelResult {
  accountId?: string;
  ok: boolean;
  latencyMs: number;
  ttfbMs?: number;
  sample?: string;
  statusCode?: number;
  error?: string;
}

/**
 * Ad-hoc connectivity test for an operator-entered BYOK provider that has not
 * been persisted yet. Carries exactly the fields the create-provider modal
 * collects, so the console route never has to invent defaults the runtime
 * would not use.
 */
export interface ByokConnectionTestRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly wireFamily: string;
  /** Whether to stamp the wire family's official CLI identity headers. */
  readonly cliIdentity?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface ByokConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusCode?: number;
  /** Number of models the upstream advertised; absent when the body was not a list. */
  readonly modelCount?: number;
  readonly error?: string;
}

/** One entry of a batched provider-wide probe (`probeAllModels`). */
export interface ProbeAllModelsResult {
  providerId: string;
  results: ReadonlyArray<{
    modelId: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
  }>;
}
export interface ProbeAllAccountsResult {
  providerId: string;
  modelId: string;
  results: ReadonlyArray<ProbeModelResult>;
}
