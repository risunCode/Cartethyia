# Routing aliases and combos

Two ways to give a model name other than the one the catalog carries:

- **Alias** — one name for another. `fast` → `gpt-5-mini`.
- **Combo** — one name for several, dispatched as a unit under a strategy.

Both are per-tenant rows compiled into the route snapshot. Aliases resolve
*before* candidate filtering, so an alias never has to name a model that exists:
it only has to resolve to one that does.

## Data

| Table | Key | Holds |
| --- | --- | --- |
| `model_aliases` | unique `(tenant_id, alias)` | `target_model`, `sort_index` |
| `model_combos` | unique `(tenant_id, name)` | `members` (`text[]`), `strategy`, `sort_index` |

`strategy` is `fallback` or `round_robin`. There is no fusion strategy — it was
dropped in `0003_drop_fusion_and_minimum_balance.sql`, and existing rows became
`fallback`. The dashboard's option list is
`dashboard/src/features/routing/combo-strategy.ts`, which is typed against the
canonical union so adding a strategy fails typecheck until an option is
provided.

`sort_index` is explicit list position (`0019_list_sort_index.sql`), not a
creation-time ordering — reorder is a real write.

## Resolution

Everything runs in `resolveAlias` (`src/transport/routing/router.ts:137`) against
the merged alias map, and every step is bounded:

1. **Thinking suffix is stripped first**, in `ProxyRequestPreparer`
   (`src/transport/request/preparer.ts:101`). `model(high)` is a statement about
   the request, not about any one upstream, and it must go before anything
   matches on the name — otherwise alias resolution, the allowlist, the prefix
   check, and routing all see a name that matches nothing, and alias resolution
   swallows its own failure into a silent miss.
2. **`normalizeAliasKey`** (`router.ts:74`) makes a full model id honor the same
   mapping as the short name. A trailing `[...]` variant is stripped
   (`claude-opus-5[1m]` → `claude-opus-5`), then the family-slot fallback takes
   `claude-opus-5` → `opus`. Both only fire when the full name has no mapping of
   its own.
3. **The alias chain walks** to a fixed point with a `seen` set (cycle →
   `routing alias cycle`) and a depth cap of 16.
4. **Combo expansion** runs per member through `expandMember`, recursively, with
   its own `seen` set. An alias may target a combo and a combo may nest another
   combo, so a member naming a combo expands to its models rather than matching
   nothing and reading as `model_not_found` for a route the operator defined.

Then `resolveMatchingCandidates` filters `snapshot.candidates`:

- A bare name matches `model_id`; a `provider/model` name matches both.
- `matching.length === 0` → `modelNotFoundError`, which reports the resolved
  chain: `'opus' is not routed — it resolved to 'gpt-5-nano', which no account
  serves`.
- More than one owner for a name that contains no `/` and is not a combo →
  `ambiguousModelError`. Resolving through an alias is never a silent way around
  ambiguity protection.
- Combo members that matched zero candidates are collected as `unmatchedMembers`
  and reported on the error, so a misconfigured member is named instead of
  failing opaquely on whichever member happened to route.

`isModelAllowed` is then consulted against the *resolved* target as well as the
requested name, so an alias cannot be used to reach a model the key may not use.

## Snapshot

`route-catalog.ts` reads `aliasRows` and `combos` and returns
`snapshot.aliases[tenantId]` and `snapshot.combos[tenantId]`. Both are built into
one frozen snapshot with the CLI mapping table, provider routing, and pool
routing; a console mutation calls `invalidate()`, which bumps the revision and
drops the cache. The mutation does not wait for the rebuild — the next gateway
request does that.

## CLI mapping shares this resolver

Per-key CLI slots resolve through the same `resolveAlias`, with a second map
merged in only when the key's scope and the request's User-Agent allow it. Within
one bucket the CLI row wins for the names it covers. See
[CLI model mapping](cli-model-mapping.md).

## Console

Domain: `src/console/routing/model/`, mounted at `/console/api/routing`.

| Route | Purpose |
| --- | --- |
| `GET /aliases`, `POST /aliases`, `PATCH /aliases/:id`, `DELETE /aliases/:id` | CRUD |
| `POST /aliases/reorder` | Persist list order |
| `GET /combos`, `POST /combos`, `PATCH /combos/:id`, `DELETE /combos/:id` | CRUD |
| `POST /combos/reorder` | Persist list order |
| `POST /combos/:id/clone` | Copy a combo, including its members |

Writes invalidate the route snapshot — aliases and combos are part of it, and a
write that forgets leaves the data plane on the old plan.

## Dashboard

`dashboard/src/features/routing` — `CombosPage.tsx` (page at `/combos`) and
`combo-strategy.ts` (the strategy options). Provider-level strategy is a
*separate* control: providers use a round-robin on/off toggle
(`use-routing-strategy`), combos use a strategy list.

## Where to change what

| Change | Start here |
| --- | --- |
| Name normalisation or chain walk | `normalizeAliasKey`, `resolveAlias` in `src/transport/routing/router.ts` |
| Candidate matching or ambiguity | `resolveMatchingCandidates`, `candidateMatches` in the same file |
| Combo expansion | `expandMember` in `resolveMatchingCandidates` |
| Snapshot compile | `src/transport/routing/route-catalog.ts` |
| Console | `src/console/routing/model/operations.ts` |
| Schema | `modelAliases`, `modelCombos` in `src/persistence/schema.ts` |

## See also

- [`architecture.md`](../architecture.md) — the snapshot and the eligibility
  table that runs after this.
- [`protocol-and-translation.md`](../protocol-and-translation.md) — where in the
  request path alias resolution sits.
- `.skills/cartethyia-health-routing` — what happens to a resolved candidate
  that is cooling down.
