# Cartethyia Agent Guide

The goal is to leave the repository trustworthy for the next reader. Keep this
file concise; detailed subsystem guidance lives in `.skills/`.

## Core rule

Every reported issue must be **reproduced or explicitly flagged as unverified**.
Every feature and bug fix must be implemented with the proper logic and handlers
across the affected code path. Do not ship a workaround disguised as a fix.

No overengineering unless the task explicitly asks for it. Prefer the smallest
complete change that fixes the owning layer, migrates its callers, and proves the
acceptance criteria.


## Exact labels

Copy a user-facing name character for character. Do not abbreviate, expand,
restyle, or "correct" it.

The required Client identity label is the backtick-wrapped string `[CC]`.
`CC` is wrong. Wrapping those letters in square brackets is also wrong. The
previous failure was substituting one of those forms and then treating a
screenshot of the wrong form as acceptable. When the user corrects a label,
change that label before investigating the renderer.
## Pick the skill first

Most tasks belong to one skill in `.skills/`. Read its `SKILL.md` before
starting — it holds the procedure, the pitfalls, and the owner of the layer.

| Work | Skill |
|---|---|
| A failing request to attribute to a field; payload/wire bytes; remote debugging | `cartethyia-trace-replay` |
| Schema change, migration, new usage/telemetry field | `cartethyia-schema-telemetry` |
| Add/remove/authenticate a provider; catalog, `/v1/models`, capabilities | `cartethyia-provider-catalog` |
| Remove a bundled provider and its leftover global row | `cartethyia-provider-removal` |
| Account health, cooldown class, pool selection, retries, leases | `cartethyia-health-routing` |
| Add/change a `src/console/` domain; contract→store→dashboard mirror | `cartethyia-console-api` |
| `dashboard/` React, layout, social metadata, browser verification | `cartethyia-dashboard` |
| Orientation, invariants/deadness, house style, gates | `cartethyia-engineering` |

Do not add a competing file when a skill already owns the topic. Extend the
closest owner instead — one folder, one skill.

## Working agreement

- Keep related implementation, documentation, and test changes together as one
  coherent change set. Complete the relevant work, run the appropriate gates,
  and create one reviewable commit for the finished change.
- Do not push automatically. Push only when the user explicitly asks for it.
- Use `bun install` for dependency installation. Use the unified `bun setup`
  command for environment creation, encryption-key generation, Lite/Full
  selection, database checks, and optional Redis checks. Use
  `bun setup --non-interactive` for automation.
- `.env.example` defaults to `CARTETHYIA_DB_MODE=lite`; Docker Compose defaults
  to Full with external PostgreSQL and bundled Redis configuration. Keep these
  defaults intentional and document changes in `documentation/getting-started.md`.
- Lite uses embedded SQLite and in-process coordination when `REDIS_URL` is
  absent. Full uses external PostgreSQL; Redis remains optional unless shared
  coordination is required. Do not reintroduce `REDIS_MODE` or
  `single_instance_local`.
- Development is local-first: use an available local PostgreSQL (including Laragon
  on Windows) and local Redis/in-memory mode before considering Docker. Docker is
  an optional deployment/test fallback, never a default development prerequisite.

## Start here

1. State the goal, acceptance criteria, and hard constraints in one sentence.
2. Use CodeGraph first for blast search: owner, callers, implementations, and
   dynamic paths. Use `codegraph_explore` when available.
3. If CodeGraph is unavailable or stale, use the available search tools (`Read`,
   `Grep`, `Glob`, or a targeted command) and obtain the same context manually.
4. Read the skill for the subsystem, then the target's callers, contracts,
   config, and docs.
5. Verify dashboard/UI in a real browser through the browser agent (Puppeteer
   under the hood). Prefer that automation over a hand-rolled CDP client: it is
   far easier to control. Reach for raw CDP only when the browser agent cannot
   express the check. Measure real DOM geometry; never substitute markup guesses.

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
  secrets, or Node-only runtime dependencies. It calls `/console/api`.
- Treat network responses, environment variables, database rows, request bodies,
  and user values as untrusted. Validate at boundaries and fail closed.
- Preserve intentional provider wire bytes, headers, and user-agent behavior.
- Keep one source of truth for provider metadata, persisted contracts, environment names, routing policy, and dashboard mirrors.
- Provider, health, and streaming claims in docs and skills must match the owning code. A dashboard section is a mirror, not a second inventory.
- `scripts/` is grouped by purpose (`commands/`, `build/`, `dev/`, `generate/`,
  `internal/`); `scripts/ci-run-tests.ts` and `scripts/install-lite.sh` sit at
  its root. Avoid barrel files; use role names such as `contracts.ts`,
  `routes.ts`, `store.ts`, `service.ts`, and `errors.ts`.
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
bun run typecheck                # always
bun run dashboard:typecheck      # when dashboard/ changes
bun run build                    # when entry points or build contracts change
bun run test:backend             # or bun run test / dashboard:test / test:watch
```

The repository carries an active test suite (`test/`, `dashboard/test/`, run via
`scripts/ci-run-tests.ts` against the isolated `.env.test` database — never the
dev database). Typecheck is not behavioral proof. Exercise the real boundary: a
live gateway request, headless browser surface when available, database
migration in an isolated environment, or a temporary script calling production
code. UI claims require browser-agent (Puppeteer) automation evidence; if no
browser runtime is available, say exactly why. Do not write a raw CDP client
when the browser agent can express the check.

Prove a new test actually locks the fix: revert the change, see it fail, restore
it, see it pass. A test that passes both ways proves nothing.

## Safety and git

Never use destructive git commands such as `reset --hard`, `checkout --`, or
`clean`. Do not commit, push, deploy, touch production data, delete user data, or
discard unrelated working-tree changes unless explicitly asked. Never expose
credentials, tokens, keys, or sensitive payloads in output. Credentials come from
the environment — never from a message, never echoed into output. Verify the
environment before database/production operations and prefer reversible,
transactional steps.

## Completion report

Report:

- what changed and where;
- the reproduction or why it remains unverified;
- commands/gates run and their result;
- real-boundary evidence;
- failures, skips, blockers, and next action.

Do not claim an issue is fixed when it was only masked, or claim tests passed when
no tests were run.
