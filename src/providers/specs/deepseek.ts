import type { ModelDefinition } from "../model-definition";
import { defineModel } from "../model-definition";

const DEEPSEEK_PROVIDER_ID = "deepseek" as const;

/** Limits every V4 family shares, as the base catalog files `deepseek-v4-pro`. */
const V4_CONTEXT = 1_000_000;
const V4_OUTPUT = 384_000;

/**
 * DeepSeek's V4 chat families.
 *
 * The provider has live `/v1/models` discovery, so this catalog is not the only
 * source — it is the floor that keeps these models listed when discovery has not
 * run or the endpoint does not answer.
 *
 * Two of these rows are routing aliases rather than separate models: 9router
 * files `deepseek-v4-pro-max` and `deepseek-v4-pro-none` against
 * `upstreamModelId: deepseek-v4-pro`, and the base catalog has no row for
 * either. Their limits are therefore stated explicitly as the `deepseek-v4-pro`
 * limits rather than left to `defineModel`'s fallback, which would publish the
 * generic 200k/64k default — a number that is not DeepSeek's and reads as
 * measured. `v4-pro-none` is the no-thinking variant, so it is the one row here
 * that does not claim reasoning.
 *
 * `v4-flash` and its vision-experimental sibling take image input; `v4-pro` and
 * the aliases do not. The two alias rows publish `cost: unknown`: the base
 * catalog has no row under their ids, and `costFor` resolves by id, so there is
 * no honest rate to attach — billing them at `v4-pro`'s rate would be a guess
 * presented as a measurement.
 *
 * Note on naming: the base catalog does not file `deepseek-v4.1-flash` under
 * `deepseek` (it files it under aihubmix, alibaba, …), but the id is a real
 * DeepSeek id — 9router lists it as such — so it is included and resolves its
 * limits through the majority row rather than a provider-scoped one.
 *
 * Deliberately excluded: `deepseek-chat` and `deepseek-reasoner`, which are the
 * V3.2 families rather than V4.
 */
export const DEEPSEEK_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "deepseek-v4-pro",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    reasoning: true,
    toolCall: true,
  }),
  // Alias of `deepseek-v4-pro` upstream, so it carries that model's limits.
  defineModel({
    id: "deepseek-v4-pro-max",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    ctx: V4_CONTEXT,
    out: V4_OUTPUT,
    reasoning: true,
    toolCall: true,
  }),
  // Alias of `deepseek-v4-pro` upstream, in its non-thinking mode.
  defineModel({
    id: "deepseek-v4-pro-none",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    ctx: V4_CONTEXT,
    out: V4_OUTPUT,
    reasoning: false,
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
  defineModel({
    id: "deepseek-v4-flash",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "deepseek-v4-flash-vision-exp",
    providerId: DEEPSEEK_PROVIDER_ID,
    wireFamily: "chat",
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];
