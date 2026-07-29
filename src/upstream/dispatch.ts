import type { RouteTarget } from "../routing/types";
import type { Provider, ProviderRequest, ProviderResult } from "./providers/index";
import type { ResolvedCredential } from "./providers/index";
import { getProviderRouting } from "../console/db/repos/routing";
import { getPool } from "../console/db/repos/proxy-pools";
import { withRetry, createTimeoutSignal, DEFAULT_RETRY_CONFIG, type RetryConfig } from "./retry";
import { isRetryableError } from "./retry";
import { resolveAllComboTargets, resolveQualifiedTarget, credentialKindOf } from "../routing/resolve";
import { isProviderId } from "../routing/providerMeta";
import { prepareOutboundRequest } from "./outbound";
import { resolveCredential } from "./credentials";
import { providerRegistry } from "./providers";
import { getRequestTransformSettings } from "../console/runtime";
import {
  pickAccountForRotation,
  markAccountUnavailable,
  clearAccountCooldown,
  getRetryAfterSeconds,
  RESOLVED_KIND_BY_ACCOUNT_KIND,
  type CredentialKind,
} from "../console/db/repos/accounts";
import { decryptCredential } from "../console/crypto/credential-key";
import { createRotationStore, pickRotationIndex } from "./rotation";

export interface DispatchableRoute {
  target: RouteTarget;
  request: ProviderRequest;
  credential: ResolvedCredential;
  proxyPoolName?: string;
}

export interface ProviderRegistry {
  get(provider: RouteTarget["provider"]): Provider | undefined;
}

/** Connect timeout for provider fetch calls (C3). */
const FETCH_CONNECT_TIMEOUT_MS = 60_000;

/** Retry config for dispatch (C2). Can be overridden per-provider if needed. */
const DISPATCH_RETRY_CONFIG: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30_000,
};

export interface DispatchOutcome {
  result: ProviderResult;
  proxyPoolName?: string;
}

/** Proxy-pool entry rotation state, keyed by pool id — shares the same primitive as account rotation (REQ-6). */
const poolRotationState = createRotationStore<string>();

export async function dispatchProvider(
  registry: ProviderRegistry,
  route: DispatchableRoute,
  signal: AbortSignal
): Promise<DispatchOutcome> {
  const provider = registry.get(route.target.provider);
  if (!provider) {
    throw new Error(`No provider implementation for ${route.target.provider}`);
  }

  // Create a combined signal: connect timeout + client abort (C3)
  const timeoutSignal = createTimeoutSignal(FETCH_CONNECT_TIMEOUT_MS, signal);

  // Resolve proxy pool for this provider's routing config.
  const routing = getProviderRouting(route.target.provider);
  let proxyUrl: string | undefined;
  if (routing.proxyPoolId) {
    const pool = getPool(routing.proxyPoolId);
    if (pool && pool.entries.length > 0) {
      const idx = pickRotationIndex(poolRotationState, pool.id, pool.entries.length, 1);
      proxyUrl = pool.entries[idx]!.url;
      route.proxyPoolName = pool.name;
    }
  }

  const result = await withRetry(
    () => provider.call(route.target, route.request, route.credential, timeoutSignal, proxyUrl),
    DISPATCH_RETRY_CONFIG,
    (attempt, delayMs, error) => {
      void attempt;
      void delayMs;
      void error;
    },
  );
  return { result, proxyPoolName: route.proxyPoolName };
}

// ─────────────────── Qualified-route dispatch (REQ-4) ──────────────────────
//
// The high-level pipeline: model chain resolution → outbound transforms →
// credential rotation → dispatchProvider (above) → combo failover on error.
// Used by every /v1/* route AND, via the `compact` option, by emulated
// compaction — one implementation instead of two independently maintained
// resolve/credential/dispatch chains.

export type QualifiedDispatchResult =
  | { kind: "error"; status: number; message: string }
  | { kind: "result"; result: ProviderResult; proxyPoolName?: string };

export interface QualifiedDispatchInput {
  model: string;
  body: Record<string, unknown>;
  headers: { authorization?: string; "x-api-key"?: string };
  request: Request;
  surface: ProviderRequest["surface"];
  /** Present = emulated-compaction mode: forces stream:false and injects `instruction` as the first system message before transforms run. */
  compact?: { instruction: string };
}

function injectCompactMessage(body: Record<string, unknown>, instruction: string): void {
  body.stream = false;
  const messages = body.messages;
  if (Array.isArray(messages)) {
    body.messages = [{ role: "system", content: instruction }, ...messages];
  }
}

/**
 * Resolves the credential for a provider dispatch. When the provider's routing
 * strategy is "round-robin" and active DB accounts exist, those are used
 * instead of client-supplied credentials (REQ-20.5). Otherwise falls back to
 * the existing inbound-headers path. Shared by live dispatch AND the console's
 * "test model" action so both rotate accounts identically (REQ-4.3).
 */
