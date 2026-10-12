/**
 * Factory Droid model catalog.
 *
 * Transcribed from oh-my-pi `packages/catalog/src/compat/rules/providers/factory-droid.kdl`
 * and the wire routing in `runtime/behavior.kdl`, which names the upstream wire per
 * model id. Limits and the text/image split come from each seed row there, not
 * from a guess: Factory bills credits and publishes no prices, so `cost` stays null.
 *
 * The Gemini ids (`garnet-07-15`, `gemini-3.1-pro-preview`, `gemini-3.8-flash`,
 * `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`,
 * `gemini-3-flash-preview`) are absent. Factory serves them on its
 * `google-generate` wire, which this gateway does not implement; routing them
 * onto chat would post to an endpoint Factory does not serve rather than say so.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";
import type { WireFamily } from "../../../protocol/canonical-model";

export const FACTORY_PROVIDER_ID = "factory" as const;

/** The proxy path per wire family; see `factory.ts` for why they differ. */
const ENDPOINT_BY_WIRE: Readonly<Record<WireFamily, string>> = {
  chat: "/api/llm/o/v1/chat/completions",
  responses: "/api/llm/o/v1/responses",
  messages: "/api/llm/a/v1/messages",
};

type CatalogRow = readonly [id: string, wire: WireFamily, ctx: number, out: number, vision: boolean, reasoning: boolean];

function factoryModel([id, wireFamily, ctx, out, vision, reasoning]: CatalogRow): ModelDefinition {
  return defineModel({
    id,
    providerId: FACTORY_PROVIDER_ID,
    wireFamily,
    endpoint: ENDPOINT_BY_WIRE[wireFamily],
    ctx,
    out,
    vision,
    reasoning,
    toolCall: true,
  });
}

/** Static Factory Droid catalog; live discovery replaces it per account. */
export const FACTORY_MODELS: readonly ModelDefinition[] = [
  ["claude-fable-5.1", "messages", 867000, 128000, true, true] as const,
  ["claude-fable-5", "messages", 867000, 128000, true, true] as const,
  ["claude-opus-5-5", "messages", 872000, 128000, true, true] as const,
  ["claude-opus-5-5-fast", "chat", 872000, 128000, true, true] as const,
  ["claude-opus-5", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-5-fast", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-4-8", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-4-8-fast", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-4-7", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-4-6", "chat", 867000, 128000, true, true] as const,
  ["claude-opus-4-5-20251101", "chat", 180000, 64000, true, true] as const,
  ["claude-sonnet-5-5", "chat", 872000, 128000, true, true] as const,
  ["claude-sonnet-5", "chat", 872000, 128000, true, true] as const,
  ["claude-sonnet-4-6", "chat", 931000, 64000, true, true] as const,
  ["claude-sonnet-4-5-20250929", "chat", 180000, 32000, true, true] as const,
  ["claude-haiku-5-5", "chat", 872000, 128000, true, true] as const,
  ["claude-haiku-4-5-20251001", "chat", 180000, 32000, true, true] as const,
  ["gpt-6-astra", "responses", 922000, 128000, true, true] as const,
  ["gpt-6.1-sol", "responses", 922000, 128000, true, true] as const,
  ["gpt-6-sol", "responses", 922000, 128000, true, true] as const,
  ["gpt-6-luna", "responses", 922000, 128000, true, true] as const,
  ["gpt-5.6-sol", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.6-sol-fast", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.6-terra", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.6-luna", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.5", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.5-fast", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.5-pro", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.4", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.4-fast", "chat", 922000, 128000, true, true] as const,
  ["gpt-5.4-mini", "chat", 272000, 128000, true, true] as const,
  ["gpt-5.4-mini-fast", "chat", 272000, 128000, true, true] as const,
  ["gpt-5.3-codex", "chat", 272000, 128000, true, true] as const,
  ["gpt-5.3-codex-fast", "chat", 272000, 128000, true, true] as const,
  ["gpt-5.2", "chat", 272000, 128000, true, true] as const,
  ["gemini-3.7-flash", "chat", 1000000, 65536, true, true] as const,
  ["gemini-3.6-flash", "chat", 1000000, 65536, true, true] as const,
  ["gemini-3.5-flash", "chat", 1000000, 65536, true, true] as const,
  ["gemini-3-flash-preview", "chat", 1000000, 65536, true, true] as const,
  ["inkling", "chat", 1007232, 32768, true, true] as const,
  ["mistral-large-4", "chat", 524288, 64000, true, true] as const,
  ["mistral-medium-3.5", "chat", 192000, 64000, true, true] as const,
  ["glm-5.3-flash", "chat", 917504, 131072, true, true] as const,
  ["glm-5.3", "chat", 908928, 131072, false, true] as const,
  ["glm-5.2", "chat", 908928, 131072, false, true] as const,
  ["glm-5.2-fast", "chat", 393216, 131072, false, true] as const,
  ["kimi-k3", "chat", 196608, 65536, true, true] as const,
  ["qwen3.8-max", "chat", 131072, 131072, false, true] as const,
  ["nemotron-3-ultra", "chat", 136464, 65536, false, true] as const,
  ["deepseek-v4.1-flash", "chat", 908928, 131072, true, true] as const,
  ["deepseek-v4-flash-0731", "chat", 908928, 131072, false, true] as const,
  ["deepseek-v4-pro", "chat", 908928, 131072, false, true] as const,
  ["minimax-m3", "chat", 448000, 64000, true, true] as const,
  ["grok-4.7", "chat", 436644, 63356, true, true] as const,
  ["grok-4.6", "chat", 200000, 63356, true, true] as const,
  ["grok-4.5", "chat", 200000, 63356, true, true] as const,
  ["atlas-07-21", "chat", 867000, 128000, true, true] as const,
  ["aster-07-15", "chat", 867000, 128000, true, true] as const,
  ["minimax-m2.7", "chat", 196600, 64000, false, true] as const,
].map(factoryModel);
