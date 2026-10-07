/**
 * Cursor model catalog.
 *
 * The account's live list is far larger than what we expose: Auto (Cursor's
 * `default` routing) and Composer. Two families the picker does show were
 * dropped because this account's plan cannot reach them — `claude-opus-5`
 * answers `not_found` and `composer-2.5` answers `resource_exhausted` on every
 * probe, so advertising them offered a model that could never serve.
 *
 * The exposed id and the upstream id differ in exactly one case today.
 * Cursor's auto routing answers to `default`, which reads as a placeholder in a
 * model list, so the catalog exposes it as `auto` and the adapter translates
 * back to `default` on the wire. Every other id is sent upstream unchanged.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";

export const CURSOR_PROVIDER_ID = "cursor" as const;

/**
 * The adapter's own RPC path. Cursor has no chat-shaped route: one turn is a
 * bidirectional `Run` stream, so the path is recorded for catalog completeness
 * rather than selected by wire family.
 */
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run" as const;

/**
 * Cursor does not publish per-model limits, and the shared base catalog
 * guesses wildly for these ids — `auto` resolves to 2M by majority vote over
 * unrelated rows that happen to share the name. Every Cursor row carries this
 * fixed window instead, which is what the account actually serves.
 */
export const CURSOR_CONTEXT_LIMIT = 200_000;
/** Cursor serves 64k of output on these rows. Leaving it unset let the helper's 16k default through. */
export const CURSOR_OUTPUT_LIMIT = 64_000;

/** What the catalog exposes for Cursor's automatic routing. */
export const CURSOR_AUTO_MODEL_ID = "auto" as const;
/** What Cursor's backend expects for that same routing. */
export const CURSOR_AUTO_UPSTREAM_ID = "default" as const;
/** The Composer id, kept as the seed's second row and its own family prefix. */
export const CURSOR_COMPOSER_MODEL_ID = "composer-2.5" as const;
/** The Composer family prefix every Composer row upstream returns carries. */
export const CURSOR_COMPOSER_PREFIX = "composer-" as const;

/**
 * Seed ids, used before the first discovery and when it fails.
 *
 * `default` (exposed as `auto`) and `composer-2.5` only: `claude-opus-5` and
 * `grok-4.6` are gone because this account's plan refuses both — the Opus row
 * with `not_found` and the Grok row with `resource_exhausted` — and a seed
 * exists precisely so a model is routable before discovery confirms it.
 */
const SEED_MODEL_IDS = [CURSOR_AUTO_MODEL_ID, CURSOR_COMPOSER_MODEL_ID] as const;

export const CURSOR_MODELS: readonly ModelDefinition[] = SEED_MODEL_IDS.map((id) => cursorModel(id));

/**
 * True for the families the catalog keeps: Cursor's own auto routing and the
 * Composer line. Everything else upstream returns — Grok, Claude Opus, the
 * deprecated GPT rows, Sonnet, Fable, Gemini — is dropped.
 *
 * Grok and Opus are excluded on evidence, not taste: this account's plan
 * answers `resource_exhausted` for the Grok rows and `not_found` for the Opus
 * rows, so a catalog that advertised them offered a model no request could
 * ever reach.
 */
export function isExposedCursorModel(upstreamId: string): boolean {
  if (upstreamId === CURSOR_AUTO_UPSTREAM_ID) return true;
  if (upstreamId.startsWith("composer-")) return true;
  return false;
}

/** The id the catalog exposes for an upstream id. */
export function exposedModelId(upstreamId: string): string {
  return upstreamId === CURSOR_AUTO_UPSTREAM_ID ? CURSOR_AUTO_MODEL_ID : upstreamId;
}

/** The id the wire expects for a catalog id. */
export function upstreamModelId(modelId: string): string {
  return modelId === CURSOR_AUTO_MODEL_ID ? CURSOR_AUTO_UPSTREAM_ID : modelId;
}

/** One model row, with the fixed window rather than the base catalog's guess. */
export function cursorModel(modelId: string): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: CURSOR_PROVIDER_ID,
    endpoint: CURSOR_RUN_PATH,
    ctx: CURSOR_CONTEXT_LIMIT,
    out: CURSOR_OUTPUT_LIMIT,
  });
}
