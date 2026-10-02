---
name: cartethyia-engineering
description: "Use for any Cartethyia repository development, debugging, refactor, provider, routing, schema, dashboard/API contract, or removal task. Pick the reference, act, finish with evidence."
---

# Cartethyia Engineering

Entry point for repo work. Pick the row, read that reference, act.

| Work | Read first |
|---|---|
| Orientation, add provider, schema change, console-log field, feature removal, dedup | `references/development.md` |
| Dispatch failure, routing, wire/encoding bug, payload trace | `references/debugging.md` |
| Bug-fix loop, proving a change, proving deadness | `references/verification.md` |
| Health classification, cooldown policy, tool-history repair order | `references/health-and-pool.md` |
| Dashboard chrome, social meta, share page, browser verification | `references/dashboard.md` |
| Add / remove / BYOK / OAuth / live-verify provider, catalog gap | `references/provider-lifecycle.md` |
| Schema migration, telemetry column, rename, model metadata, availability | `references/schema-telemetry-catalog.md` |
| Repo invariants: aliases, drift, wire bytes, naming, dead code, docs sync | `references/guards.md` |

Load only the reference the task needs. It holds the procedure, pitfalls, and commands.

## Fast path

1. **Find the owner.** One behavior, one canonical owner. Editing the nearest matching file is how symptoms get suppressed instead of fixed.
2. **Ask the index.** `.codegraph/codegraph.db` sits at the repo root. `codegraph_explore` returns verbatim source + call paths in one call, including dynamic-dispatch hops grep misses. `Read` for a known range, `Grep` for a known literal. Re-verify hits when the file changed after the index sync.
3. **Act immediately.** Read, search, reproduce, edit, or run a command. Never spend a turn on planning alone.

## Fix, don't hide

1. **Cause?** State it as a mechanism ("X reads Y, which is undefined when Z"). Can't state it → not ready to fix.
2. **Fix or hiding?** Removing a throw, loosening validation, widening a type, adding a fallback, raising a timeout, catching an exception = hiding until proven otherwise.
3. **Other arm?** A check that looks dead may be load-bearing for a partially-implemented dependency. Check before deleting.
4. **Intended design?** Capability degradation, operator-configured fallback, documented compatibility boundary = legitimate. Name it in a comment; never masquerade it as a bug fix.

A workaround is fine only as a named temporary boundary with a removal condition.

## Cutover

Rename / move / new feature / contract change:

1. Search every runtime, script, dashboard, docs, config caller.
2. Change the canonical definition, migrate all callers, delete the obsolete symbol.
3. Search the old name again; only intentional history remains.

No alias or forwarding shim to keep old imports compiling. Deletion needs proof, not grep — see `references/verification.md`.

## Verification

```bash
bun run typecheck                # always
bun run dashboard:typecheck      # when dashboard/ touched
bun run build                    # when contracts/entry change (dashboard → AOT → binary)
```

The repository does not currently carry a test suite, so typecheck is the gate.
Typecheck never proves a behavior change: exercise the affected path at its real
boundary — a live request against the running gateway, the browser, or a
`.tmp-<topic>.ts` calling the real function — and report what you observed.
State the limitation plainly when a surface is unavailable.

## Boundaries

- `src/` = production backend. `dashboard/` stays browser-safe: no Elysia, DB, filesystem, secret, or Node-only imports.
- `scripts/` flat, `ops-*` / `build-*` / `ci-*` prefixes. No `index.ts` barrels; role filenames.
- Never hand-edit generated output; change its source/generator.
- Typecheck/build must not need Buf, network, or external generators.
- Preserve security boundaries and intentional provider wire bytes.
- Never commit, push, deploy, alter production data, or discard unrelated working-tree changes unless explicitly asked.

## Completion

Report done only when the goal checks out against current evidence: acceptance criteria, callers, exports, docs/config, known failures. Otherwise continue with the next useful action, or report the exact blocker and the evidence needed.
