# Verification

Use for every fix, refactor, removal, or contract change. This is the single
owner of the gate list; other references point here instead of repeating it.

## Gates

```bash
bun run typecheck                # always
bun run dashboard:typecheck      # when dashboard/ changes
bun run build                    # when an entry point or build contract changes
bun run test                     # or scoped: test:backend, dashboard:test, test:watch
```

The repository carries an active test suite (`test/`, `dashboard/test/`, run via
`scripts/ci-run-tests.ts` against the isolated `.env.test` database — never the
dev database).

Typecheck proves code shape, not behavior. Run the affected scope alongside the
gates, and exercise the real boundary: the browser through the browser agent
(Puppeteer — prefer it over a raw CDP client, it is far easier to control), a
live gateway request, or a `.tmp-<topic>.ts` calling production code. Delete
temporary files afterward.

## Bug-fix loop

1. Reproduce with the same input and boundary as the report.
2. Find the canonical owner and callers with CodeGraph or Grep.
3. State the mechanism, not the symptom.
4. Change the owner; migrate callers; do not add a fallback to hide the failure.
5. Re-run the reproduction, then the affected gates and test scope.
6. Report what was proven and what could not be verified.

## Rename or removal

- Search imports, re-exports, dynamic imports, callbacks, scripts, dashboard,
  and docs.
- Remove the old symbol; do not leave an alias or shim.
- Search the old name again after editing.
- A declaration-only grep result does not prove deadness; typecheck and caller
  analysis must rule out indirect dispatch. See `guards.md` for the deadness
  classes.

## Wire and payload changes

For translation bugs, compare client request, provider request, provider
response, and client response. Fix the layer that loses or changes data. Do not
alter upstream bytes that are intentionally preserved. Replay and bisection
procedure is in the `cartethyia-trace-replay` skill.

## Schema changes

Exercise a new migration against an isolated database when available. Keep the
runtime schema, baseline, forward migration, and readers/writers aligned. Never
edit a migration that has already been recorded.

## Completion

Report commands, relevant output, the boundary exercised, and limitations. Do
not say a gate passed when it was not run.
