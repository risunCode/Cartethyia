import type { RouteTarget } from "../routing/types";
import type { Provider, ProviderRequest, ProviderResult } from "./providers/index";
import type { ResolvedCredential } from "./providers/index";
import { getProviderRouting } from "../console/db/repos/routing";
import { withRetry, createTimeoutSignal, DEFAULT_RETRY_CONFIG, extractStatus, type RetryConfig } from "./retry";
import { isRetryableError } from "./retry";
import { parseQualifiedModel, resolveAllComboTargets, resolveQualifiedTarget, credentialKindOf, type RouteResolveResult } from "../routing/resolve";
import { isProviderId } from "../routing/providerMeta";
import { ProviderCallError, providerRegistry } from "./providers";
import {
  pickAccountForRotation,
  markAccountUnavailable,
  clearAccountCooldown,
  getRetryAfterSeconds,
  lockAccountModel,
  RESOLVED_KIND_BY_ACCOUNT_KIND,
  type CredentialKind,
} from "../console/db/repos/accounts";
import { pushConsoleLog } from "../console/logs/ring";

export interface DispatchableRoute {
  target: RouteTarget;
  request: ProviderRequest;
  credential: ResolvedCredential;
}

// ── Credential resolution ─────────────────────────────────────────

interface InboundHeaders {
  authorization?: string;
  "x-api-key"?: string;
}

function extractBearer(headers: InboundHeaders): string | undefined {
  if (headers.authorization?.startsWith("Bearer ")) return headers.authorization.slice(7);
  return undefined;
}

/** Credential kinds that require a bearer token from the inbound request. */
const BEARER_CREDENTIAL_KINDS: ReadonlySet<string> = new Set(["provider-bearer", "devin-session", "qoder-pat"]);

/** Resolves the client-supplied credential a target's routing calls for (BYOK bearer/api-key, or none for auth-free providers). */
function resolveCredential(target: RouteTarget, headers: InboundHeaders): ResolvedCredential | undefined {
  if (target.credential === "none") return { kind: "none", value: "" };

  if (BEARER_CREDENTIAL_KINDS.has(target.credential)) {
    const value = extractBearer(headers);
    if (!value) return undefined;
    return { kind: target.credential as ResolvedCredential["kind"], value };
  }

  return undefined;
}

export interface ProviderRegistry {
  get(provider: RouteTarget["provider"]): Provider | undefined;
}

/** Connect timeout for provider fetch calls (C3). */
const FETCH_CONNECT_TIMEOUT_MS = 60_000;

/**
 * Retry config for dispatch (C2). Can be overridden per-provider if needed.
 *
 * A streaming client (chat.ts/messages.ts/responses.ts all `await
 * dispatchQualifiedRoute(...)` in full - retries and all - before sending
 * ANY bytes back, not even response headers) sees complete silence for the
 * whole retry window. The old 2000ms base meant two retryable failures
 * (408/502/503/504) burned ~2-5s of dead air each - ~7s total before a
 * third attempt even started. That's long enough for a real client (e.g.
 * GitHub Copilot Chat) to conclude the connection is dead and cancel it
 * outright, which then wastes the retry entirely: the request still fails,
 * just slower. Keeping the retries but shrinking the backoff (~150-500ms
 * for two attempts) preserves resilience against a genuine transient blip
 * while staying well under any reasonable client patience threshold.
 */
const DISPATCH_RETRY_CONFIG: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxRetries: 2,
  baseDelayMs: 150,
  maxDelayMs: 1500,
};

export interface DispatchOutcome {
  result: ProviderResult;
}

interface AccountModelFailure {
  count: number;
  lastFailureAt: number;
}

const accountModelFailures = new Map<string, AccountModelFailure>();
const ACCOUNT_MODEL_FAILURE_THRESHOLD = 3;
const ACCOUNT_MODEL_FAILURE_TTL_MS = 5 * 60_000;
const MAX_ACCOUNT_MODEL_FAILURES = 10_000;

