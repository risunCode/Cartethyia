/**
 * Syncs models.dev pricing/context data into a small generated catalog used by
 * the runtime. Reads the full models.dev api.json (local file or re-downloaded)
 * and keeps ONLY the provider/model pairs that the repo's provider catalogs
 * actually declare, so the vendored artifact stays tiny and there is nothing
 * hand-maintained per model.
 *
 * Run:  bun run scripts/sync-model-data.ts [path-to-models-dev-api.json]
 *   - no arg reads ./models-dev.api.json (or re-downloads from models.dev).
 * Writes: src/providers/model-data.generated.ts
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createDefaultRegistry } from "../src/providers/registry";

const MODEL_DEV_URL = "https://models.dev/api.json";

/** Repo provider id → models.dev provider id where they differ. */
const PROVIDER_ALIAS: Readonly<Record<string, string>> = {
  gemini: "google",
  codex: "openai",
};

function resolveDevRef(providerId: string, modelId: string): { p: string; m: string } | null {
  let p = providerId;
  let m = modelId;
  const slash = modelId.indexOf("/");
  if (slash !== -1) {
    p = modelId.slice(0, slash);
    m = modelId.slice(slash + 1);
  }
  p = PROVIDER_ALIAS[p] ?? p;
  if (p.length === 0 || m.length === 0) return null;
  return { p, m };
}

/**
 * Extracts the last path segment of a model id (after the final `/`).
 * Used as a fallback when the canonical `provider/model` pair doesn't exist
 * in models.dev — gateway/router providers nest upstream ids under multiple
 * prefix segments (e.g. `blackboxai/z-ai/glm-5.2`) while models.dev keys the
 * data under the canonical provider (`zai/glm-5.2`).
 */
function lastSegment(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * Tries to find a models.dev entry for a repo model by:
 * 1. Exact `provider/model` match (via resolveDevRef).
 * 2. Last-segment fallback: scan all models.dev providers for a model whose
 *    id matches the last segment of the requested modelId.
 */
function findDevEntry(modelsDev: Record<string, any>, providerId: string, modelId: string): { provider: string; modelId: string; entry: Record<string, any> } | null {
  const ref = resolveDevRef(providerId, modelId);
  if (ref !== null) {
    const entry = modelsDev[ref.p]?.models?.[ref.m];
    if (entry !== undefined) return { provider: ref.p, modelId: ref.m, entry };
  }
  // Last-segment fallback: scan all providers for a model with the same tail.
  const tail = lastSegment(modelId);
  if (tail.length > 0 && tail !== modelId) {
    for (const [prov, data] of Object.entries(modelsDev)) {
      if (data?.models?.[tail] !== undefined) return { provider: prov, modelId: tail, entry: data.models[tail] };
    }
  }
  return null;
}

async function loadModelsDev(source: string | undefined, download: boolean): Promise<Record<string, any>> {
  if (source && existsSync(source)) return JSON.parse(await Bun.file(source).text());
  if (download) {
    const response = await fetch(MODEL_DEV_URL);
    if (!response.ok) throw new Error(`models.dev download failed: ${response.status}`);
    const text = await response.text();
    if (source) writeFileSync(source, text);
    return JSON.parse(text);
  }
  throw new Error(`models.dev data not found at ${source}; pass it or allow download`);
}

function extract(entry: Record<string, any>): { context: { input: number | null; output: number | null }; pricing: { input: number | null; output: number | null } } {
  const cost = (entry?.cost ?? {}) as Record<string, unknown>;
  const limit = (entry?.limit ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    context: { input: num(limit.context), output: num(limit.output) },
    pricing: { input: num(cost.input), output: num(cost.output) },
  };
}

const sourceArg = process.argv[2];
const modelsDev = await loadModelsDev(sourceArg, sourceArg === undefined || !existsSync(sourceArg));

const registry = await createDefaultRegistry();
const out: Record<string, unknown> = {};
let matched = 0;
let total = 0;
const missing: string[] = [];

const modelsOf = (adapter: { models: { list: readonly unknown[] } | readonly unknown[] }): readonly unknown[] => {
  const catalog = adapter.models;
  return Array.isArray(catalog) ? catalog : Array.isArray((catalog as { list: unknown }).list) ? (catalog as { list: readonly unknown[] }).list : [];
};

for (const adapter of registry.list()) {
  for (const raw of modelsOf(adapter)) {
    const model = raw as { id: string };
    total += 1;
    const found = findDevEntry(modelsDev, adapter.metadata.id, model.id);
    if (found === null) {
      missing.push(model.id);
      continue;
    }
    const data = extract(found.entry);
    // Keep entries that have at least one non-null context or price.
    if (data.context.input !== null || data.context.output !== null || data.pricing.input !== null || data.pricing.output !== null) {
      out[`${found.provider}/${found.modelId}`] = data;
      matched += 1;
    }
  }
}

const header = `// GENERATED FILE — do not edit by hand. Regenerate with: bun run scripts/sync-model-data.ts\n`;
const body = `export const MODEL_DATA: Record<string, { context: { input: number | null; output: number | null }; pricing: { input: number | null; output: number | null } }> = ${JSON.stringify(out, null, 2)};\n`;
mkdirSync("src/providers", { recursive: true });
writeFileSync("src/providers/model-data.generated.ts", header + body);

console.log(
  JSON.stringify(
    {
      written: "src/providers/model-data.generated.ts",
      models_evaluated: total,
      data_entries_written: matched,
      unresolved_or_missing: missing.length,
      sample_missing: missing.slice(0, 20),
    },
    null,
    2,
  ),
);
