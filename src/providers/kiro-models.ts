import { capabilitiesOf, createModelCatalog, modelOf } from "./shared";
import type { CapabilitySeed } from "./shared";
import type { ProviderModel, ProviderModelCatalog, ProviderSurface } from "../domain/contracts";

/**
 * Kiro AI model catalog — the curated set of Claude / GPT-5.6 / open models
 * exposed through the Kiro gateway (https://kiro.dev). Every model is
 * reasoning-capable; the GPT-5.6 family also accepts image inputs. Mirrors
 * the legacy `kiro-models.ts` catalog.
 */

const KIRO_SURFACES: readonly ProviderSurface[] = ["openai-chat"];

function kiroModel(id: string, displayName: string, seed: Partial<CapabilitySeed> = {}): ProviderModel {
  return modelOf(id, displayName, capabilitiesOf({ surfaces: KIRO_SURFACES, reasoning: true, ...seed }));
}

function claudeFamily(base: string, label: string): readonly ProviderModel[] {
  return [
    kiroModel(base, label),
    kiroModel(`${base}-thinking`, `${label} (Thinking)`),
    kiroModel(`${base}-agentic`, `${label} (Agentic)`),
    kiroModel(`${base}-thinking-agentic`, `${label} (Thinking Agentic)`),
  ];
}

function gptFamily(base: string, label: string): readonly ProviderModel[] {
  return [
    kiroModel(base, label, { images: true }),
    kiroModel(`${base}-thinking`, `${label} (Thinking)`, { images: true }),
    kiroModel(`${base}-agentic`, `${label} (Agentic)`, { images: true }),
    kiroModel(`${base}-thinking-agentic`, `${label} (Thinking Agentic)`, { images: true }),
  ];
}

const KIRO_MODELS: readonly ProviderModel[] = [
  ...claudeFamily("claude-opus-4.8", "Claude Opus 4.8"),
  ...claudeFamily("claude-opus-4.7", "Claude Opus 4.7"),
  ...claudeFamily("claude-opus-4.5", "Claude Opus 4.5"),
  ...claudeFamily("claude-sonnet-5", "Claude Sonnet 5"),
  ...claudeFamily("claude-sonnet-4.5", "Claude Sonnet 4.5"),
  ...claudeFamily("claude-haiku-4.5", "Claude Haiku 4.5"),
  kiroModel("auto", "Kiro Auto", { reasoning: false }),
  kiroModel("auto-thinking", "Kiro Auto (Thinking)"),
  kiroModel("auto-thinking-agentic", "Kiro Auto (Thinking Agentic)"),
  kiroModel("deepseek-3.2", "DeepSeek 3.2"),
  kiroModel("qwen3-coder-next", "Qwen3 Coder Next"),
  kiroModel("glm-5", "GLM-5"),
  ...gptFamily("gpt-5.6-sol", "GPT-5.6 Sol"),
  ...gptFamily("gpt-5.6-terra", "GPT-5.6 Terra"),
  ...gptFamily("gpt-5.6-luna", "GPT-5.6 Luna"),
];

/** The Kiro catalog in the shared registry convention (an array of models). */
export const kiroModelCatalog: readonly ProviderModel[] = KIRO_MODELS;

/** Catalog accessor for the Kiro adapter itself. */
export const kiroModels: ProviderModelCatalog = createModelCatalog(KIRO_MODELS);
