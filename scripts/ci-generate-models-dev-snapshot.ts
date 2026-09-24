/**
 * Rebuilds the offline models.dev snapshot at
 * `src/providers/discovery/base-models.json`.
 *
 * Run manually when the catalog should be refreshed — never at server runtime.
 * `models-dev-catalog.ts` reads only the committed snapshot (no live `fetch`),
 * so the server never makes an outbound call to models.dev.
 *
 *   bun run scripts/ci-generate-models-dev-snapshot.ts
 *
 * The snapshot is pruned to the fields the resolver reads (limits, modalities,
 * capabilities, cost) and flattened to one row per `provider:model`, which
 * keeps it small enough to commit while the raw upstream payload (~5 MB) is
 * not. `cost` is kept because pricing is the one thing models.dev is
 * authoritative for here — a model's own upstream `/models` response rarely
 * states a price.
 */
import path from "node:path";

const SNAPSHOT_PATH = path.join(import.meta.dir, "../src/providers/discovery/base-models.json");
const SOURCE_URL = "https://models.dev/api.json";

interface RawCost {
  readonly input?: number;
  readonly output?: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
}

interface RawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly reasoning?: unknown;
  readonly tool_call?: unknown;
  readonly cost?: RawCost;
}

interface SnapshotRow {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly context: number | null;
  readonly output: number | null;
  readonly input: readonly string[];
  readonly outputModalities: readonly string[];
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly cost: RawCost;
}

/** Trims a numeric field to a finite, positive integer or `null`. */
function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pruneCost(cost: RawCost | undefined): RawCost {
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
    const value = cost?.[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`models.dev responded with HTTP ${response.status}`);
const payload: unknown = await response.json();
if (typeof payload !== "object" || payload === null) {
  throw new Error("models.dev returned an invalid catalog");
}

const rows: SnapshotRow[] = [];
for (const [provider, providerValue] of Object.entries(payload as Record<string, unknown>)) {
  if (typeof providerValue !== "object" || providerValue === null) continue;
  const rawModels = (providerValue as { models?: Record<string, unknown> }).models;
  if (rawModels === undefined || typeof rawModels !== "object") continue;
  for (const modelValue of Object.values(rawModels)) {
    if (typeof modelValue !== "object" || modelValue === null) continue;
    const model = modelValue as RawModel;
    const id = typeof model.id === "string" && model.id.length > 0 ? model.id : undefined;
    if (id === undefined) continue;
    rows.push({
      provider,
      id,
      ...(typeof model.name === "string" && model.name.length > 0 ? { name: model.name } : {}),
      context: limit(model.limit?.context),
      output: limit(model.limit?.output),
      input: stringList(model.modalities?.input),
      outputModalities: stringList(model.modalities?.output),
      reasoning: model.reasoning === true,
      toolCall: model.tool_call === true,
      cost: pruneCost(model.cost),
    });
  }
}

rows.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));

const snapshot = { source: "models.dev", fetchedAt: new Date().toISOString(), models: rows };
// Minified: this is a machine-read data file, and pretty-printing it roughly
// triples the bytes that ship in the binary for no reader's benefit.
await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
console.log(
  `Wrote ${rows.length} rows across ${new Set(rows.map((r) => r.provider)).size} providers to ${SNAPSHOT_PATH}`,
);
