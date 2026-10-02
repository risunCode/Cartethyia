# Contributing to Cartethyia

This page covers contribution workflow, code conventions, and pull requests.

For requirements, PostgreSQL/Redis setup, local development, Docker, commands,
migrations, and verification, use the single source of truth:

- [Getting started](documentation/getting-started.md)

## Before changing code

1. Read the relevant part of `README.md` and
   `documentation/getting-started.md` when the change affects user-facing behavior
   or runtime setup.
2. State the goal, acceptance criteria, and hard constraints.
3. Use CodeGraph first for blast search when available. Otherwise use the available
   search tools and inspect the same callers, contracts, and boundaries.
4. Reproduce the issue, or clearly mark it unverified before editing.
5. Find the canonical owner and read every affected caller before changing it.

## Code conventions

- `src/` is production backend code; `dashboard/src/` is browser code only.
- Dashboard code must not import Elysia, database drivers, filesystem modules,
  secrets, or Node-only runtime dependencies.
- Keep one source of truth for provider metadata, persisted contracts, environment
  names, routing policy, and dashboard mirrors.
- Use concrete role filenames such as `contracts.ts`, `routes.ts`, `store.ts`,
  `service.ts`, and `errors.ts`. Avoid `index.ts` barrels.
- Keep scripts organized by purpose under `scripts/commands`, `scripts/build`,
  `scripts/generate`, `scripts/dev`, and `scripts/internal`.
- Use strict TypeScript: no `any`, suppressions, needless assertions, or weakened
  compiler settings. Narrow `unknown` at boundaries and use `import type` for types.
- Comments explain policy, security, protocol behavior, or non-obvious tradeoffs;
  they should not narrate the next line.
- Treat network responses, environment variables, database rows, request bodies,
  and user values as untrusted. Fail closed at security boundaries.
- Never expose credentials, tokens, keys, or sensitive payloads in logs or reports.

## Implementation rules

- Fix the cause, not the symptom. Do not disguise a workaround as a bug fix.
- No overengineering unless the task explicitly asks for it.
- Every issue must be reproduced or explicitly reported as unverified.
- Every feature or fix must update the proper logic and handlers across the affected
  path, not only the first visible caller.
- For renames, removals, and contract changes: migrate every caller, remove the old
  path, and search the old name again. Do not leave aliases or compatibility shims.
- Prove deadness before deleting a symbol: check imports, re-exports, dynamic
  imports, callbacks, scripts, dashboard usage, and docs.
- Do not hand-edit generated output; update its source or generator.
- Update active docs and configuration when the change makes them inaccurate.

## Verification

The repository does not currently carry an active test suite. Use the gates in
`documentation/getting-started.md`, then exercise the real boundary for behavior
changes: a gateway request, browser surface, provider flow, or isolated database
migration.

A typecheck is not runtime proof. Report the exact command, result, reproduction,
real-boundary evidence, skipped checks, and remaining blockers.

## Pull requests

- Branch from `main` and keep the change focused.
- Fill in `.github/pull_request_template.md` with the change, gates, and docs status.
- Keep security boundaries fail-closed.
- Preserve intentional provider wire bytes, headers, and user-agent behavior.
- Do not commit, push, deploy, alter production data, or discard unrelated working
  tree changes unless explicitly asked.
