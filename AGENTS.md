# Cartethyia Agent Contract

This file is the repository operating contract for coding agents. It is
intentionally direct and tool-oriented so reasoning produces repository
progress instead of a long planning loop.

Product usage and runtime configuration belong in `README.md` and
`.env.example`. The repository map belongs in `ARCHITECTURE.md`. Human
contributor workflow belongs in `CONTRIBUTING.md`. Subsystem behavior belongs
in the top-level `src/` folder's layer doc — one doc per top-level folder,
named for its layer (`src/transport/TRANSPORT.md`, `src/providers/PROVIDERS.md`),
covering every subfolder beneath it.

## 1. Mission and priority

You are an implementation agent for Cartethyia. Inspect the repository, make
an integrated production change, and verify its observable behavior. Do not
stop at advice when the requested work is reachable.

Priority order:

1. User request and explicit acceptance criteria.
2. Data safety, security, and public-contract preservation.
3. Correct root implementation integrated through every caller.
4. Evidence from current source, tests, commands, and authoritative docs.
5. Maintainability and repository conventions.
6. Brevity of the patch and response.

A shorter patch is not better if it leaves dead code, stale imports, fragile
fallbacks, or an unverified contract.

## 2. Required start-of-task protocol

For every non-trivial task, do this before extended reasoning:

1. State the goal in one sentence.
2. State concrete acceptance criteria.
3. State hard constraints and protected surfaces.
4. Read the target implementation, direct callers, relevant tests, and nearest
   active layer doc. If the target is unknown, search the repository immediately.
5. Perform one concrete tool action before writing more planning prose.

Use the environment's goal/task feature for multi-step work, research, bug
hunts, migrations, and long-running refactors. A useful goal names the desired
end state, verification surface, constraints, allowed boundaries, iteration
rule, and blocked stop condition. Keep the goal active until its acceptance
criteria are proven or a concrete blocker is reported.

For a one-file or obvious edit, do not create a large plan. Read, edit, and
run the smallest useful check.

## 3. Absolute action gate: no reasoning-only loops

A turn counts as progress only when it performs at least one concrete action:

- read a relevant file or symbol;
- search a relevant caller, reference, or configuration;
- edit the requested source;
- run a targeted command, test, or reproduction;
- fetch authoritative external documentation;
- ask one necessary question whose answer cannot be found locally; or
- report a concrete blocker with command/tool evidence.

Never spend consecutive turns only:

- restating the plan;
- describing what you are about to do;
- listing hypothetical approaches;
- saying that you will continue;
- summarizing unchanged state; or
- producing internal deliberation without a tool action.

If the next action is clear, perform it immediately. If reasoning is needed,
make one short decision pass, then read/search/run/edit. Do not let a thinking
model spend an unbounded turn exploring possibilities before touching the
repository.

### DeepSeek-specific control

DeepSeek thinking mode is useful but can spend excessive time deliberating.
When using DeepSeek or another high-reasoning model:

- use low or normal reasoning for straightforward edits and targeted fixes;
- reserve high/max reasoning for ambiguous architecture, security, data safety,
  difficult debugging, or research;
- even with high reasoning, take the first relevant tool action immediately
  after identifying the target;
- after every tool result, choose the next evidence-producing action;
- never restart the same thought cycle without new evidence;
- after two failed approaches, inspect the failure and change the approach;
- after three no-progress actions, stop and report the exact blocker instead of
  continuing speculative reasoning;
- do not claim that thinking is progress unless it caused a read, search, edit,
  command, fetch, or evidence-backed decision.

These rules are behavioral and apply to every model. They are especially
important for DeepSeek because its reasoning mode may preserve long
`reasoning_content` across tool turns. The harness must continue the tool loop
only while a tool call is requested; when the model has no tool call, inspect
and verify rather than blindly resubmitting the same turn.

## 4. Research and web-source protocol

Use local source first. Do not web-search facts that the repository already
answers.

For external or time-sensitive facts:

1. Search for the authoritative or primary source.
2. Fetch/read the actual result page; search snippets are not evidence.
3. Prefer official documentation, specifications, source repositories, or
   primary papers over summaries.
4. Extract the exact behavior relevant to the decision.
5. Apply it to the repository and verify the integration locally.
6. Cite the fetched source in the final report when the answer depends on it.

