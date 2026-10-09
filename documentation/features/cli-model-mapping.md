# CLI model mapping

A CLI coding agent asks for a *slot* (`opus`, `sonnet`, …), not a model id. A
tenant operator opens the API-key editor, turns on **Remote routing** for that
tool, and every inbound call on that key naming the slot is rewritten to an
operator-chosen target before routing plans anything. The mapping is persisted,
scoped to one `(tenant, tool, api_key)`, and consumed only when both the key's
scope and the request's `User-Agent` agree.

Ordinary tenant aliases are unaffected: they remain available to every key. Only
selected keys may consume the CLI mapping table.

## The two gates

Both must pass, in this order, or the request resolves through ordinary aliases:

1. **Scope.** The key carries `routing:cli_mapping`. Scopes are flat grants, not
   a ladder (`src/security/access-control.ts`); the grant is stored explicitly
   and is not implied by `routing:invoke`.
2. **User-Agent.** `detectRemoteCliToolId` matches `claude-cli/` or
   `claude-code/` and returns `claude`. A non-matching client is not a remote
   mapping client, so `allowsCliToolMappings` is false.

The User-Agent gate exists because several tools send the same short slot. A
Claude → non-Claude remap would otherwise rewrite a caller that happened to name
`opus` and steal the real Anthropic alias route. This is routing policy, not a
security boundary: a client that forges the header looks like Claude Code.

The two gates are evaluated together in `ProxyRequestPreparer.prepare`
(`src/transport/request/preparer.ts:106`), which then resolves the target with
`authorization.cliMappingOwnerId ?? authorization.id`. That fallback is how a
share child inherits its parent's mapping bucket: the child authenticates under
its own id but reads the parent's routes.

## Data

| Table | Key | Holds |
| --- | --- | --- |
| `cli_tool_mappings` | unique `(tenant_id, tool_id, api_key_id, slot_key)` | One slot → `target_model`, plus `source_model`, `enabled` |
| `cli_tool_settings` | PK `(tenant_id, tool_id, api_key_id)` | `mappings_enabled`, `mode` (`remote` \| `local`) |

A mapping row routes only when its bucket's settings row enabled it. The CLI
tool page and the API-key edit form both write that one flag, so either place
turns routes on or off. Rows are opaque strings; validation happens at the API
boundary against the tool registry, not in the database.

## Snapshot

`route-catalog.ts` joins both tables into `snapshot.cli_aliases`, keyed by
`${tenantId}:${apiKeyId}` — one bucket per key, so two keys can send the same
slot to different targets without merging.

```ts
const cliAliases = allowCliMappings
  ? keyId
    ? snapshot.cli_aliases?.[`${tenantId}:${keyId}`] ?? snapshot.cli_aliases?.[tenantId]
    : snapshot.cli_aliases?.[tenantId]
  : undefined;
return { ...(aliases ?? {}), ...(cliAliases ?? {}) };
```

CLI aliases are merged *after* ordinary aliases, so within one bucket a CLI row
wins for the names it covers. `cliMappingSourceKeys()` expands a Claude-family
alias into the slot names the tool actually sends.

Name normalization in `normalizeAliasKey` (`src/transport/routing/router.ts:74`)
makes a full model id honor the same mapping as the short slot: a trailing
`[...]` variant is stripped first (`claude-opus-5[1m]` → `claude-opus-5`), then
the family-slot fallback takes `claude-opus-5` → `opus`. Both only fire when the
full name has no mapping of its own.

## Console and dashboard

| Layer | Where |
| --- | --- |
| Domain | `src/console/cli-tools/{contracts,routes,store,service}.ts`, mounted in `src/console/domain-registration.ts` |
| Read routes | `dashboard:read` |
| Mapping writes | `dashboard:write` **and** `auditSink.record` **and** `snapshotInvalidator.invalidate()` |
| Dashboard | `dashboard/src/components/ApiKeyForm.tsx`, `dashboard/src/features/cli-tools/CliToolDetailPage.tsx`, `dashboard/src/hooks/cli-tools.ts` |

The API-key form's **Remote routing** switch grants or revokes
`routing:cli_mapping` through the key-scope PUT immediately — no save needed —
and saves `enabled` through `useSaveToolMappings`. The scope is deliberately
filtered out of the plain checkbox list so the two halves cannot drift.
`CliToolDetailPage` gates the remote UI on
`selectedKey?.scopes?.includes("routing:cli_mapping")`.

`src/console/api-keys/routes.ts` is where a scope grant is written; the same
file assembles every other key patch, so a key whose only change is the label
still goes through it.

Only `claude` has `mappingMode: "remote"` in `TOOL_REGISTRY`. Expand the
`REMOTE_CLI_TOOL_UA` list in `src/security/cli-client-fingerprint.ts` when
another tool gains a mapping table.

## Failure shape

A mapping to a target the key may not use is rejected at `isModelAllowed` before
routing — the caller sees `model_not_found`, never a silently substituted model.
A mapping to a target with no usable account reaches `plan()` and returns
`accounts_unavailable` (503) or `model_not_found` (404), depending on whether the
target is in the catalog at all.

## Where to change what

| Change | Start here |
| --- | --- |
| Recognise another CLI tool | `REMOTE_CLI_TOOL_UA` in `src/security/cli-client-fingerprint.ts`, then `TOOL_REGISTRY` |
| Which names a slot covers | `cliMappingSourceKeys()` in `src/transport/routing/route-catalog.ts` |
| Slot normalisation | `normalizeAliasKey` in `src/transport/routing/router.ts` |
| Persisting a mapping | `src/console/cli-tools/store.ts` |
| Snapshot compile | `route-catalog.ts` (`enabledMappingBuckets`) |
| Which key may consume routes | `allowsCliToolMappings` in `src/security/cli-client-fingerprint.ts` |

## Verify

The differential is the test — the same body, only the `User-Agent` changes:

```
model "opus", UA curl/8.5.0        → 404 model_not_found   (no remap)
model "opus", UA claude-cli/1.0.0  → routed to the mapped target
```

`test/console/cli-tool-lifecycle.test.ts` and `test/console/cli-tool-injectors.test.ts`
pin the console half; `test/unit/api-key-auth.test.ts` pins that
`routing:cli_mapping` never leaks onto a model allowlist.

## See also

- [Routing aliases and combos](routing-aliases-combos.md) — the ordinary alias
  table this resolves through when the gates are closed.
- [`architecture.md`](../reference/architecture.md) — how the snapshot is built and
  invalidated.
- [`console-api.md`](../reference/console-api.md) — the four boundaries every console
  write passes through first.
