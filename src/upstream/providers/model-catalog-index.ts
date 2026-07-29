/**
 * Cross-provider known-model metadata index (REQ-8 follow-up).
 *
 * Discovery (`GET {baseUrl}/models`) only ever returns bare model ids — no
 * capabilities, context window, or max output tokens. When a discovered id
 * happens to name a model we already know about from another provider's
 * curated catalog (e.g. `gpt-oss-120b` on both Cerebras and Ollama), we can
 * back-fill the same specs instead of showing a bare "text, streaming"
 * placeholder. Falls back to that placeholder when nothing matches.
 */

import { providerRegistry } from "./index";
import type { ModelCapability } from "./models";

export interface KnownModelMeta {
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

const FALLBACK_META: KnownModelMeta = { capabilities: ["text", "streaming"] };

let cachedIndex: Map<string, KnownModelMeta> | undefined;

function normalize(id: string): string {
  // Vendor-path ids ("Qwen/Qwen3-8B", "deepseek-ai/DeepSeek-V3") and bare ids
  // ("deepseek-v4-pro") both reduce to their trailing segment, lowercased and
  // stripped of punctuation, so equivalent models line up across providers.
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildIndex(): Map<string, KnownModelMeta> {
  const index = new Map<string, KnownModelMeta>();
  for (const provider of providerRegistry.all()) {
    for (const model of provider.models.list()) {
      const key = normalize(model.id);
      // First writer wins — providers are registered in a stable order and a
      // collision is expected to describe the same real-world model.
      if (!index.has(key)) {
        index.set(key, { capabilities: model.capabilities, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens });
      }
    }
  }
  return index;
}

/** Best-effort metadata for a bare discovered model id — exact/normalized match against every known catalog, else the text+streaming fallback. */
export function lookupKnownModelMeta(modelId: string): KnownModelMeta {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex.get(normalize(modelId)) ?? FALLBACK_META;
}

/** Test-only: clear the cached index so a test's provider registrations are re-scanned. */
export function resetModelCatalogIndexForTests(): void {
  cachedIndex = undefined;
}
