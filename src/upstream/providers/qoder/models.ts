import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

export interface QoderModelConfig {
  id: string;
  display_name: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  is_vl: boolean;
  is_reasoning: boolean;
  source?: string;
}

const REASONING_VISION: ProviderModelEntry["capabilities"] = ["text", "vision", "reasoning", "streaming", "json", "tools"];
const VISION_STREAMING: ProviderModelEntry["capabilities"] = ["text", "vision", "streaming", "json", "tools"];
const TEXT_STREAMING: ProviderModelEntry["capabilities"] = ["text", "streaming", "json", "tools"];

const MODELS: ProviderModelEntry[] = [
  { id: "auto", capabilities: VISION_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Auto" },
  { id: "ultimate", capabilities: REASONING_VISION, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Ultimate" },
  { id: "performance", capabilities: VISION_STREAMING, contextWindow: 272000, maxOutputTokens: 64000, description: "Qoder Performance" },
  { id: "efficient", capabilities: VISION_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Efficient" },
  { id: "lite", capabilities: TEXT_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Lite" },
  { id: "qmodel", capabilities: VISION_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Qwen 3.6 Plus" },
  { id: "qmodel_latest", capabilities: VISION_STREAMING, contextWindow: 1000000, maxOutputTokens: 64000, description: "Qoder Qwen 3.7 Max" },
  { id: "qmodel_preview", capabilities: VISION_STREAMING, contextWindow: 1000000, maxOutputTokens: 64000, description: "Qoder Qwen 3.8 Max" },
  { id: "dmodel", capabilities: REASONING_VISION, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder DeepSeek V4 Pro" },
  { id: "dfmodel", capabilities: REASONING_VISION, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder DeepSeek V4 Flash" },
  { id: "gm51model", capabilities: REASONING_VISION, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder GLM 5.2" },
  { id: "kmodel", capabilities: VISION_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder Kimi K2.7" },
  { id: "mmodel", capabilities: VISION_STREAMING, contextWindow: 256000, maxOutputTokens: 64000, description: "Qoder MiniMax M2.7" },
];

export const qoderModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);

/** Static model config — mirrors OmniArk's QODER_MODELS. Used instead of
 *  fetching from Qoder's model catalog API (which has token propagation
 *  issues and returns 403 "Login expired" intermittently). */
export const QODER_MODEL_CONFIGS: Record<string, QoderModelConfig> = {
  auto:          { id: "auto",          display_name: "Auto",              max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  ultimate:      { id: "ultimate",      display_name: "Ultimate",          max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  performance:   { id: "performance",   display_name: "Performance",       max_input_tokens: 272000, is_vl: true,  is_reasoning: false },
  efficient:     { id: "efficient",     display_name: "Efficient",         max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  lite:          { id: "lite",          display_name: "Lite",              max_input_tokens: 180000, is_vl: false, is_reasoning: false },
  qmodel:        { id: "qmodel",        display_name: "Qwen 3.6 Plus",    max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  qmodel_latest: { id: "qmodel_latest", display_name: "Qwen 3.7 Max",     max_input_tokens: 1000000, is_vl: true,  is_reasoning: false },
  qmodel_preview:{ id: "qmodel_preview",display_name: "Qwen 3.8 Max",     max_input_tokens: 1000000, is_vl: true,  is_reasoning: false },
  dmodel:        { id: "dmodel",        display_name: "DeepSeek V4 Pro",   max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  dfmodel:       { id: "dfmodel",       display_name: "DeepSeek V4 Flash", max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  gm51model:     { id: "gm51model",     display_name: "GLM 5.1",           max_input_tokens: 180000, is_vl: true,  is_reasoning: true },
  kmodel:        { id: "kmodel",        display_name: "Kimi K2.6",         max_input_tokens: 256000, is_vl: true,  is_reasoning: false },
  mmodel:        { id: "mmodel",        display_name: "MiniMax M2.7",      max_input_tokens: 180000, is_vl: true,  is_reasoning: false },
  kmodel_latest: { id: "kmodel_latest", display_name: "Kimi K2.7 Latest",  max_input_tokens: 256000, is_vl: true,  is_reasoning: false },
};