function accountModelFailureKey(accountId: string, modelId: string): string {
  return `${accountId}:${modelId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasImageContent(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return false;
    return message.content.some((part) => isRecord(part) && (part.type === "image_url" || part.type === "image"));
  });
}

const IMAGE_FALLBACK_TEXT = "[Image attachment omitted: the selected model cannot process image input. Respond using the available text only.]";

function omitImagesFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  return {
    ...body,
    messages: messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      const hasImage = message.content.some((part) => isRecord(part) && (part.type === "image_url" || part.type === "image"));
      if (!hasImage) return message;
      return {
        ...message,
        content: message.content.map((part) =>
          isRecord(part) && (part.type === "image_url" || part.type === "image")
            ? { type: "text", text: IMAGE_FALLBACK_TEXT }
            : part,
        ),
      };
    }),
  };
}

async function dispatchWithImageFallback(
  registry: ProviderRegistry,
  route: DispatchableRoute,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  try {
    return await dispatchProvider(registry, route, signal);
  } catch (error) {
    if (!(error instanceof ProviderCallError) || error.status !== 400 || !hasImageContent(route.request.body)) throw error;
    return dispatchProvider(registry, { ...route, request: { ...route.request, body: omitImagesFromBody(route.request.body) } }, signal);
  }
}

async function dispatchProvider(
  registry: ProviderRegistry,
  route: DispatchableRoute,
  signal: AbortSignal
): Promise<DispatchOutcome> {
  const provider = registry.get(route.target.provider);
  if (!provider) {
    throw new Error(`No provider implementation for ${route.target.provider}`);
  }

  // Create a combined signal: connect timeout + client abort (C3). `clear`
  // is called once `provider.call(...)` resolves (headers/full JSON in
  // hand) so the deadline never fires against the rest of a streaming
  // response body's lifetime - see `createTimeoutSignal`'s docstring.
  const { signal: timeoutSignal, clear: clearConnectTimeout } = createTimeoutSignal(FETCH_CONNECT_TIMEOUT_MS, signal);

  try {
    const result = await withRetry(
      () => provider.call(route.target, route.request, route.credential, timeoutSignal),
      DISPATCH_RETRY_CONFIG,
      (attempt, delayMs, error) => {
        void attempt;
        void delayMs;
        void error;
      },
    );
    return { result };
  } finally {
    clearConnectTimeout();
  }
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
  | { kind: "result"; result: ProviderResult; accountLabel?: string };

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
function clientAffinityKey(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-real-ip")?.trim() || undefined;
}

export async function resolveCredentialForDispatch(
  provider: string,
  headers: { authorization?: string; "x-api-key"?: string },
  modelId?: string,
  clientKey?: string,
) {
  if (!isProviderId(provider)) return undefined;
  const expectedCredential = credentialKindOf(provider);
  if (expectedCredential === "none") return { kind: "none" as const, value: "" };

  const routing = getProviderRouting(provider);

  // Pick a stored account. When the strategy is "round-robin" the picker
  // rotates across accounts; for any other strategy ("priority" by default)
  // it selects the highest-priority active account, so stored credentials
  // are always consulted before falling back to header-only resolution.
  const picked = await pickAccountForRotation(provider, routing.strategy, routing.stickyLimit, modelId, clientKey);
  if (picked) {
    const plain = picked.credential;
    const kind = RESOLVED_KIND_BY_ACCOUNT_KIND[picked.credential_kind as CredentialKind] ?? "provider-bearer";
    return { kind, value: plain, accountId: picked.id, accountName: picked.name };
  }

  // No stored accounts for this provider, fall back to the credential the
  // client supplied directly in the request header (BYOK).
  const defaultTarget = {
    provider,
    modelId: "",
    surface: "openai-chat" as const,
    credential: credentialKindOf(provider),
    weight: 1,
  };
  return resolveCredential(defaultTarget, headers);
}

/** Resolves and calls a provider-qualified model after its request is normalized to OpenAI Chat. */
export async function dispatchQualifiedRoute(input: QualifiedDispatchInput): Promise<QualifiedDispatchResult> {
  // ── Model chain resolution: prefix → alias → combo → filter ──
  // Keep the complete eligible target list so combo failover can reuse it
  // after the primary call fails instead of resolving aliases, filters,
  // catalogs, and round-robin state a second time.
  const parsedModel = parseQualifiedModel(input.model);
  const targetResults = parsedModel.kind === "qualified"
    ? [await resolveQualifiedTarget(input.model)]
    : await resolveAllComboTargets(input.model);
  const targetResult = targetResults[0];
  if (!targetResult || "error" in targetResult) {
    return { kind: "error", status: targetResult?.status ?? 400, message: targetResult?.error ?? "No eligible model found." };
  }

  const target = targetResult.target;
  const provider = providerRegistry.get(target.provider);
  if (!provider) return { kind: "error", status: 404, message: "Provider not found." };

  if (input.compact) injectCompactMessage(input.body, input.compact.instruction);
  const providerRequest: ProviderRequest = { surface: input.surface, body: input.body };

  // ── Credential resolution: account routing uses client IP affinity when sticky routing is enabled. ──
  const affinityKey = clientAffinityKey(input.request);
  const credential = await resolveCredentialForDispatch(target.provider, input.headers, target.modelId, affinityKey);
  if (!credential) return { kind: "error", status: 401, message: "This provider requires a valid bearer credential." };

  try {
    const outcome = await dispatchWithImageFallback(providerRegistry, { target, request: providerRequest, credential }, input.request.signal);
    if ("accountId" in credential && credential.accountId) {
      const accountId = credential.accountId as string;
      clearAccountCooldown(accountId);
      accountModelFailures.delete(accountModelFailureKey(accountId, target.modelId));
    }
    return { kind: "result", result: outcome.result, accountLabel: "accountName" in credential ? credential.accountName : undefined };
  } catch (err) {
    const status = extractStatus(err);
    const isCredentialFailure = status === 401 || status === 403;
    if ("accountId" in credential && credential.accountId) {
      const accountId = credential.accountId as string;
      if (status === 429 || isCredentialFailure) markAccountUnavailable(accountId, isCredentialFailure ? "auth" : "rate-limit");
      const key = accountModelFailureKey(accountId, target.modelId);
      const now = Date.now();
      const existing = accountModelFailures.get(key);
      const failures = existing && now - existing.lastFailureAt <= ACCOUNT_MODEL_FAILURE_TTL_MS
        ? existing.count + 1
        : 1;
      accountModelFailures.delete(key);
      if (failures >= ACCOUNT_MODEL_FAILURE_THRESHOLD) {
        lockAccountModel(accountId, target.modelId);
      } else {
        accountModelFailures.set(key, { count: failures, lastFailureAt: now });
        while (accountModelFailures.size > MAX_ACCOUNT_MODEL_FAILURES) {
          const oldest = accountModelFailures.keys().next();
          if (oldest.done) break;
          accountModelFailures.delete(oldest.value);
        }
      }
    }
    // A rejected stored credential is account-specific: immediately retry the
    // next eligible account for this provider before trying combo targets.
    if (isCredentialFailure && "accountId" in credential && credential.accountId) {
      const nextCredential = await resolveCredentialForDispatch(target.provider, input.headers, target.modelId, affinityKey);
      if (nextCredential && "accountId" in nextCredential && nextCredential.accountId !== credential.accountId) {
        const oldLabel = "accountName" in credential ? credential.accountName : undefined;
        if (oldLabel) pushConsoleLog("warn", "request", `\u26a0\ufe0f FALLBACK \u21c4 ACC:${oldLabel} UNAVAILABLE (${status ?? "?"}) \u2192 NEXT ACCOUNT`);
        try {
          const outcome = await dispatchWithImageFallback(providerRegistry, { target, request: providerRequest, credential: nextCredential }, input.request.signal);
          clearAccountCooldown(nextCredential.accountId);
          return { kind: "result", result: outcome.result, accountLabel: "accountName" in nextCredential ? nextCredential.accountName : undefined };
        } catch {
          // Continue to combo failover after the next stored account also fails.
        }
      }
    }
    // Combo failover: try next candidate on retryable or stored-credential auth error.
    if (isRetryableError(err) || isCredentialFailure) {
      const fallback = await tryComboFailover(input, providerRequest, targetResults, affinityKey);
      if (fallback) return fallback;
    }
    // Propagate 429 with Retry-After
    if (extractStatus(err) === 429) {
      const retryAfter = getRetryAfterSeconds(target.provider);
      return { kind: "error", status: 429, message: retryAfter ? `Rate limited. Retry after ${retryAfter}s.` : "Rate limited by upstream provider." };
    }
    const message = err instanceof Error ? err.message : "Upstream provider request failed.";
    return { kind: "error", status: status ?? 502, message };
  }
}

/**
 * Combo failover: try already-resolved eligible targets after the
 * primary target failed with a retryable error (C6).
 */
async function tryComboFailover(
  input: QualifiedDispatchInput,
  providerRequest: ProviderRequest,
  targets: RouteResolveResult[],
  affinityKey: string | undefined,
): Promise<QualifiedDispatchResult | null> {
  // Skip the first target (already failed) and try the rest
  for (let i = 1; i < targets.length; i++) {
    const targetResult = targets[i];
    if (!targetResult || "error" in targetResult) continue;

    const target: RouteTarget = (targetResult as { target: RouteTarget }).target;
    const provider = providerRegistry.get(target.provider);
    if (!provider) continue;

    const credential = await resolveCredentialForDispatch(target.provider, input.headers, target.modelId, affinityKey);
    if (!credential) continue;

    try {
      const outcome = await dispatchWithImageFallback(providerRegistry, { target, request: providerRequest, credential }, input.request.signal);
      if ("accountId" in credential && credential.accountId) clearAccountCooldown(credential.accountId as string);
      return { kind: "result", result: outcome.result, accountLabel: "accountName" in credential ? credential.accountName : undefined };
    } catch {
      // This candidate also failed, try next
      continue;
    }
  }
  return null; // All combo candidates exhausted
}
