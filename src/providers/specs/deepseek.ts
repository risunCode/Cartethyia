import type { ModelDefinition } from "../model-definition";
import { defineModel } from "../model-definition";

const DEEPSEEK_PROVIDER_ID = "deepseek" as const;

/**
 * DeepSeek's current chat families.
 *
 * The provider has live `/v1/models` discovery, so this catalog is not the only
 * source — it is the floor that keeps the models listed when discovery has not
 * run or the endpoint does not answer. That is why it carries only the two
 * current families rather than every id the base catalog files under `deepseek`:
 * a static row is a routing claim, and a stale or withdrawn id that discovery
 * would not return should not be claimed here either.
 *
 * `v4-flash` takes vision and `v4-pro` does not, as the base catalog files them.
 * Limits and pricing are resolved by `defineModel` from `providerId`, so nothing
 * numeric is restated to drift.
 *
 * Note on naming: the base catalog files `deepseek-v4.1-flash` under other
 * providers (aihubmix, alibaba, …) but not under `deepseek` itself, whose rows
 * are the `v4` spellings. The id sent upstream must be one the provider serves,
 * so this list uses the provider's own spelling.
 */
export const DEEPSEEK_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "deepseek-v4-flash",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "deepseek-v4-pro",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    reasoning: true,
    toolCall: true,
  }),
];
