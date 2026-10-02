# Cartethyia Agent Guide

The goal is to leave the repository trustworthy for the next reader. Keep this
file concise; detailed subsystem guidance lives in
`.skills/cartethyia-engineering/`.

## Core rule

Every reported issue must be **reproduced or explicitly flagged as unverified**.
Every feature and bug fix must be implemented with the proper logic and handlers
across the affected code path. Do not ship a workaround disguised as a fix.

No overengineering unless the task explicitly asks for it. Prefer the smallest
complete change that fixes the owning layer, migrates its callers, and proves the
acceptance criteria.

## Start here

1. State the goal, acceptance criteria, and hard constraints in one sentence.
2. Use CodeGraph first for blast search: owner, callers, implementations, and
   dynamic paths. Use `codegraph_explore` when available.
3. If CodeGraph is unavailable or stale, use the available search tools (`Read`,
   `Grep`, `Glob`, or a targeted command) and obtain the same context manually.
4. Read the relevant skill reference before subsystem work.
5. Inspect the target, callers, contracts, config, and docs before editing.
6. When a browser/CDP runtime is available, use it headlessly for dashboard/UI
   verification; do not replace measurable browser evidence with markup guesses.

Do not spend a turn only restating a plan. The first useful action should read,
search, reproduce, edit, or verify something.

## Implementation loop

1. Reproduce the issue or record the exact blocker and mark it unverified.
2. Identify the canonical owner and state the causal mechanism.
3. Check blast radius before changing shared status, mappings, contracts, schemas,
   routing, retries, cooldowns, security, or wire formats.
4. Fix the root cause in the owner and update every affected caller/handler.
5. Remove obsolete paths; do not add aliases, shims, special cases, or silent
   fallbacks to preserve broken behavior.
6. Update active docs, config, and generated sources through their generators.
7. Re-run the same reproduction, then run the narrowest useful gates.
8. Report evidence, failures, skipped checks, and unavailable surfaces honestly.

A temporary script is acceptable only when it exercises the real production path,
proves the behavior, and is deleted afterward. A workaround is acceptable only
when explicitly requested or when it is a named temporary boundary with a clear
removal condition.

## Repository boundaries

- `src/` is the production backend; `dashboard/src/` is browser code.
- Dashboard code must not import Elysia, database drivers, filesystem modules,
  secrets, or Node-only runtime dependencies.
- Treat network responses, environment variables, database rows, request bodies,
  and user values as untrusted. Validate at boundaries and fail closed.
- Preserve intentional provider wire bytes, headers, and user-agent behavior.
- Keep one source of truth for provider metadata, persisted contracts, environment
  names, routing policy, and dashboard mirrors.
- Development is local-first: use an available local PostgreSQL (including Laragon
  on Windows) and local Redis/in-memory mode before considering Docker. Docker is
  an optional deployment/test fallback, never a default development prerequisite.
- Keep scripts flat with `ops-`, `build-`, or `ci-` prefixes. Avoid barrel files;
  use role names such as `contracts.ts`, `routes.ts`, `store.ts`, `service.ts`,
  and `errors.ts`.
- Do not hand-edit generated output. Change its source or generator.
- Use strict TypeScript conventions already configured by the repository: no `any`,
  suppressions, needless assertions, or weakened compiler settings.

## Clean cutover

For a rename, move, replacement, feature removal, or contract change:

1. Search runtime code, scripts, dashboard, config, and docs.
2. Change the canonical definition and migrate all callers.
3. Delete the obsolete symbol/path; do not leave a compatibility alias.
4. Search the old name again and typecheck the affected surface.
5. Prove deadness before deleting code; declaration-only search is not proof.

## Verification gates

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when entry points or build contracts change
```

The repository does not currently carry an active test suite. Typecheck is not
behavioral proof. Exercise the real boundary: a live gateway request, headless
browser/CDP surface when available, database migration in an isolated environment,
or a temporary script calling production code. If a browser/CDP runtime is
available, UI claims require that automation evidence; if unavailable, say exactly why.

## Safety and git

Never use destructive git commands such as `reset --hard`, `checkout --`, or
`clean`. Do not commit, push, deploy, touch production data, delete user data, or
discard unrelated working-tree changes unless explicitly asked. Never expose
credentials, tokens, keys, or sensitive payloads in output. Verify the environment
before database/production operations and prefer reversible, transactional steps.

## Completion report

Report:

- what changed and where;
- the reproduction or why it remains unverified;
- commands/gates run and their result;
- real-boundary evidence;
- failures, skips, blockers, and next action.

Do not claim an issue is fixed when it was only masked, or claim tests passed when
no tests were run.