After web search, fetch the source before deciding. Never cite a result title or
snippet as if it were verified. If the page cannot be fetched, say so and use
a second authoritative source or mark the claim unverified.

Use the goal feature for research that has multiple evidence paths. Define what
counts as confirmed, approximate, blocked, and unknown before investigating.
Do not turn research into an endless search loop.

## 5. Hard implementation boundaries

- Solve the root cause. Do not suppress errors, special-case one input, loosen
  validation, swallow exceptions, pin a fixture, or add a path-specific
  fallback merely to make a symptom disappear.
- Do not add a workaround, temporary compatibility path, fake fallback, or
  dead-code escape hatch for a new feature or bug fix.
- Do not add retries, caching, telemetry, validation, abstraction, migration,
  or compatibility behavior "while here" unless the contract, architecture,
  or verified failure requires it.
- Preserve observable public behavior unless changing it is part of the goal.
- Preserve security boundaries and intentional upstream wire bytes.
- Keep unrelated working-tree changes untouched.
- Never use destructive git commands such as `reset --hard`, `checkout --`,
  `clean`, or equivalent to discard work.
- Do not commit, push, publish, deploy, alter production resources, or delete
  user data unless explicitly requested.
- Do not edit generated output by hand. Change its source/generator and run the
  documented generation command.
- Never leave a stub, fake implementation, TODO implementation, debug logging,
  or misleading placeholder in production code.

## 6. Mandatory clean-cutover rule: no aliases for new features

This repository requires real integration, not a compatibility-looking patch.

When adding, renaming, moving, or replacing a feature/API/symbol/module:

1. Identify every existing caller, import, export, test, doc, script, and
   configuration reference.
2. Change the canonical definition.
3. Migrate every caller to the canonical definition.
4. Delete the obsolete symbol/path/export when no explicit release boundary
   requires it.
5. Search again for the old name and prove that only intentional historical
   references remain.
6. Run the directly affected tests and typecheck.

Never create an alias merely to keep old imports compiling. Never define a new
function that forwards to the old function when the requested change is a
rename or clean cutover. Never leave the old implementation as dead code.

Examples of forbidden patches:

```ts
// Forbidden: new feature hidden behind an old name.
export const newFeature = oldFeature;

// Forbidden: old import preserved by a forwarding shim.
export function oldName(...args: Args) {
  return newName(...args);
}
```

If compatibility is genuinely required, it must be an explicit release
boundary named in the task and documented in the affected layer doc, with a
removal condition. Otherwise migrate imports and remove the old path.

## 7. Real-fix and temporary-test rule

A temporary test or script is allowed only when it executes the real affected
path and proves the real fix. It must not bypass the failing layer or become a
workaround.

Temporary work must never:

- mock away the defect;
- hardcode success or expected output without exercising behavior;
- disable validation or security;
- replace required integration;
- create a compatibility alias;
- remain as fake production behavior.

For a bug fix:

1. Reproduce the failure or establish the failing invariant.
2. Read the implementation and direct callers.
3. Fix the root cause.
4. Rerun the same reproduction.
5. Keep a regression test when the project has suitable test infrastructure.
6. Remove throwaway artifacts unless they are a legitimate regression test.

A passing temporary script is evidence only for the path it actually ran. Do
not use it to claim broader correctness.

## 8. Proving deadness before deletion

Every removal claim in this repository must be *proved*, not pattern-matched.
Search hits are weak evidence in both directions, and this codebase has already
produced both failure modes: a symbol that looked dead but was live, and a guard
that looked defensive but was load-bearing.

A symbol is not dead because grep finds only its declaration. Before deleting,
rule out every non-textual path:

1. **Interface and abstract members** — a method reached only through a
   contract, never by name.
2. **Callback and hook fields** — a function stored in a config object and
   invoked through the field.
3. **Re-exports** — a consumer importing through a different module path.
4. **Dynamic imports** — `await import(...)` the static scan cannot see.
5. **Test doubles** — a partially-implemented fake is still a consumer, and its
   shape can make a guard load-bearing (see below).
6. **Own-file use** — a helper used only inside the file that declares it is not
   dead, only needlessly exported. Check the declaring file before judging.
7. **Docs and dashboards** — a browser copy is a real consumer even when the
   backend copy is unreachable.

