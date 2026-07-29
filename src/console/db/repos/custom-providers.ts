/**
 * Custom Providers — console-registered OpenAI/Anthropic-compatible
 * endpoints (REQ-8). Each provider's own `slug` IS its qualified-model
 * prefix directly — `<slug>/<model>`, no `custom/` wrapper (see
 * `upstream/providers/dynamic.ts`, `routing/resolve.ts`).
 */

import { getDb } from "../client";
import { ADDED_PROVIDER_IDS, PROVIDER_PREFIXES } from "../../../routing/types";
import type { ModelCapability } from "../../../upstream/providers/models";

export type CustomProviderType = "openai-compatible" | "anthropic-compatible";

/** A discovered/enriched model — see `upstream/providers/model-catalog-index.ts` for how capabilities/context get filled in when the upstream `/models` response doesn't include them. */
export interface CustomProviderModel {
  id: string;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface CustomProviderRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  base_url: string;
  credential: string;
  timeout_seconds: number;
  models_json: string;
  headers_json: string;
  created_at: string;
  updated_at: string;
}

export interface CustomProviderRecord {
  id: string;
  slug: string;
  name: string;
  type: CustomProviderType;
  baseUrl: string;
  credential: string;
  timeoutSeconds: number;
  /** Models discovered via the last successful /models auto-fetch (empty if never fetched). */
  models: CustomProviderModel[];
  /** Extra headers sent with every outbound request to this endpoint — merged in after (so they can override) the provider's built-in auth/content-type headers. */
  customHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export class SlugConflictError extends Error {
  constructor(slug: string) {
    super(`"${slug}" is already used by ${(ADDED_PROVIDER_IDS as readonly string[]).includes(slug) || slug === "custom" ? "a built-in provider" : "another custom provider"}`);
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "provider";
}

/** Rejects a slug that collides with a built-in provider prefix or the reserved "custom" namespace itself. */
function isReservedSlug(slug: string): boolean {
  if (slug === "custom") return true;
  if (Object.hasOwn(PROVIDER_PREFIXES, slug)) return true;
  return (ADDED_PROVIDER_IDS as readonly string[]).includes(slug);
}

function parseModels(json: string): CustomProviderModel[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): CustomProviderModel | undefined => {
        // Back-compat: an older build stored `models_json` as a bare string[].
        if (typeof entry === "string") return { id: entry, capabilities: ["text", "streaming"] };
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== "string") return undefined;
        return {
          id: row.id,
          capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is ModelCapability => typeof c === "string") : ["text", "streaming"],
          contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
          maxOutputTokens: typeof row.maxOutputTokens === "number" ? row.maxOutputTokens : undefined,
        };
      })
      .filter((m): m is CustomProviderModel => m !== undefined);
  } catch {
    return [];
  }
}

function parseHeaders(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && key.trim()) out[key.trim()] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function toRecord(row: CustomProviderRow): CustomProviderRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type as CustomProviderType,
    baseUrl: row.base_url,
    credential: row.credential,
    timeoutSeconds: row.timeout_seconds,
    models: parseModels(row.models_json),
    customHeaders: parseHeaders(row.headers_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCustomProviders(): CustomProviderRecord[] {
  const rows = getDb().query("SELECT * FROM custom_providers ORDER BY name ASC").all() as CustomProviderRow[];
  return rows.map(toRecord);
}

export function getCustomProviderById(id: string): CustomProviderRecord | null {
  const row = getDb().query("SELECT * FROM custom_providers WHERE id = ?").get(id) as CustomProviderRow | null;
  return row ? toRecord(row) : null;
}

export function getCustomProviderBySlug(slug: string): CustomProviderRecord | null {
  const row = getDb().query("SELECT * FROM custom_providers WHERE slug = ?").get(slug) as CustomProviderRow | null;
  return row ? toRecord(row) : null;
}

/**
 * Cheap existence check used by `routing/resolve.ts`'s `parseQualifiedModel`
 * to recognize a custom provider's own slug as a top-level qualified prefix
 * (e.g. `awok/SWE-Pickle`) — there's no `custom/` wrapper (REQ-8: each
 * custom provider addresses directly under its own slug).
 */
export function isCustomProviderSlug(slug: string): boolean {
  return getDb().query("SELECT 1 FROM custom_providers WHERE slug = ? LIMIT 1").get(slug) !== null;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 300;

export function clampTimeoutSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(value as number)));
}

