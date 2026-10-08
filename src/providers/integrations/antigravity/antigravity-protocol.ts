/**
 * Antigravity wire-level helpers:
 * - `getAntigravityVersion()`: monitor-owned version snapshot used by the
 *   `antigravity/hub` `User-Agent` header.
 * - `getAntigravityUserAgent()`: full `antigravity/hub/<version>` string.
 * - `ANTIGRAVITY_MODEL_WIRE_PROFILES` / `getAntigravityModelWireProfile()`:
 *   per-wire-id `maxOutputTokens` (and optional `labels.model_enum`) the
 *   backend enforces.
 * - `applySkipThoughtSignatureBypass()`: on Gemini 3+ turns, the first
 *   unsigned `functionCall` in a `model`-role content block gets the
 *   `skip_thought_signature_validator` sentinel.
 * - `loadAntigravityProject()`: best-effort `loadCodeAssist` lookup for
 *   the caller's Cloud Code project id, cached by access-token hash.
 *
 * The global client-version monitor refreshes the version. Request paths only
 * read the current snapshot and never fetch the update manifest.
 */
import { createHash } from "node:crypto";
import { providerBaseUrl } from "../../provider-metadata";
import type { ModelDefinition } from "../../provider-registry";
import { isRecord } from "../../../protocol/primitives";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { FetchLike } from "../../authentication/oauth-client";
import { getAntigravityVersion } from "../../operations/client-versions";
export { getAntigravityVersion };


/** Desktop-client fingerprint fields stamped into the Antigravity User-Agent. */
const ANTIGRAVITY_OS_TYPE = "darwin";
const ANTIGRAVITY_ARCH = "arm64";
const ANTIGRAVITY_CL = "963137146";

/**
 * Antigravity `User-Agent` header value; rebuilt when the discovered version
 * changes. Format captured from the real `antigravity/hub` desktop client:
 * `antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`.
 *
 * The backend does not validate `cl` (verified live: stale, zero, and absent
 * `cl` all pass model gating on `daily-cloudcode-pa`; only the version
 * gates). The `cl`/`os_type`/`arch` fields are desktop-client fingerprints,
 * not operator policy, so they are pinned rather than configurable.
 */
export function getAntigravityUserAgent(): string {
  return `antigravity/hub/${getAntigravityVersion()} (aidev_client; os_type=${ANTIGRAVITY_OS_TYPE}; arch=${ANTIGRAVITY_ARCH}; cl=${ANTIGRAVITY_CL})`;
}

// Per-wire-id request constants

interface AntigravityModelWireProfile {
  readonly modelEnum?: string;
  readonly maxOutputTokens: number;
}

/**
 * `maxOutputTokens` the backend enforces per wire id (captured from the real
 * `antigravity/hub` client). Claude on `daily-cloudcode-pa` rejects
 * `maxOutputTokens > 64000` with a `400 Request contains an invalid argument`
 * regardless of the thinking budget; Gemini SKUs accept their discovered
 * output ceiling. Keyed by the routed upstream wire id (post effort-routing),
 * not the collapsed logical id. Missing entry = pass the request's own
 * `maxOutputTokens` through unmodified.
 */
const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<
  Record<string, AntigravityModelWireProfile>
> = Object.freeze({
  // Anthropic on Antigravity caps at 64000 output tokens.
  "claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
  "claude-sonnet-4-6": { maxOutputTokens: 64000 },
  // Gemini effort-routed wire ids (real deployment names).
  "gemini-3-flash-agent": {
    modelEnum: "MODEL_PLACEHOLDER_M132",
    maxOutputTokens: 65536,
  },
  "gemini-3.1-pro-low": {
    modelEnum: "MODEL_PLACEHOLDER_M36",
    maxOutputTokens: 65535,
  },
  "gemini-pro-agent": {
    modelEnum: "MODEL_PLACEHOLDER_M16",
    maxOutputTokens: 65535,
  },
});

export function getAntigravityModelWireProfile(
  wireModelId: string,
): AntigravityModelWireProfile | undefined {
  return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}

/**
 * Collapses logical/display model ids to the upstream deployment ("wire")
 * ids actually accepted by `daily-cloudcode-pa`. The console keeps the
 * friendly logical id on screen; every upstream request resolves through
 * this mapping so deployment names stay out of the catalog UI. Ids without
 * a mapping are already valid wire ids and pass through unchanged.
 */