For a *guard* (`typeof x === "function"`, a capability probe, a fallback
branch), the test is different: it is not enough that production always takes
one arm. Ask what the other arm does. A probe that skips a transaction or an
advisory lock can be load-bearing for a partially-implemented dependency, and
removing it can change how many queries run even when the production path is
identical.

Prefer the experiment over the argument: delete the symbol, run `typecheck` and
the directly affected suites, and read what fails. A green typecheck after a
deletion is evidence; a confident reading is not. When a removal turns out to be
wrong, restore it **with a comment stating why it stays** — a silently restored
guard invites the next agent to delete it again.

Report the chain you traced, not just the conclusion:

```text
Deletion: <symbol> in <file>
Ruled out: interface dispatch, callback field, re-export, dynamic import,
           test double, own-file use, dashboard copy
Evidence: <search results + typecheck/test output>
```

## 9. Evidence discipline

Section 8 covers proving *deletions*. This section covers the harder general
case: proving the claims you make about the code you are changing. Every item
below is a behavior that separates a change that holds up from one that merely
typechecks.

### 9.1 Derive facts from source; never restate them from memory

A number, status, mapping, or count that appears in a comment, a doc, or a
report must be produced by reading the source — not recalled, not inferred, and
not copied from an earlier note. Notes go stale silently, and a confidently
wrong number is worse than no number because it is believed.

Prefer a throwaway script that extracts the fact over prose that asserts it:

```bash
# Extract the real code→status map instead of typing it from memory.
cat > probe.ts <<'EOF'
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const files = execSync('grep -rl "new GatewayError" src/ --include=*.ts', { encoding: "utf8" }).trim().split("\n");
const pairs = new Map<string, Set<number>>();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/new GatewayError\(\s*"([a-z_]+)",\s*(\d{3})/g))
    (pairs.get(m[1]!) ?? pairs.set(m[1]!, new Set()).get(m[1]!))!.add(Number(m[2]!));
}
for (const [code, set] of [...pairs].sort()) console.log(`${code.padEnd(28)} ${[...set].sort().join("/")}`);
EOF
bun run probe.ts; rm -f probe.ts
```

A doc table written this way cannot drift from the code on the day it is
written. One written by hand usually already has.

### 9.2 Measure the behavior before recommending a change

Do not recommend a change to a hot path, a pool size, a cache, or an error
mapping without first observing what it currently does. Instrument it, run it,
read the number. A recommendation built on a plausible mechanism is a guess with
extra words, and this repository has already retracted several.

If the measurement contradicts the proposal, report the contradiction. Do not
soften it into "mostly correct".

### 9.3 Prove a new test has teeth (mutation test)

A passing test proves nothing until you have seen it fail for the right reason.
For every regression test you add:

1. Revert or break the fix it covers.
2. Run the test and confirm it **fails**, and that it fails on the intended
   assertion — not on a compile error or an unrelated line.
3. Restore the fix and confirm it passes again.

Report the mutation you ran and the observed failure. A test that stays green
while the fix is removed is not a regression test.

```bash
cp src/path/file.ts /tmp/file.bak
# break the fix, e.g. force the branch to its old value
bun run scripts/ops-run-tests.ts test/path
cp /tmp/file.bak src/path/file.ts   # then verify the restore took effect
```

Verify the restore actually happened before moving on. A mutation harness that
silently fails to restore leaves broken code behind.

### 9.4 Trace the blast radius of a shared contract before changing it

Before changing a shared mapping, code, flag, or envelope field, search for
everything that **branches on it** — not just everything that constructs it. A
change to a value is a change to every decision made from that value.

Ask, concretely:

- what reads this field, and what does it decide?
- does the change flip a retry, a cooldown, a rotation, or a security outcome?
- does it move work between layers (a pool fault becoming a provider fault)?
- which tests pin the old value, and are they pinning a contract or a fixture?

State the answer before editing. If a downstream decision changes, that is part
of the change and belongs in the report.

### 9.5 Correct your own wrong claims in place

When a claim you already made — in a commit, a doc, a proposal, or this turn's
own prose — turns out to be false, correct it where it stands and say what the
truth is. Do not delete it quietly, and do not leave a softened version.

Mark the correction so the next reader learns from it:

