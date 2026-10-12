# Cartethyia — Agent Guide

Use this file as the general guide for work in this repository. Keep the task
moving, adapt to the request, and use focused subsystem guidance when it adds
useful detail. Do not treat every suggestion here as a reason to block progress.

## Requirements

At the start of a task, briefly understand:

- **Requirement:** the requested behavior or outcome.
- **Acceptance criteria:** what observable result would satisfy the request.
- **Constraints:** what must remain unchanged, and any explicit limits.

Use the user's wording where possible. A short internal summary is enough; do
not turn a small task into a specification exercise.

If details are missing, prefer a reasonable, low-risk assumption and continue.
Ask the user when different plausible choices would materially change behavior,
scope, data handling, compatibility, or user experience. When helpful, offer a
small set of clear options. Mention assumptions that affect the result.

## Working principles

- Optimize for useful progress and a complete result, not process for its own
  sake.
- Inspect the relevant code and its conventions before editing. For a small,
  well-scoped task, keep exploration small too.
- Make the smallest complete change that meets the request. Avoid unrelated
  cleanup, speculative abstractions, and broad rewrites unless requested.
- Follow existing patterns when they fit. If they conflict or appear stale, use
  judgment and explain a meaningful deviation rather than copying a bad pattern.
- For bugs, find the likely cause and verify it when practical. If reproduction
  is blocked or not worthwhile, say what remains unverified.
- Keep code, tests, documentation, and configuration in sync when the change
  affects them. Do not update unrelated docs just to satisfy a checklist.
- Do not spend a turn only restating a plan. Make a useful first move: inspect,
  search, reproduce, edit, or verify.
- Work directly by default. Use a helper agent only when work is genuinely
  independent or needs substantial separate context.

## Clarifying questions and flexibility

- Do not ask about details with an obvious, reversible default.
- Do ask before a high-impact or hard-to-reverse decision, a destructive action,
  or an unresolved product choice with multiple reasonable outcomes.
- If progress can safely continue while an uncertainty is isolated, continue
  the independent work and call out the open choice.
- The user may redirect scope, tools, or verification depth; adapt rather than
  insisting on a fixed workflow.
- Distinguish requirements from suggestions. Use the lightest process that
  adequately manages the change's risk.

## Environment and tools

Cartethyia's main stack:

- **Runtime and package manager:** Bun 1.4.0 or newer.
- **Backend:** TypeScript and Elysia under `src/`.
- **Dashboard:** React and Vite under `dashboard/`.
- **Persistence:** embedded SQLite in Lite mode; external PostgreSQL in Full
  mode. Redis is optional and is used when coordination needs to be shared.
- **Development services:** prefer available local PostgreSQL and Redis (or the
  in-process coordination mode) for local work. Docker is an option when a
  needed service is unavailable, not a default prerequisite.
- **Browser checks:** use `agent-browser` for visual, layout, and interactive
  dashboard behavior. The dashboard skill has more specific verification
  guidance; follow it for dashboard tasks.

Use the shell and path syntax that match the active environment. In a Windows
workspace, PowerShell is appropriate; do not assume Bash-only utilities or
Unix-style paths when an equivalent native command is available.

Useful root commands:

```text
bun install
bun setup
bun setup --non-interactive
bun run dev
bun run dev:backend
bun run typecheck
bun run dashboard:typecheck
bun run build
bun run test
bun run test:backend
bun run dashboard:test
```

Use `bun setup` for local environment setup. It configures the environment,
encryption key, database mode, and port; it does not install PostgreSQL or start
the application. See `documentation/getting-started.md` for setup details and
`package.json` for the current command list.

`CARTETHYIA_DB_MODE` is required and has no default. Do not silently choose a
mode: Lite and Full use different database backends and migration sets. Use the
isolated `.env.test` configuration for tests, never a development or production
database.

## Repository map and boundaries

- `src/` — production backend, public gateway, console API, persistence,
  providers, protocol translation, routing, and telemetry.
- `dashboard/src/` — browser application. It talks to `/console/api`; it must
  remain browser-safe and must not import database drivers, Elysia, filesystem
  modules, secrets, or Node-only runtime dependencies.
- `scripts/` — CLI, development, build, generation, operations, and test
  utilities. Check the existing subdirectory before adding a script.
- `migrations/` — database baselines and forward migrations.
- `test/` and `dashboard/test/` — backend and dashboard tests.
- `documentation/` — getting started, reference indexes, and feature guides.
- `.skills/` — focused, repository-specific procedures and domain guidance.