export function antigravityWireModelId(modelId: string): string {
  if (modelId === "claude-opus-4-6") return "claude-opus-4-6-thinking";
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3.1-pro-high") {
    return "gemini-pro-agent";
  }
  if (modelId === "gemini-3.6-flash") return "gemini-3.6-flash-low";
  if (modelId === "gemini-3.7-flash") return "gemini-3.7-flash-low";
  if (modelId === "gemini-3.8-flash") return "gemini-3.8-flash-low";
  if (modelId === "gpt-oss-120b") return "gpt-oss-120b-medium";
  return modelId;
}

// Model discovery (`v1internal:fetchAvailableModels`) — live catalog.

const ANTIGRAVITY_DISCOVERY_PATH = "/v1internal:fetchAvailableModels";
const ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ANTIGRAVITY_GENERATE_PATH = "/v1internal:generateContent";

/** Internal/dead wire ids excluded from the discovered catalog. */
const ANTIGRAVITY_DISCOVERY_DENYLIST: Readonly<Record<string, true>> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

/**
 * Collapses effort-routed wire ids back to their logical catalog id so the
 * console shows one friendly name per effort family. `antigravityWireModelId`
 * is the inverse: it resolves the logical id to a live wire deployment at
 * dispatch time. Unmapped ids are already logical ids and pass through.
 */
export function collapseAntigravityVariant(modelId: string): string {
  if (modelId === "claude-opus-4-6-thinking") return "claude-opus-4-6";
  if (modelId === "gemini-pro-agent") return "gemini-3.1-pro";
  return modelId.replace(/(?:-(?:extra-low|low|medium|high|tiered|agent))$/, "");
}

interface AntigravityDiscoveryModel {
  readonly displayName?: unknown;
  readonly maxTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsThinking?: unknown;
  readonly supportsImages?: unknown;
  readonly isInternal?: unknown;
}

function positiveAntigravityInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeAntigravityDiscoveryModels(
  value: unknown,
): readonly ModelDefinition[] | null {
  if (!isRecord(value) || !isRecord(value["models"])) return null;
  const byId = new Map<string, ModelDefinition>();
  for (const [wireId, raw] of Object.entries(value["models"])) {
    if (
      ANTIGRAVITY_DISCOVERY_DENYLIST[wireId] === true ||
      !isRecord(raw) ||
      raw["isInternal"] === true
    ) {
      continue;
    }
    const model = raw as AntigravityDiscoveryModel;
    const logicalId = collapseAntigravityVariant(wireId);
    const definition: ModelDefinition = {
      modelId: logicalId,
      wireFamily: "chat",
      endpointPath: ANTIGRAVITY_GENERATE_PATH,
      contextLimit: positiveAntigravityInt(
        model.maxTokens,
        ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
      ),
      outputLimit: positiveAntigravityInt(
        model.maxOutputTokens,
        ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS,
      ),
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: model.supportsThinking === true,
      toolCall: true,
      cost: modelsDevCatalog.costFor("antigravity", logicalId),
    };
    const existing = byId.get(logicalId);
    if (
      existing === undefined ||
      (definition.contextLimit ?? 0) > (existing.contextLimit ?? 0)
    ) {
      byId.set(logicalId, definition);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

/**
 * Fetches and normalizes Antigravity's live model catalog. Returns `null`
 * when the catalog is unreachable so routing keeps serving the static
 * `ANTIGRAVITY_MODELS` fallback.
 */
export async function discoverAntigravityModels(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
  } = {},
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const primary = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(
    /\/+$/,
    "",
  );
  for (const endpoint of [primary, ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT]) {
    try {
      const timeoutSignal = AbortSignal.timeout(3_000);
      const signal =
        options.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([options.signal, timeoutSignal]);
      const response = await fetcher(`${endpoint}${ANTIGRAVITY_DISCOVERY_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": getAntigravityUserAgent(),
        },
        body: "{}",
        signal,
      });
      if (!response.ok) continue;
      const models = normalizeAntigravityDiscoveryModels(
        (await response.json()) as unknown,
      );
      if (models === null) continue;
      return models;
    } catch {
      // Best-effort: a failed live catalog must never break static routing.
    }
  }
  return null;
}

// Skip-thought-signature bypass (Gemini 3+ first-unsigned-functionCall rule)

/**
 * Sentinel Google APIs accept in place of a real base64 thought signature.
 * Antigravity CloudCode requires it only on the *first* unsigned functionCall
 * inside a `model`-role turn; unsigned secondary calls in the same turn stay
 * bare. Signed-first parallel turns leave every secondary call untouched.
 */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** True for Gemini 3.x and above (the SKUs the bypass rule applies to). */
function isGemini3Plus(modelId: string): boolean {
  return /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/.test(modelId);
}

/**
 * Post-processes a Gemini-shaped payload: for each `model`-role content
 * block, add `thoughtSignature = SKIP_THOUGHT_SIGNATURE` to the first
 * unsigned `functionCall`. Leaves signed calls and unsigned secondary calls
 * untouched. No-op for non-Gemini-3+ models.
 */
export function applySkipThoughtSignatureBypass(
  payload: Record<string, unknown>,
  modelId: string,
): void {
  if (!isGemini3Plus(modelId)) return;
  const contents = payload["contents"];
  if (!Array.isArray(contents)) return;
  for (const turn of contents) {
    if (!isRecord(turn)) continue;
    if (turn["role"] !== "model") continue;
    const parts = turn["parts"];
    if (!Array.isArray(parts)) continue;
    let isFirst = true;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (!isRecord(part["functionCall"])) continue;
      if (isFirst && typeof part["thoughtSignature"] !== "string") {
        part["thoughtSignature"] = SKIP_THOUGHT_SIGNATURE;
      }
      isFirst = false;
    }
  }
}

// Project-id lookup (`loadCodeAssist`) — best-effort, cached

/**
 * Cloud Code Assist metadata sent by native Antigravity control-plane
 * requests. The Gemini CLI sends `IDE_UNSPECIFIED`/`PLATFORM_UNSPECIFIED`/
 * `pluginType=GEMINI`; Antigravity identifies itself as `ANTIGRAVITY`.
 * Sending the Gemini shape makes the backend treat the call as a different
 * client and refuse to enroll the account, which the operator sees as
 * "You do not have a valid license of this product".
 */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
  ideType: "ANTIGRAVITY",
});

const projectIdCache = new Map<string, string>();
const PROJECT_ID_CACHE_MAX = 1024;
function boundProjectIdCache(): void {
  while (projectIdCache.size > PROJECT_ID_CACHE_MAX) {
    const oldest = projectIdCache.keys().next().value;
    if (oldest === undefined) break;
    projectIdCache.delete(oldest);
  }
}
const projectIdInflight = new Map<string, Promise<string | undefined>>();

/** Access-token hash → cache key. Never stores the token itself. */
function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
}

/**
 * Resolves the caller's Cloud Code Assist project id via
 * `POST /v1internal:loadCodeAssist`. Success is cached per access-token
 * hash for the process lifetime; failures return `undefined` and are not
 * cached so a later dispatch retries. Safe to call from both the OAuth
 * exchange path (warm the cache) and the dispatch path (lazy fetch).
 */
export async function loadAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const key = tokenKey(accessToken);
  const cached = projectIdCache.get(key);
  if (cached) return cached;
  const inflight = projectIdInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<string | undefined> => {
    const fetcher = options.fetcher ?? fetch;
    const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
    try {
      // Full discovery (loadCodeAssist + free-tier onboarding) rather than a
      // bare lookup: an account that never onboarded has no project, and a
      // project-less dispatch is rejected as "You do not have a valid license
      // of this product". Cached per access-token hash, so this runs once per
      // token; best-effort at dispatch, so a failure just yields undefined.
      return await discoverAntigravityProject(accessToken, {
        baseUrl: base,
        fetcher,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return undefined;
    } finally {
      projectIdInflight.delete(key);
    }
  })();

  projectIdInflight.set(key, promise);
  return promise;
}

function extractProjectId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const raw = payload["cloudaicompanionProject"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isRecord(raw) && typeof raw["id"] === "string" && raw["id"].length > 0) {
    return raw["id"];
  }
  return undefined;
}

const FREE_TIER_ID = "free-tier";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const ONBOARD_OPERATIONS_PATH = "/v1internal";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;

/** Thrown when an account cannot be enrolled in the Antigravity free tier. */
export class AntigravityProvisioningError extends Error {
  override readonly name = "AntigravityProvisioningError";
}

function hasTierField(
  payload: Record<string, unknown>,
  field: "currentTier" | "paidTier",
): boolean {
  return payload[field] !== undefined && payload[field] !== null;
}

function isFreeTierAllowed(payload: Record<string, unknown>): boolean {
  const tiers = payload["allowedTiers"];
  return (
    Array.isArray(tiers) &&
    tiers.some((tier) => isRecord(tier) && tier["id"] === FREE_TIER_ID)
  );
}

function freeTierIneligibility(
  payload: Record<string, unknown>,
): { reason: string; validationUrl?: string } | undefined {
  const tiers = payload["ineligibleTiers"];
  if (!Array.isArray(tiers)) return undefined;
  for (const candidate of tiers) {
    if (!isRecord(candidate) || candidate["tierId"] !== FREE_TIER_ID) continue;
    const reason = candidate["reasonMessage"];
    if (typeof reason !== "string" || reason.length === 0) continue;
    const url = candidate["validationUrl"];
    return {
      reason,
      ...(typeof url === "string" && url.length > 0 ? { validationUrl: url } : {}),
    };
  }
  return undefined;
}

/** Asserts the account may enroll in the free tier, mirroring the native client. */
function assertFreeTierEligible(payload: Record<string, unknown>): void {
  if (isFreeTierAllowed(payload)) return;
  const ineligibility = freeTierIneligibility(payload);
  if (ineligibility === undefined) return;
  throw new AntigravityProvisioningError(
    ineligibility.validationUrl === undefined
      ? ineligibility.reason
      : `${ineligibility.reason}\n${ineligibility.validationUrl}`,
  );
}

/** One authenticated Cloud Code Assist control-plane call. */
async function cloudCodeAssistCall(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  path: string,
  init: { method: "POST" | "GET"; body?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${base}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": getAntigravityUserAgent(),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new AntigravityProvisioningError(
      `${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as unknown;
  return isRecord(payload) ? payload : {};
}

/** Reads the account tier, retrying with the resolved project like the native client. */
async function loadCodeAssist(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let payload = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    "/v1internal:loadCodeAssist",
    { method: "POST", body: { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA } },
    signal,
  );
  const projectId = extractProjectId(payload);
  if (!hasTierField(payload, "paidTier") && projectId !== undefined) {
    payload = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      "/v1internal:loadCodeAssist",
      {
        method: "POST",
        body: {
          cloudaicompanionProject: projectId,
          metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
        },
      },
      signal,
    );
  }
  return payload;
}

/** Enrolls the account in the Antigravity free tier, polling until it settles. */
async function onboardUser(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new AntigravityProvisioningError("onboardUser timed out");
    return left;
  };
  let operation = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    ONBOARD_USER_PATH,
    {
      method: "POST",
      body: { tierId: FREE_TIER_ID, metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
    },
    signal,
  );
  for (;;) {
    if (operation["done"] === true) {
      const error = operation["error"];
      if (isRecord(error) && typeof error["message"] === "string") {
        throw new AntigravityProvisioningError(`onboardUser failed: ${error["message"]}`);
      }
      return;
    }
    const name = operation["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new AntigravityProvisioningError("onboardUser returned an operation without a name");
    }
    const waited = Promise.withResolvers<void>();
    setTimeout(waited.resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()));
    await waited.promise;
    operation = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      `${ONBOARD_OPERATIONS_PATH}/${name}`,
      { method: "GET" },
      signal,
    );
  }
}

/**
 * Resolves the caller's Cloud Code Assist project, enrolling the account in
 * the free tier when it has no tier yet — exactly what the native Antigravity
 * client does after login. Without this step a fresh account has no
 * `cloudaicompanionProject`, and both dispatch and quota calls are rejected
 * with "You do not have a valid license of this product".
 *
 * Throws {@link AntigravityProvisioningError} when the account is ineligible
 * or provisioning fails; the login path surfaces that reason to the operator.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
  const initial = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  assertFreeTierEligible(initial);
  if (!hasTierField(initial, "currentTier")) {
    await onboardUser(fetcher, base, accessToken, options.signal);
  }
  const refreshed = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  const projectId = extractProjectId(refreshed);
  if (projectId === undefined) {
    throw new AntigravityProvisioningError(
      "loadCodeAssist did not return a cloudaicompanionProject",
    );
  }
  projectIdCache.set(tokenKey(accessToken), projectId);
  boundProjectIdCache();
  return projectId;
}
