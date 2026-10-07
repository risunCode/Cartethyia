/**
 * Cursor model catalog.
 *
 * The account's live list is far larger than what we expose. Cursor's own
 * picker shows four families and we mirror that: Auto (Cursor's `default`
 * routing), every Grok, every Claude Opus, and every Composer. The GPT line
 * and everything else upstream returns is dropped — those ids are deprecated
 * on Cursor's side and keeping them would advertise models the picker itself
 * no longer offers.
 *
 * The exposed id and the upstream id differ in exactly one case. Cursor's
 * auto routing answers to `default`, which reads as a placeholder in a model
 * list, so the catalog exposes it as `auto` and the adapter translates back
 * to `default` on the wire. Every other id is sent upstream unchanged.
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

/** What the catalog exposes for Cursor's automatic routing. */
export const CURSOR_AUTO_MODEL_ID = "auto" as const;
/** What Cursor's backend expects for that same routing. */
export const CURSOR_AUTO_UPSTREAM_ID = "default" as const;

/** Seed ids, used before the first discovery and when it fails. */
const SEED_MODEL_IDS = [CURSOR_AUTO_MODEL_ID, "composer-2.5", "claude-opus-5", "cursor-grok-4.6"] as const;

export const CURSOR_MODELS: readonly ModelDefinition[] = SEED_MODEL_IDS.map((id) => cursorModel(id));

/**
 * True for the families the catalog keeps.
 *
 * Opus is matched on the `claude-opus` prefix rather than any claude id, so
 * Sonnet and Fable rows upstream returns are excluded. Grok covers both the
 * `grok-` and `cursor-grok-` lines.
 */
export function isExposedCursorModel(upstreamId: string): boolean {
  if (upstreamId === CURSOR_AUTO_UPSTREAM_ID) return true;
  if (upstreamId.startsWith("grok-") || upstreamId.startsWith("cursor-grok-")) return true;
  if (upstreamId.startsWith("claude-opus")) return true;
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

/** One model row. Limits are left unset: Cursor does not publish them. */
export function cursorModel(modelId: string): ModelDefinition {
  return defineModel({ id: modelId, providerId: CURSOR_PROVIDER_ID, endpoint: CURSOR_RUN_PATH });
}