Keep one canonical owner for provider metadata, environment configuration,
contracts, routing policy, and persisted data. When changing a shared contract,
inspect and update its relevant producers, consumers, validation, and dashboard
mirror.

Treat network responses, environment values, database rows, request bodies, and
user-supplied values as untrusted. Preserve security boundaries and intentional
provider-specific headers, user-agent behavior, and wire bytes.

Do not hand-edit generated output. Find and change its source or generator, then
regenerate when appropriate. Keep TypeScript strict; do not weaken compiler
settings or use `any` or suppressions merely to silence an error.

## Finding the right guidance

Read the closest skill when the task touches a specialized area; do not read
every skill for every task. The committed skill source lives under `.skills/`.

| Task area | Starting point |
|---|---|
| Repository conventions, verification, or a cross-cutting change | `.skills/cartethyia-engineering/SKILL.md` |
| Reproducing a failing request, payloads, or provider wire behavior | `.skills/cartethyia-trace-replay/SKILL.md` |
| Schema, migrations, usage, or telemetry | `.skills/cartethyia-schema-telemetry/SKILL.md` |
| Adding or authenticating a provider, catalog, or capabilities | `.skills/cartethyia-provider-catalog/SKILL.md` |
| Removing a bundled provider | `.skills/cartethyia-provider-removal/SKILL.md` |
| Account health, cooldowns, retries, leases, or routing | `.skills/cartethyia-health-routing/SKILL.md` |
| Console API domain or contract | `.skills/cartethyia-console-api/SKILL.md` |
| Dashboard, React, layout, or browser behavior | `.skills/cartethyia-dashboard/SKILL.md` |

Use the task-relevant skill's procedure and references where they help. Skills
may define stricter domain-specific requirements than this general guide, such
as the dashboard's browser verification procedure.

## Typical workflow

1. Understand the requirement, acceptance criteria, and constraints.
2. Locate the owning layer and inspect the relevant implementation, callers, and
   tests. Use CodeGraph or other code intelligence if available and useful;
   targeted search and file reads are fine too.
3. Check the closest skill and documentation for domain-specific pitfalls.
4. Make a focused change at the canonical owner and update affected callers.
5. Run a proportional verification check and, for behavior changes, verify the
   changed behavior at a useful boundary when practical.
6. Report the result, verification, and any meaningful limitation.

This is a guide, not a mandatory ceremony. Skip steps that add no value to a
trivial task; spend more time when the change has a wider blast radius.

## Testing and verification

- Avoid over-testing. Start with the smallest check that can provide useful
  confidence; do not run the full suite by default.
- Run the relevant typecheck, focused test, build, or reproduction based on the
  files and behavior changed. Use the scripts in `package.json`.
- Typechecking confirms types, not runtime behavior. For a behavioral change,
  run a focused test or exercise the relevant boundary when practical.
- For UI claims about layout, styles, or interactions, use `agent-browser` when
  available and report browser verification separately from static checks.
- If the ideal check is unavailable or disproportionate, use a reasonable
  alternative and state the limitation. Do not imply an unrun check passed.
- Schema changes should be checked against an isolated database when practical.
  Do not use a developer's normal database or production data as a test fixture.
- Report the commands actually run and their outcomes. Keep the report concise
  for a small change; include more detail when a check failed or was skipped.

## Documentation

Use `documentation/getting-started.md` for installation and local setup.
`documentation/reference/` explains system layers; `documentation/features/`
describes individual features. Prefer updating the existing owner page instead
of duplicating long explanations in `AGENTS.md`.

Update user-facing documentation when behavior, configuration, or setup changes
would otherwise make it misleading. Avoid documenting transient implementation
details that belong in code or tests.

## Git, data, and credentials

- Do not commit, push, deploy, or alter production data unless the user asks.
- Preserve unrelated user changes. Do not use destructive Git commands such as
  `reset --hard`, `checkout --`, or `clean`.
- A small cleanup directly required by the task is fine; avoid unrelated
  refactors or cleanup.
- Do not persist credentials in source, environment files, scratch files,
  commits, logs, reports, or telemetry. Do not expose credentials in tool output
  or send them to third parties.
- Prefer reversible steps for database and environment operations. Confirm
  which environment is targeted before any operation that may alter real data.

## Completion

When the work is done, briefly state:

- what changed and how it addresses the request;
- which relevant checks or reproductions ran and their outcomes;
- any important assumptions, skipped verification, or remaining blockers.

For straightforward work, a short summary is enough. Be clear about evidence:
do not claim behavior is fixed or verified beyond what was actually checked.
