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
- `CARTETHYIA_DB_MODE` is **required and has no default** — the gateway throws at
  boot when it is absent, because the two modes are different databases with
  separate migration sets and a silent guess would pick which one an install's
  data is read against. `.env.example` ships `lite` (the zero-dependency first
  run); Docker Compose supplies `full`. Keep these choices intentional and
  document changes in `documentation/getting-started.md`.
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
5. Verify dashboard/UI in a real browser. The `agent-browser` CLI is
   **mandatory** for dashboard development — not a fallback, not an option.
   Drive it yourself with `Bash`. See "Browser verification" below.

Do not spend a turn only restating a plan. The first useful action should read,
search, reproduce, edit, or verify something.

## Browser verification

`agent-browser` is the tool. Nothing else is.

- **Drive it yourself.** Do not delegate browser work to a subagent, and do not
  write a Bun/Node harness around it. The CLI is complete
  (`open`, `eval`, `click`, `fill`, `press`, `wait`, `set viewport`,
  `set media`, `storage local set`, `network route`, `screenshot`, `errors`,
  `console`, `diff snapshot`). If a check needs several commands, run them.
- **A browser claim without a browser is not a claim.** "The DOM looks right
  from the source" is not verification. If you did not run `agent-browser`, say
  the surface is unverified — do not soften it with a passing typecheck.
- **Measure, do not guess.** Read `getBoundingClientRect()` and
  `getComputedStyle()` through `agent-browser eval`. A rect in your evidence is
  evidence; a class name in the source is a guess.
- **If the CLI cannot express the check**, say so plainly and name what you
  tried. Do not build a parallel toolchain to route around one awkward command.
- One-off state (`localStorage`, stubbed routes) is a CLI flag away
  (`storage local set`, `network route`). A scratch server for the built `dist`
  is acceptable; a scratch *harness* is not.

## Efficient work

These are the loops that actually cost time on this repo. They are rules
because each one was paid for.

- **Do not delegate what you can do directly.** A subagent costs a spawn, a
  transcript, and a report you must re-verify. Reserve it for genuinely
  parallel or genuinely independent work.
- **Read the failing assertion before changing code.** Most "regressions" found
  by a test are the test being wrong: a stale expected width, a default that is
  legitimately `0`, a fixture that was never wired. Confirm the expectation
  against the source of truth before editing production code.
- **When three consecutive runs fail for different reasons, stop.** You are
  probably measuring the wrong thing or trusting the wrong number. Re-read the
  check and the code it asserts against.
- **One change, one verification.** Re-run the narrowest gate that can fail on
  the change. Do not re-run a passing suite looking for a different opinion.
- **No exploratory scratch files.** A debug script exists to answer one
  question. Answer it, then delete it in the same turn. If two scratch files
  exist for one investigation, one is already abandoned.
- **Reproduce, fix, re-run the reproduction.** Not a broader suite, not a
  cleaner path.

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
proves the behavior, and is deleted afterward — in the same turn, not a later
one. It is not acceptable as a substitute for a tool that already does the job
(`agent-browser` for anything a browser can show). A workaround is acceptable
only when explicitly requested or when it is a named temporary boundary with a
clear removal condition.

## Repository boundaries

- `src/` is the production backend; `dashboard/src/` is browser code.
- Dashboard code must not import Elysia, database drivers, filesystem modules,
  secrets, or Node-only runtime dependencies. It calls `/console/api`.
- Treat network responses, environment variables, database rows, request bodies,
  and user values as untrusted. Validate at boundaries and fail closed.
- Preserve intentional provider wire bytes, headers, and user-agent behavior.
- Keep one source of truth for provider metadata, persisted contracts, environment names, routing policy, and dashboard mirrors.
- Provider, health, and streaming claims in docs and skills must match the owning code. A dashboard section is a mirror, not a second inventory.
- `scripts/` is grouped by purpose: `cli/`, `operations/`, `install/`, `build/`,
  `generate/`, `dev/`, `test/`, and `shared/`. Avoid barrel files; use role names
  such as `contracts.ts`, `routes.ts`, `store.ts`, `service.ts`, and `errors.ts`.
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
`scripts/test/run.ts` against the isolated `.env.test` database — never the dev
database). Typecheck is not behavioral proof. Exercise the real boundary: a
live gateway request, a real browser surface, database migration in an isolated
environment, or a temporary script calling production code.

UI claims require `agent-browser` evidence (see "Browser verification"). If no
browser runtime is available, say exactly why — do not substitute markup
guesses, and do not report the surface as verified.

## Tests that lock

A test earns its place only by failing when the fix is absent.

- **Revert, watch it fail, restore, watch it pass.** A test that passes both
  ways proves nothing and is worse than none: it is a future false assurance.
  A measurement helper (an audit, a counter, a matcher) gets the same
  treatment — pin its classification with cases that would break if the
  matcher regressed.
- **Test the mechanism, not the symptom.** `cn("text-badge",
  "text-text-secondary")` keeps the size — that catches the merge bug. Asserting
  that a rendered page has the right font size catches only that page.
- **An expected value must have a source.** Widths come from the caller's
  `DialogSize`, not from the primitive's default. A magic number in a test is
  a claim that will rot; a value read from the owning constant is a claim that
  cannot.
- **A failing check that is really a wrong expectation is a test bug.** Fix the
  test, and say in the report that the expectation was wrong — never quietly
  weaken an assertion to make a run green.

## Safety and git

Never use destructive git commands such as `reset --hard`, `checkout --`, or
`clean`. Do not commit, push, deploy, touch production data, delete user data, or
discard unrelated working-tree changes unless explicitly asked.

**Credentials may be given in a message.** This is a local-first development
repo, reproduction comes before everything else, and making an operator retype a
dev API key through an environment file before a failing request can be replayed
cost more than it ever protected. So: use a credential the operator hands you,
for the local target they named, without arguing about the channel.

What still holds, because it is a different failure with a different cost —
**a credential never lands anywhere durable**:

- never write it to a file, including `.env`, `.env.*`, a script, or a scratch
  file;
- never put it in a commit, a commit message, a PR body, or documentation;
- never echo it into output, a log line, an error message, a payload capture, or
  a telemetry row;
- never send it to a third party.

Prefer the environment anyway when one is already set, and prefer a value the
operator put in `.env` themselves over one retyped in chat — not as a rule about
trust, but because a file survives a context summarization and a message does
not. When you must print a request for someone to replay, redact the credential
and say that you did.

Verify the environment before database/production operations and prefer
reversible, transactional steps.

## Completion report

Report:

- what changed and where;
- the reproduction or why it remains unverified;
- commands/gates run and their result;
- real-boundary evidence;
- failures, skips, blockers, and next action.

Do not claim an issue is fixed when it was only masked, or claim tests passed when
no tests were run.