export interface CreateCustomProviderInput {
  name: string;
  type: CustomProviderType;
  baseUrl: string;
  credential: string;
  /** Explicit slug override; defaults to a slugified `name`. */
  slug?: string;
  /** Per-request timeout for this provider's outbound calls (and the auto-fetch below). Defaults to 30s. */
  timeoutSeconds?: number;
  /** Models discovered via a /models auto-fetch performed by the caller before creating. */
  models?: CustomProviderModel[];
  /** Extra headers sent with every outbound request — e.g. an org id, a gateway routing header, a WAF bypass token. */
  customHeaders?: Record<string, string>;
}

export function createCustomProvider(input: CreateCustomProviderInput): CustomProviderRecord {
  const slug = (input.slug ? slugify(input.slug) : slugify(input.name)) || "provider";
  if (!SLUG_PATTERN.test(slug) || isReservedSlug(slug) || getCustomProviderBySlug(slug)) {
    throw new SlugConflictError(slug);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
  const modelsJson = JSON.stringify(input.models ?? []);
  const headersJson = JSON.stringify(input.customHeaders ?? {});
  getDb()
    .query(
      "INSERT INTO custom_providers (id, slug, name, type, base_url, credential, timeout_seconds, models_json, headers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, slug, input.name.trim(), input.type, input.baseUrl.trim().replace(/\/+$/, ""), input.credential, timeoutSeconds, modelsJson, headersJson, now, now);
  return getCustomProviderById(id)!;
}

export function deleteCustomProvider(id: string): boolean {
  const result = getDb().query("DELETE FROM custom_providers WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface UpdateCustomProviderInput {
  name?: string;
  baseUrl?: string;
  /** Omit to keep the existing credential; pass a new value to rotate it. */
  credential?: string;
  timeoutSeconds?: number;
  /** Replaces the discovered-models list wholesale (used after a re-fetch). */
  models?: CustomProviderModel[];
  /** Replaces the custom-headers map wholesale (omit to keep the existing set). */
  customHeaders?: Record<string, string>;
}

export function updateCustomProvider(id: string, patch: UpdateCustomProviderInput): CustomProviderRecord | null {
  const existing = getCustomProviderById(id);
  if (!existing) return null;

  const name = patch.name?.trim() || existing.name;
  const baseUrl = patch.baseUrl?.trim() ? patch.baseUrl.trim().replace(/\/+$/, "") : existing.baseUrl;
  const credential = patch.credential?.trim() ? patch.credential.trim() : existing.credential;
  const timeoutSeconds = patch.timeoutSeconds === undefined ? existing.timeoutSeconds : clampTimeoutSeconds(patch.timeoutSeconds);
  const modelsJson = JSON.stringify(patch.models ?? existing.models);
  const headersJson = JSON.stringify(patch.customHeaders ?? existing.customHeaders);
  const now = new Date().toISOString();

  getDb()
    .query(
      "UPDATE custom_providers SET name = ?, base_url = ?, credential = ?, timeout_seconds = ?, models_json = ?, headers_json = ?, updated_at = ? WHERE id = ?",
    )
    .run(name, baseUrl, credential, timeoutSeconds, modelsJson, headersJson, now, id);
  return getCustomProviderById(id);
}

/** Masked hint (last 4 chars) for display. */
export function credentialHintFor(record: CustomProviderRecord): string {
  return `…${record.credential.slice(-4)}`;
}
