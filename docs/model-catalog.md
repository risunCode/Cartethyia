# Model Catalog & Pricing Reference

**Canonical source of truth for model metadata** — context windows, token pricing, capabilities, and categories. All data sourced from **[models.dev](https://models.dev)** and vendored locally for offline, deterministic operation.

---

## Quick Start

```bash
# Pull latest models.dev data & regenerate the vendored catalog
bun run sync:models          # downloads models.dev/api.json → generates model-data.generated.ts

# Run live alias test (proves pricing/context flow through aliases)
bun run live:alias
```

---

## Architecture

```
models.dev/api.json (3.5 MB, 180 providers)
       │
       ▼  sync-model-data.ts  (trim to only models declared in repo catalogs)
       │
       ▼  src/providers/model-data.generated.ts  (generated entries, <10 KB)
       │
       ▼  src/providers/model-data.ts  (lookupModelData: O(1) map read, module-cached)
       │
       ▼  modelMetadataLookup (composition.ts)  ← fallback for catalog models
       │
       ▼  resolveModelMetadata (model-metadata.ts)  ← aggregates for aliases/combos
```

**Key principle**: *Never fabricate*. Unknown/missing references return `null` → callers stay permissive (no invented limits/prices).

---

## Data Model

```typescript
// src/domain/contracts.ts
interface ModelContextLimits {
  readonly inputTokens: number | null;   // max prompt/context tokens
  readonly outputTokens: number | null;  // max completion tokens
}

interface ModelTokenPricing {
  readonly inputPerMillion: number | null;   // USD per 1M input tokens
  readonly outputPerMillion: number | null;  // USD per 1M output tokens
}
```

```typescript
// src/providers/model-data.ts
interface CatalogModelData {
  readonly context: ModelContextLimits;
  readonly pricing: ModelTokenPricing;
}

// O(1) lookup: providerId/modelId → data | null
function lookupModelData(providerId: string, modelId: string): CatalogModelData | null;
```

---

## Provider ID Mapping

| Repo Provider ID | models.dev Provider ID | Notes |
|------------------|------------------------|-------|
| `openai`         | `openai`               | |
| `anthropic`      | `anthropic`            | |
| `gemini`         | `google`               | **alias** |
| `cline`          | `cline`                | gateway |
| `clinepass`      | `clinepass`            | gateway |
| `deepseek`       | `deepseek`             | |
| `google-antigravity` | `google`            | alias |
| `opencodeft`     | `opencode`             | |
| `codex`          | `openai`               | gateway (ChatGPT Codex) |
| `commandcode`    | (none)                 | no models.dev entry |
| `qoder`          | (none)                 | |
| `kiro`           | (none)                 | |
| `kimchi`         | (none)                 | |
| `agentrouter`    | (none)                 | |

**Model IDs with slashes** (`cline/deepseek/deepseek-v4-flash`, `cline/deepseek/deepseek/deepseek-flash`, `deepseek/deepseek-v4-flash`, `openai/gpt-5`) are split at the first `/` only. For example, `cline/deepseek/deepseek/deepseek-flash` becomes provider `cline` plus model ID `deepseek/deepseek/deepseek-flash`; nested slashes remain part of the model ID and are supported.

---

## Fallback Behavior

| Scenario | Result |
|----------|--------|
| Exact match in `MODEL_DATA` | Return `{context, pricing}` |
| Provider alias (`gemini` → `google`) | Resolved automatically |
| Provider-qualified model ID (`cline/deepseek-v4-flash`) | Split & lookup |
| Missing in models.dev (e.g., `claude-3-7-sonnet`) | `null` → permissive (no fabricated limits) |
| Custom provider / unknown provider | `null` → permissive |

**Alias & Combo Resolution** (`resolveModelMetadata`):
- Router alias target → metadata uses `kind: "router"` and inherits target's pricing/context, categories, source, and update timestamp
- Combo members → aggregate: **max context**, **max price**, union categories, `source: "custom"` if any member custom
- The public model ID remains the alias or combo name; resolution happens only during dispatch

---

## Syncing Fresh Data

```bash
# 1. Download & vendor (overwrites models-dev.api.json + model-data.generated.ts)
bun run sync:models [path-to-api.json]

# 2. Or re-download automatically
bun run sync:models   # downloads from https://models.dev/api.json
```

**What `sync-model-data.ts` does:**
1. Loads `models-dev.api.json` (local or re-downloads)
2. Loads **all repo provider catalogs** via `createDefaultRegistry()`
3. For each declared model: resolves `providerId/modelId` → models.dev entry
4. Extracts `cost.input/output` + `limit.context/output`
5. Keeps only entries with ≥1 non-null field
6. Writes `MODEL_DATA` map to `model-data.generated.ts`

**Typical output:**
```
models_evaluated: 226
data_entries_written: 28
unresolved_or_missing: 198
```

> Missing entries are normal — models.dev doesn't cover every model ID the repo declares (custom providers, gateway-specific IDs, etc.). They stay `null` (permissive).

---

## Example: Pricing/Context via Alias

```bash
# Create alias
curl -X POST http://localhost:12800/console/api/aliases \
  -H "Cookie: session=..." \
  -d '{"alias":"my-claude","model":"cline/deepseek/deepseek-v4-flash"}'

# List models → alias appears with inherited pricing/context
curl http://localhost:12800/v1/models -H "Authorization: Bearer $KEY"
# → "my-claude": { context: {input:1000000,output:384000}, pricing:{input:0.14,output:0.28} }

# Chat via alias → inherits target's pricing/context
curl -X POST http://localhost:12800/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"my-claude","messages":[{"role":"user","content":"hi"}]}'
```

---

## Adding a New Provider to Catalog

1. Add adapter in `src/providers/<name>.ts` with `modelOf(id, name, capabilities, {context, pricing})`
2. Register in `createDefaultRegistry()` (`src/providers/registry.ts`)
3. Run `bun run sync:models` → auto-picks up new models if present in models.dev
4. If provider not in models.dev → pricing/context stay `null` (permissive)

---

## Related Docs

- `docs/alias-routing.md` — alias/combo resolution & pricing inheritance
- `docs/protocol-translation.md` — usage normalization & response shaping
- `docs/oauth-drivers.md` — OAuth driver registry & custom drivers
- `scripts/sync-model-data.ts` — sync script source
- `src/providers/model-data.ts` — lookup function source