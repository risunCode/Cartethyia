import type { ModelDefinition } from "../model-definition";
import { defineModel } from "../model-definition";

const MISTRAL_PROVIDER_ID = "mistral" as const;

/**
 * Mistral's own current families.
 *
 * The provider is registered as a generic OpenAI-compatible API-key provider, so
 * it carried no catalog at all and every model it serves was absent until a
 * discovery run happened to fetch them. These are the three families Mistral
 * publishes as current — `latest` aliases in each of its large/medium/small
 * tiers — plus the two Magistral reasoning rows, which are the only reasoning
 * entries filed under this provider.
 *
 * Limits and pricing come from the base catalog via `providerId`: `defineModel`
 * resolves `mistral:<id>` and falls back to the majority row, so no number is
 * restated here to drift away from it. Capability *is* declared per row,
 * because the base catalog is keyed by bare id and a bare id maps to many
 * providers' servings.
 *
 * Deliberately not included: the dated rows (`mistral-large-2512`), the open-
 * weights rows (`open-mistral-7b`, `open-mixtral-8x7b`), the embedding row
 * (`mistral-embed`, not a chat model), and the devstral/codestral families —
 * Mistral publishes those as separate product lines, and listing a model is a
 * routing claim, not a completeness claim.
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
  defineModel({
    id: "mistral-small-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "magistral-medium-latest",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    // The catalog files this one undated — there is no `magistral-small-latest`
    // row — so the id is spelled the way the provider publishes it.
    id: "magistral-small",
    providerId: MISTRAL_PROVIDER_ID,
    wireFamily: "chat",
    reasoning: true,
    toolCall: true,
  }),
];
