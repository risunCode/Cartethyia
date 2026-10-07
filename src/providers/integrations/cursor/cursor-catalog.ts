/**
 * Cursor model catalog.
 *
 * The live list comes from `GetUsableModels` and reflects what the signed-in
 * account can actually reach, so these rows are only the offline seed: enough
 * for the model list to be non-empty before the first discovery, and the
 * fallback when that call fails. Cursor's limits are not published, so the
 * rows carry no invented context or output cap.
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

/** Seed ids. Discovery replaces these with the account's real list. */
const SEED_MODEL_IDS = [
  "auto",
  "composer-2.5",
  "claude-sonnet-5-thinking-high",
  "claude-opus-5-thinking-high",
  "gpt-5.3-codex",
] as const;

export const CURSOR_MODELS: readonly ModelDefinition[] = SEED_MODEL_IDS.map((id) =>
  defineModel({
    id,
    providerId: CURSOR_PROVIDER_ID,
    endpoint: CURSOR_RUN_PATH,
    // Cursor does not publish per-model limits, and a guessed cap would be a
    // claim the gateway cannot back. Leave them unset so the row carries the
    // helper's neutral default rather than a fabricated window.
  }),
);

/** One discovered model, projected into a catalog row. */
export function cursorModel(modelId: string): ModelDefinition {
  return defineModel({ id: modelId, providerId: CURSOR_PROVIDER_ID, endpoint: CURSOR_RUN_PATH });
}
