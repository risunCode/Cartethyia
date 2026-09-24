/**
 * Antigravity wire-level helpers:
 *
 * - `getAntigravityVersion()` / `ensureAntigravityVersion()`: version-manifest
 *   discovery for the `antigravity/hub` `User-Agent` header. The backend
 *   gates newer models on the client version, so we fetch the latest
 *   release from the update manifest lazily (best-effort; a pinned
 *   fallback keeps the flow working offline).
 * - `getAntigravityUserAgent()`: full `antigravity/hub/<version>` string.
 * - `ANTIGRAVITY_MODEL_WIRE_PROFILES` / `getAntigravityModelWireProfile()`:
 *   per-wire-id `maxOutputTokens` (and optional `labels.model_enum`)
 *   the backend enforces. Claude SKUs cap at 64000 regardless of the
 *   thinking budget; Gemini SKUs accept the discovered cap.
 * - `applySkipThoughtSignatureBypass()`: on Gemini 3+ turns, the first
 *   unsigned `functionCall` in a `model`-role content block gets the
 *   `skip_thought_signature_validator` sentinel; unsigned secondary
 *   calls in the same turn stay bare (mirrors provider behavior).
 * - `loadAntigravityProject()`: best-effort `loadCodeAssist` lookup for
 *   the caller's Cloud Code project id, cached by access-token hash.
 */
import { createHash } from "node:crypto";
import { providerBaseUrl } from "../../provider-metadata";
import type { ModelDefinition } from "../../provider-registry";
import { isRecord } from "../../../protocol/primitives";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { FetchLike } from "../../authentication/oauth-client";

// User-Agent + version discovery

/** Pinned Antigravity client version used when live discovery has not run yet. */
const DEFAULT_ANTIGRAVITY_VERSION = "2.15.1";

/** Desktop-client fingerprint fields stamped into the Antigravity User-Agent. */
const ANTIGRAVITY_OS_TYPE = "darwin";
const ANTIGRAVITY_ARCH = "arm64";
const ANTIGRAVITY_CL = "963137146";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;

/**
 * Manifest-discovered → pinned fallback. Discovery is the only source of a
 * live version; the pinned constant keeps dispatch working offline.
 */
function getAntigravityVersion(): string {
  return discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/**
 * Extracts the client version from an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
function parseAntigravityManifestVersion(
  yamlText: string,
): string | null {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(
      line,
    );
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/**
 * Resolves the latest Antigravity release from the official update manifest.
 * Success is cached for the process lifetime; failures are silent (the pinned
 * fallback stays valid) and clear the in-flight cache so a later call retries.
 */
export function ensureAntigravityVersion(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  if (discoveredAntigravityVersion) {
    return Promise.resolve();
  }
  if (antigravityVersionFetch) return antigravityVersionFetch;

  antigravityVersionFetch = (async () => {
    try {
      const timeoutSignal = AbortSignal.timeout(
        ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS,
      );
      const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "electron-builder",
        },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.ok) {
        discoveredAntigravityVersion = parseAntigravityManifestVersion(
          await response.text(),
        );
      }
    } catch {
      // Silent: the pinned fallback remains valid when discovery fails.
    } finally {
      if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
    }
  })();
  return antigravityVersionFetch;
}

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
  "gemini-3.5-flash-extra-low": {
    modelEnum: "MODEL_PLACEHOLDER_M187",
    maxOutputTokens: 65536,
  },
  "gemini-3.5-flash-low": {
    modelEnum: "MODEL_PLACEHOLDER_M20",
    maxOutputTokens: 65536,
  },
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
  if (modelId === "gemini-3.5-flash") return "gemini-3.5-flash-extra-low";
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
function collapseAntigravityVariant(modelId: string): string {
  if (modelId === "claude-opus-4-6-thinking") return "claude-opus-4-6";
  if (modelId === "gemini-pro-agent") return "gemini-3.1-pro";
  if (modelId === "gemini-3-flash-agent") return "gemini-3.5-flash";
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
      webSearch: false,
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
      const response = await fetcher(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": getAntigravityUserAgent(),
        },
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as unknown;
      const projectId = extractProjectId(payload);
      if (projectId) {
        projectIdCache.set(key, projectId);
        boundProjectIdCache();
      }
      return projectId;
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