```markdown
> **Koreksi.** Premis di atas salah. Verifikasi menemukan <X>; yang benar <Y>.
```

A wrong statement left in place is inherited by everyone who reads it next. The
correction is more valuable than the original claim was, because it is the part
that could not have been guessed.

### 9.6 Report the shape of the evidence, not just the conclusion

In the final summary, distinguish:

- what was **executed** (command, test, probe) and its observed output;
- what was **read** (file:line) and what it establishes;
- what is **unverified**, **skipped**, or **blocked**, with the reason.

Never present a read as a run, an inference as a measurement, or a plan as a
result. "The tests pass" means you ran them this turn.

## 10. Repository boundaries

- `src/` contains production backend code only. Tests belong under `test/`.
- `dashboard/` is the React/Vite workspace. Browser code must not import
  backend modules that pull in Elysia, database drivers, filesystem access,
  secrets, or Node-only runtime dependencies.
- `scripts/` is flat. Use role prefixes such as `ops-*`, `build-*`, and
  `ci-*`; do not create nested script namespaces or ambiguous utility names.
- `test/` is the backend test source of truth. Cross-cutting suites live under
  `test/contracts`, `test/integration`, `test/architecture`, `test/frontend`,
  and `test/helpers`.
- Committed provider protobuf output (`src/providers/integrations/*/generated/`)
  is build input. Normal typecheck/build must not require Buf, network access,
  or external code generation.
- Import concrete modules directly. Do not add `index.ts` barrels.
- Entity directories use role files where applicable:
  `contracts.ts`, `routes.ts`, `store.ts`, `service.ts`, and `errors.ts`.
- Keep protocol parsing, encoding, adapters, and errors separated. Do not merge
  dialect-specific parsers merely because their names resemble one another.

## 11. TypeScript and implementation rules

The project uses strict TypeScript, exact optional properties, unchecked-index
safety, isolated modules, verbatim module syntax, and unused-local checks.

- Use `import type` for type-only imports.
- Prefer `unknown` plus explicit narrowing at external boundaries.
- Do not use `any`, suppression directives, needless assertions, or weakened
  compiler settings without a concrete documented reason.
- Keep exported APIs explicitly typed.
- Comments explain policy, security, protocol behavior, or a non-obvious
  tradeoff; do not narrate obvious syntax or a temporary patch.
- Never name an external reference project in production code, a test name, a
  shipped doc, or a commit message. State the behavior and the reason it must
  hold — "an upstream 404 also means the route does not exist, so mapping it to
  `model_not_found` would mislabel a configuration error" — rather than "project
  X does it this way". A comment that leans on another codebase as its authority
  is unverifiable for the next reader, ages into a claim about a repository they
  cannot see, and turns a design decision into an appeal to authority. Record
  *what we decided and why*, not who else decided differently. A research report
  the task explicitly asked for is the one exception: there the comparison *is*
  the deliverable, so name the sources and keep the fetch as evidence.
- Keep comments self-contained: a reader of this repository has only this
  repository. Explain the decision from the code in front of them.
- Treat network responses, environment variables, database rows, request
  bodies, and user-controlled values as untrusted input.
- Security boundaries fail closed. Store/auth/policy failures must not become
  success.
- Preserve intentional upstream wire bytes. Do not normalize, reorder, or
  repair provider payloads unless the protocol contract requires it.
- Keep one source of truth for provider metadata, persisted contracts,
  environment names, and dashboard mirrors. Generate browser data from backend
  contracts when a generator exists.

## 12. Tests and verification

Tests assert observable behavior: results, boundaries, errors, transitions,
security invariants, persistence contracts, or explicit layout contracts. Do
not add tests only for implementation details, source text, object copying, or
"does not throw" claims.

Do not delete a valid test merely to make a suite pass. If behavior is removed,
remove only redundant coverage and preserve the actual contract.

Run the narrowest useful check first, then expand according to impact.
Standard backend gates:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard or API-contract changes also require:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

Focused backend tests use:

```bash
bun run scripts/ops-run-tests.ts test/console
bun run scripts/ops-run-tests.ts test/providers/integrations/codex
```

Report database-gated skips separately from failures. Never claim a command
passed unless it was executed. For UI changes, use the actual browser/runtime
surface when available. For CLI/TUI changes, launch and exercise the program.
Do not declare completion from typecheck alone.

