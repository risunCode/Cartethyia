import type { ModelDefinition } from "../model-definition";
import { defineModel } from "../model-definition";

const MISTRAL_PROVIDER_ID = "mistral" as const;

/**
 * Mistral's own current generalist tiers.
 *
 * The provider is registered as a generic OpenAI-compatible API-key provider, so
 * it carried no catalog at all and every model it serves was absent until a
 * discovery run happened to fetch them. These are the two `latest` aliases
 * Mistral keeps pointed at its current generalist models — `mistral-large-latest`
 * (Large 4) and `mistral-medium-latest` (Medium 3.5), per the Mistral model
 * overview.
 *
 * Limits and pricing come from the base catalog via `providerId`: `defineModel`
 * resolves `mistral:<id>` and falls back to the majority row, so no number is
 * restated here to drift away from it. Capability *is* declared per row,
 * because the base catalog is keyed by bare id and a bare id maps to many
 * providers' servings.
 *
 * Deliberately not included:
 *
 * - The dated rows (`mistral-large-2411`, `mistral-medium-2508`). Each is on
 *   Mistral's retired list with a named successor.
 * - `mistral-small-latest`. Still live, but the operator asked for the two
 *   frontier tiers, and listing a model is a routing claim rather than a
 *   completeness claim.
 * - Both Magistral rows. Mistral deprecated Magistral Medium and Small in
 *   favour of Mistral Medium 3.5 and Mistral Small 4, so listing them
 *   advertises models the provider is actively retiring.
 * - The open-weights rows (`open-mistral-7b`, `open-mixtral-8x7b`), the
 *   embedding row (`mistral-embed`, not a chat model), and the devstral and
 *   codestral families — Mistral publishes those as separate product lines.
 */
export const MISTRAL_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "mistral-large-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    toolCall: true,
  }),
  defineModel({
    id: "mistral-medium-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];
