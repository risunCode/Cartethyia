# Alias & Combo Routing

**How model name aliases and combos resolve through the public proxy API and console.**

---

## Quick Start

```bash
# Console (web UI): Combinations page → Aliases tab
# API:
curl -X POST http://localhost:12800/console/api/aliases \
  -H "Cookie: session=..." \
  -d '{"alias":"fast","model":"openai/gpt-5"}'

# Use via public API
curl -X POST http://localhost:12800/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"fast","messages":[{"role":"user","content":"hi"}]}'
```

---

## Resolution Chain (Every Request)

```
Request model: "fast"
       │
       ▼
resolveModelChain(rawModel, {prefixes, aliases, combos})
       │
       ├── qualified prefix?  (e.g. "openai/gpt-5")  ──► qualified
       ├── alias match?      (aliases.get("fast"))   ──► recurse on target
       ├── combo match?      (combos.get("fast"))    ──► combo (ordered candidates)
       └── none?             ──► unresolved (passthrough to routing)
```

**Source of truth**: `RoutingConfigService` (console) → `routeResolver` (data plane) — both read the same snapshot (`prefixes`, `aliases`, `combos`) from `RoutingSnapshot`.

---

## Alias

### Create / Update
```bash
POST /console/api/aliases
Content-Type: application/json
{ "alias": "my-model", "model": "cline/deepseek/deepseek-v4-flash" }
```
- `alias`: unique, trimmed, non-empty
- `model`: any valid model reference (qualified, alias, or combo name)
- Returns `AliasView` with `createdAt`
- Duplicate → `409 conflict`

### List
```bash
GET /console/api/aliases
# → { items: [{ alias, model, createdAt, metadata? }] }
```
- `metadata` attached when `modelMetadata` resolver configured (pricing/context from models.dev)

### Delete
```bash
DELETE /console/api/aliases/:alias
# → 200 {ok:true} or 404
```

---

## Combo

### Create
```bash
POST /console/api/combos
{
  "name": "trio",
  "models": ["openai/gpt-5", "anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"],
  "strategy": "fallback",        # "fallback" | "round-robin"
  "stickyLimit": 5               # 0 = global deterministic; >0 = per-affinity sticky
}
```

### List / Get / Delete
```bash
GET    /console/api/combos
GET    /console/api/combos/:id
DELETE /console/api/combos/:id
```

---

## Pricing & Context Inheritance

| Reference Type | Pricing / Context Source |
|----------------|--------------------------|
| Qualified (`openai/gpt-5`) | Catalog model directly |
| **Alias** (`fast → openai/gpt-5`) | **Inherits target's pricing/context** |
| **Combo** (`trio → [a, b, c]`) | **Aggregate**: max context, max price, union categories |

> This is why `claude-sonnet-3.5 → cline/deepseek/deepseek-v4-flash` shows context **1M/384k** and pricing **$0.14/$0.28** — inherited from the DeepSeek target.

---

## Public API Behavior

### Model Listing
```bash
GET /v1/models?authorization=Bearer $KEY
```
- Returns all catalog models + aliases + combos visible to the key's ACL
- Alias entries include `metadata` (pricing/context from target)
- Key's `modelAllowlist`/`modelDenylist` apply to **resolved** model IDs

### Chat / Completions
```bash
POST /v1/chat/completions
{ "model": "fast", "messages": [...] }
```
1. Resolve `fast` via chain above
2. If qualified/combo → build candidate routes
3. Route selection (account health, quota, cooldown, affinity)
4. Dispatch to provider adapter
5. **Error codes**:
   - `404 model_not_found` — alias target not in catalog (or combo empty)
   - `400 capability_unsupported` — target provider doesn't support surface
   - `503 credential_unavailable` — no eligible account (like live alias test)

---

## Live Verification

```bash
# Boot server, create alias, hit API — proves end-to-end resolution
bun run live:alias
```

Expected output:
```
alias appears in GET /v1/models → true
alias routes to cline provider via dispatch → true
resolved_in_dispatch: true  (error: credential_unavailable, NOT model_not_found)
```

---

## Console UI

**Combinations page** (`/combos`):
- **Aliases tab**: list, create, delete, see metadata (pricing/context)
- **Combos tab**: create with strategy/sticky, list, delete
- Both tabs show resolved metadata (context window, pricing, categories) from models.dev

---

## Migration / Breaking Changes

| Change | Migration |
|--------|-----------|
| Provider ID rename (e.g. `opencode-free` → `opencodeft`) | Auto-migrated on DB open (CHANGELOG 1.0.8) |
| Alias target model renamed | Update alias via `POST /console/api/aliases` (idempotent) |
| Combo member model renamed | Re-create combo or edit via `PUT /console/api/combos/:id` |

---

## Related

- `docs/model-catalog.md` — pricing/context source & sync
- `docs/protocol-translation.md` — usage normalization across surfaces
- `scripts/live-alias-test.ts` — end-to-end proof
- `src/console/services.ts` — `RoutingConfigService`
- `src/domain/routing.ts` — `resolveModelChain`