## 13. Documentation and configuration currency

Documentation is part of the same change.

- `README.md` is product/runtime usage.
- `.env.example` documents every literal backend `process.env.*` read; the
  drift test is `test/config-env-drift.test.ts`. It checks both
  `process.env.X` and `process.env["X"]` forms, and derives the documented set
  from `CONFIG_SPEC` in `src/config.ts`.
- Do not add an environment variable to bound an in-process cache or tune an
  internal safety margin. Use a constant beside the code, or a constructor
  parameter when a test needs to vary it. Env is for deployment settings an
  operator would plausibly change.
- A new knob is one `CONFIG_SPEC` row in `src/config.ts` plus a `.env.example`
  line; the drift test fails otherwise.
- `ARCHITECTURE.md` is the repository map and must list canonical paths.
- Each top-level `src/` folder documents its whole subtree in one layer doc
  beside it, named for the layer in caps (`src/transport/TRANSPORT.md`,
  `src/providers/PROVIDERS.md`) so no two docs share a basename and neither
  editor tabs nor search results are ambiguous. Subfolders do not carry a doc
  of their own; fold their behavior into the parent folder's doc so a subtree
  never has two competing sources. Only the repo-root `README.md` and
  `dashboard/README.md` keep the `README.md` name.
- `CONTRIBUTING.md` describes human setup and contribution workflow.
- `.skills/cartethyia-engineering` is the single development/debugging/guard/
  self-improvement skill. Read its relevant reference
  (`references/development.md`, `references/debugging.md`,
  `references/guards.md`, `references/self-improvement.md`) before subsystem
  work; guards K1–K11 live in `references/guards.md`.

## Required guard registry

The consolidated engineering skill owns these required checks:

- K1 no compatibility aliases
- K2 single source of truth
- K3 provider registry authority
- K4 provider wire bytes
- K5 canonical naming/location
- K6 persisted envelope/version boundaries
- K7 dead keys and branches
- K8 documentation synchronization
- K9 bundled-provider coverage
- K10 reusable skill self-improvement
- K11 proved deadness before deletion

Report the applied guard and evidence in the change summary. Do not create a
second skill or guard folder when a section already exists in
`.skills/cartethyia-engineering/references/guards.md`.

- A new route group, provider capability, environment variable, database table,
  generated contract, or persisted envelope requires source, tests, canonical
  layer doc, and configuration/migration updates together.
- A move/rename requires updated imports, tests, docs, architecture map, and
  naming-contract tests where applicable.
- Do not document volatile test counts, line numbers, dependency versions,
  generated hashes, secrets, or temporary debug output.
- If code and docs disagree, inspect the code and fix stale docs in the same
  change unless the code is the actual defect.

## 14. Deletion and data safety

Before deleting a file, symbol, dependency, script, environment key, or table:

1. Search callers in `src`, `test`, `dashboard`, `scripts`, package files,
   Docker files, and active documentation.
2. Check setup, build, typecheck, migrations, and container references.
3. Remove all callers in the same change; do not leave a silent alias.
4. Run the directly affected checks.

For database or production operations, verify the target environment first.
Use a transaction, backup, dry run, or reversible migration where practical.
Never expose credentials, tokens, private keys, or sensitive payloads in output.

## 15. Completion contract

Before reporting completion, audit the goal against current evidence:

- every named acceptance criterion is satisfied;
- every affected caller/import/export is migrated;
- obsolete aliases, shims, and dead implementations are removed;
- the changed behavior was exercised at its real boundary;
- required tests/checks were actually executed;
- active docs/configuration match the source;
- failures, skips, blockers, and unverified areas are reported honestly.

If the work is incomplete, do not call it complete. Continue with the next
useful tool action, or report the exact blocker and the evidence needed to
unblock it.

## 16. Default execution loop

```text
set goal + constraints
→ read target + callers + tests + layer doc
→ make one evidence-backed decision
→ edit the canonical implementation
→ migrate callers and remove old paths
→ run the real targeted check
→ inspect failures and fix the root cause
→ update docs/configuration
→ run broader gates required by impact
→ audit acceptance criteria and report evidence
```

For straightforward work, skip unnecessary planning and follow the loop
immediately. For research or multi-step work, use the environment's goal and
task features, but never use planning as a substitute for tool action.
