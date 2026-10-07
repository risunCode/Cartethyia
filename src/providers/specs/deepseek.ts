import type { ModelDefinition } from "../model-definition";
import { defineModel } from "../model-definition";

const DEEPSEEK_PROVIDER_ID = "deepseek" as const;

/**
 * The DeepSeek V4 families that are still live upstream.
 *
 * The provider has live `/v1/models` discovery, so this catalog is not the only
 * source — it is the floor that keeps these models listed when discovery has not
 * run or the endpoint does not answer.
 *
 * Only two rows, and the retired ones are gone rather than marked: 9router's
 * capability tables record that `deepseek-v4.1-flash` replaces `v4-flash` — it
 * was dropped from the published server list and, with `v4-flash-vision-exp`,
 * now routes to `v4.1-flash` upstream. `v4-pro-max` and `v4-pro-none` are
 * likewise routing aliases of `deepseek-v4-pro`, not models of their own.
 *
 * Limits and pricing resolve from the base catalog via `providerId`, so no
 * number is restated here to drift. `deepseek-v4.1-flash` is the exception: the
 * base catalog does not file it under `deepseek` (it files it under aihubmix,
 * alibaba, …), so it resolves through the majority row instead of a
 * provider-scoped one. That is the honest resolution — inventing limits here
 * would publish a guess as a measurement.
 *
 * There is no `v4.1-pro`: neither 9router nor the base catalog carries that id,
 * so `v4-pro` stays as the Pro row. `deepseek-chat` and `deepseek-reasoner` are
 * excluded as V3.2 families, not V4.
 */
export const DEEPSEEK_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "deepseek-v4-pro",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "deepseek-v4.1-flash",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];