export async function resolveCredentialForDispatch(
  provider: string,
  headers: { authorization?: string; "x-api-key"?: string },
  modelId?: string,
) {
  const routing = getProviderRouting(provider);

  // Pick a stored account. When the strategy is "round-robin" the picker
  // rotates across accounts; for any other strategy ("priority" by default)
  // it selects the highest-priority active account, so stored credentials
  // are always consulted before falling back to header-only resolution.
  const picked = await pickAccountForRotation(provider, routing.strategy === "round-robin" ? routing.stickyLimit : 0, modelId);
  if (picked) {
    const plain = await decryptCredential(picked.credential_enc);
    const kind = RESOLVED_KIND_BY_ACCOUNT_KIND[picked.credential_kind as CredentialKind] ?? "provider-bearer";
    return { kind, value: plain, accountId: picked.id };
  }

  // No stored accounts for this provider — fall back to the credential
  // the client supplied in the request header (BYOK / legacy pass-through).
  if (!isProviderId(provider)) return undefined;
  const defaultTarget = {
    provider,
    modelId: "",
    surface: "openai-chat" as const,
    credential: credentialKindOf(provider),
    weight: 1,
  };
  return resolveCredential(defaultTarget, headers);
}

function isUpstream429(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.status === "number" && obj.status === 429) return true;
  }
  return false;
}

/** Check if an error warrants combo failover (retryable status or fetch error). */
function isRetryableForCombo(err: unknown): boolean {
  return isRetryableError(err);
}

/** Resolves and calls a provider-qualified model after its request is normalized to OpenAI Chat. */
export async function dispatchQualifiedRoute(input: QualifiedDispatchInput): Promise<QualifiedDispatchResult> {
  // ── Model chain resolution: prefix → alias → combo → filter ──
  const targetResult = await resolveQualifiedTarget(input.model);
  if ("error" in targetResult) return { kind: "error", status: targetResult.status ?? 400, message: targetResult.error };

  const target = targetResult.target;
  const provider = providerRegistry.get(target.provider);
  if (!provider) return { kind: "error", status: 404, message: "Provider not found." };

  if (input.compact) injectCompactMessage(input.body, input.compact.instruction);
  const transformedBody = prepareOutboundRequest(input.body, "openai", getRequestTransformSettings()) as Record<string, unknown>;
  const providerRequest: ProviderRequest = { surface: input.surface, body: transformedBody };

  // ── Credential resolution: DB account rotation (round-robin) or client-supplied ──
  const credential = await resolveCredentialForDispatch(target.provider, input.headers, target.modelId);
  if (!credential) return { kind: "error", status: 401, message: "This provider requires a valid bearer credential." };

  try {
    const outcome = await dispatchProvider(providerRegistry, { target, request: providerRequest, credential }, input.request.signal);
    if ("accountId" in credential && credential.accountId) clearAccountCooldown(credential.accountId as string);
    return { kind: "result", result: outcome.result, proxyPoolName: outcome.proxyPoolName };
  } catch (err) {
    // On 429: mark account unavailable and try combo failover (C5+C6)
    if ("accountId" in credential && credential.accountId && isUpstream429(err)) {
      markAccountUnavailable(credential.accountId as string);
    }
    // Combo failover: try next candidate on retryable error (C6)
    if (isRetryableForCombo(err)) {
      const fallback = await tryComboFailover(input, providerRequest);
      if (fallback) return fallback;
    }
    // Propagate 429 with Retry-After
    if (isUpstream429(err)) {
      const retryAfter = getRetryAfterSeconds(target.provider);
      return { kind: "error", status: 429, message: retryAfter ? `Rate limited. Retry after ${retryAfter}s.` : "Rate limited by upstream provider." };
    }
    throw err;
  }
}

/**
 * Combo failover: resolve all eligible targets and try the next ones
 * after the primary target failed with a retryable error (C6).
 */
async function tryComboFailover(
  input: QualifiedDispatchInput,
  providerRequest: ProviderRequest,
): Promise<QualifiedDispatchResult | null> {
  const targets = await resolveAllComboTargets(input.model);
  // Skip the first target (already failed) and try the rest
  for (let i = 1; i < targets.length; i++) {
    const targetResult = targets[i];
    if (!targetResult || "error" in targetResult) continue;

    const target: RouteTarget = (targetResult as { target: RouteTarget }).target;
    const provider = providerRegistry.get(target.provider);
    if (!provider) continue;

    const credential = await resolveCredentialForDispatch(target.provider, input.headers, target.modelId);
    if (!credential) continue;

    try {
      const outcome = await dispatchProvider(providerRegistry, { target, request: providerRequest, credential }, input.request.signal);
      if ("accountId" in credential && credential.accountId) clearAccountCooldown(credential.accountId as string);
      return { kind: "result", result: outcome.result, proxyPoolName: outcome.proxyPoolName };
    } catch {
      // This candidate also failed, try next
      continue;
    }
  }
  return null; // All combo candidates exhausted
}
