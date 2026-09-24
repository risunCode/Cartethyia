---
name: cartethyia-engineering
description: "Use for any Cartethyia repository development, debugging, refactor, provider, routing, schema, dashboard/API contract, live verification, feature removal, or skill-maintenance task. Start with the relevant procedure and finish with evidence-backed verification."
---

# Cartethyia Engineering

This is the single entry point for repository work. Use the smallest relevant
section below, then load the detailed reference named by that section. The
references preserve the full development and debugging procedures without
creating competing skills.

## Choose the procedure

| Work | Read first |
|---|---|
| Repository orientation, provider, version, schema, console-log, gates, removal, clean cutover, or consolidating duplicated logic | `references/development.md` |
| Dispatch failure, routing, proxy proof, tool calling, duplicates, live request, or local DB reset | `references/debugging.md` |
| Repeated cleanup mistake, new drift class, or improving this skill | `references/self-improvement.md` |
| Any K1–K11 contract, architecture, provider, wire, schema, naming, dead-key, docs, deadness, or skill guard | `references/guards.md` |

This is intentionally one discoverable Cartethyia skill. Use progressive
disclosure: load only the reference needed for the current task.

Read the detailed reference before editing the owned subsystem. It contains the
canonical authority map, procedures, pitfalls, commands, and verification
checklists. Do not copy those details into this entry point or into product
README files.

## Mandatory operating loop

1. Set a concrete goal and acceptance criteria.
2. Set scope, protected surfaces, compatibility/data-safety boundaries, and
   required checks.
3. Read the target implementation, direct callers, relevant tests, and nearest
   canonical layer doc (one `*.md` per top-level `src/` folder, named for the
   layer).
4. Identify the authority file and the actual failure/contract boundary.
5. Make one evidence-producing action immediately: read, search, reproduce,
   edit, or run a focused command. Do not spend a turn on planning alone.
6. Implement the root fix in the canonical owner and migrate every caller.
7. Update active docs/configuration in the same change.
8. Verify the changed behavior at its real boundary, then run broader gates
   appropriate to the impact.
9. Audit acceptance criteria, stale names, aliases, dead code, and unverified
   areas before reporting completion.

## Deep-reasoning and loop control

This rule applies to DeepSeek and every other reasoning model. High reasoning
is useful for ambiguous architecture, security, data safety, difficult
reproduction, and research; it is wasteful for obvious edits.

- Take the first relevant tool action as soon as the target is known.
- After each tool result, choose the next evidence-producing action.
- Never restart the same thought cycle without new evidence.
- After two failed approaches, inspect the failure and change the approach.
- After three actions with no repository progress, report the concrete blocker
  instead of continuing speculative thought.
- A turn is not progress unless it reads/searches, edits, runs a command,
  fetches authoritative docs, asks a necessary question, or reports a blocker
  with evidence.

## External research

Use local source first. For APIs, versions, frameworks, protocols, or other
current facts: search authoritative sources, then fetch/read the actual result
before deciding. Search snippets are not evidence. Prefer primary docs,
specifications, source repositories, and papers. Cite fetched sources when the
final decision depends on them. Use the goal/task feature for multi-path
research and define confirmed, approximate, blocked, and unknown outcomes.

## Clean implementation boundary

Solve root causes. Do not suppress errors, loosen validation, pin fixtures,
special-case one input, swallow failures, or add a path-specific fallback to
make a symptom disappear. Temporary tests/scripts may exercise the real path
only; they must not bypass the failing layer or become production workarounds.

For a rename, move, new feature, or contract cutover:

1. Search every runtime, test, script, dashboard, docs, and configuration
   caller.
2. Change the canonical definition.
3. Migrate all callers.
4. Delete the obsolete export/path/implementation.
5. Search the old name again and prove only intentional history remains.

Never add an alias or forwarding shim merely to keep old imports compiling. A
compatibility boundary is allowed only when explicitly required, documented,
and given a removal condition.

Deletion claims need proof, not a grep: rule out interface dispatch, callback
fields, re-exports, dynamic imports, test doubles, use inside the declaring
file, and dashboard copies before removing a symbol — and for a guard or probe,
check what the other arm does before calling it noise. See K11 in
`references/guards.md`.

## Verification baseline

From the repository root, use the narrowest useful check first:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard/API contract changes also require:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

Report DB-gated skips separately from failures. Typecheck alone is never proof
of a behavior change. UI work should be verified against the real browser or
HTTP surface when the browser runtime is available; state the limitation when
it is not.

## Repository-specific boundaries

- `src/` is production backend; tests belong under `test/`.
- `dashboard/` must remain browser-safe and must not import backend-only Elysia,
  database, filesystem, secret, or Node runtime dependencies.
- `scripts/` is flat with `ops-*`, `build-*`, and `ci-*` role prefixes.
- Do not add `index.ts` barrels. Use concrete modules and role filenames.
- Do not edit generated output manually; edit its source/generator.
- Typecheck/build must not require Buf, network access, or external generators.
- Preserve security boundaries and intentional provider wire bytes.
- Never commit, push, deploy, alter production data, or discard unrelated
  working-tree changes unless explicitly requested.

## Completion contract

Do not report done until the goal is checked against current evidence: all
acceptance criteria, callers, exports, tests, docs/configuration, generated
artifacts, and known failures. If incomplete, continue with the next useful
tool action or report the exact blocker and evidence needed to unblock it.
