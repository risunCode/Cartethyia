---
name: cartethyia-engineering
description: "Entry point for Cartethyia repo work and the owner of cross-cutting rules: pick the right skill, find the canonical owner, prove changes, keep repo invariants, and match the house style."
---

# Cartethyia engineering

Entry point for repo work. Most tasks belong to a focused skill — pick it first.

| Work | Use |
|---|---|
| A failing request to attribute to a field; payload/wire bytes; remote debugging | `cartethyia-trace-replay` |
| Schema change, migration, new usage/telemetry field | `cartethyia-schema-telemetry` |
| Add/remove/authenticate a provider; catalog, `/v1/models`, capabilities | `cartethyia-provider-catalog` |
| Remove a bundled provider and its leftover global row | `cartethyia-provider-removal` |
| Account health, cooldown class, pool selection, retries, leases | `cartethyia-health-routing` |
| `dashboard/` React, layout, social meta, toasts, browser-agent verification | `cartethyia-dashboard` |
| Repo invariants, deadness, legacy-era checks | `references/guards.md` |
| How to write the change: shape, names, types, errors | `references/taste.md` |
| Bug-fix loop, proof, gates | `references/verification.md` |
| Orientation, add a feature, first install, console boot | `references/development.md` |

## Fast path

1. **Find the owner.** One behavior, one canonical owner. Editing the nearest
   matching file is how symptoms get suppressed instead of fixed.
2. **Ask the index.** `.codegraph/codegraph.db` sits at the repo root.
   `codegraph_explore` returns verbatim source plus call paths in one call,
   including dynamic-dispatch hops grep misses. `Read` for a known range,
   `Grep` for a known literal. Re-verify hits when a file changed after the
   index sync.
3. **Act immediately.** Read, search, reproduce, edit, or run a command. Never
   spend a turn on planning alone.

## Fix, don't hide

1. **Cause?** State it as a mechanism ("X reads Y, which is undefined when Z").
   Cannot state it → not ready to fix.
2. **Fix or hiding?** Removing a throw, loosening validation, widening a type,
   adding a fallback, raising a timeout, catching an exception = hiding until
   proven otherwise.
3. **Other arm?** A check that looks dead may be load-bearing for a
   partially-implemented dependency. Check before deleting.
4. **Intended design?** Capability degradation, operator-configured fallback, or
   a documented compatibility boundary is legitimate — name it in a comment and
   never masquerade it as a bug fix.

A workaround is fine only as a named temporary boundary with a removal
condition.

## Cutover

Rename, move, new feature, or contract change:

1. Search every runtime, script, dashboard, docs, and config caller.
2. Change the canonical definition, migrate all callers, delete the obsolete
   symbol.
3. Search the old name again; only intentional history remains.

No alias or forwarding shim to keep old imports compiling. Deletion needs
proof, not grep — see `references/verification.md`.

## Boundaries

- `src/` is the production backend. `dashboard/` stays browser-safe: no Elysia,
  DB, filesystem, secret, or Node-only imports.
- `scripts/` is grouped by purpose (`commands/`, `build/`, `dev/`, `generate/`,
  `internal/`). Names, comments, and error types follow `references/taste.md`.
- Never hand-edit generated output; change its source or generator.
- Typecheck and build must not need Buf, network, or external generators.
- Preserve security boundaries and intentional provider wire bytes.
- Never commit, push, deploy, alter production data, or discard unrelated
  working-tree changes unless explicitly asked.

## Completing a change

```bash
bun run typecheck                # always
bun run dashboard:typecheck      # when dashboard/ touched
bun run build                    # when a build entry or contract changes
bun run test                     # or scoped: test:backend, dashboard:test
```

Backend suites live in `test/`, dashboard suites in `dashboard/test/`, run via
`scripts/ci-run-tests.ts` against the isolated `.env.test` database — never the
dev database. Typecheck never proves a behavior change: exercise the affected
path at its real boundary and report what you observed. State the limitation
plainly when a surface is unavailable.

Report done only when the goal checks out against current evidence: acceptance
criteria, callers, exports, docs/config, known failures. Otherwise continue with
the next useful action, or report the exact blocker and the evidence needed.

## Skills are discovered from `.claude/skills/`

`.skills/` is the committed source; `.claude/` is gitignored, so a fresh clone
has no wiring. Point the discovery dir at the committed one (junction, because
`ln -s` materializes as a copy on Windows):

```bash
mkdir -p .claude/skills
cmd //c 'mklink /J .claude\skills\cartethyia-engineering .skills\cartethyia-engineering'
```

Repeat per skill folder.
