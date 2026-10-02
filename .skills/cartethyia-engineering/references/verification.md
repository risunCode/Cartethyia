# Verification

Use for every fix, refactor, removal, or contract change.

## Gates

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when an entry point or build contract changes
```

The repository does not currently carry an active test suite. Typecheck proves
code shape, not behavior. Exercise the real boundary: browser, gateway request,
or a `.tmp-<topic>.ts` calling production code. Delete temporary files afterward.

## Bug-fix loop

1. Reproduce with the same input and boundary as the report.
2. Find the canonical owner and callers with CodeGraph/Grep.
3. State the mechanism, not the symptom.
4. Change the owner; migrate callers; do not add a fallback to hide the failure.
5. Re-run the reproduction, then the affected gates.
6. Report what was proven and what could not be verified.

## Rename or removal

- Search imports, re-exports, dynamic imports, callbacks, scripts, dashboard, and docs.
- Remove the old symbol; do not leave an alias or shim.
- Search the old name again after editing.
- A declaration-only grep result does not prove deadness; typecheck and caller
  analysis must rule out indirect dispatch.

## Wire and payload changes

For translation bugs, compare client request, provider request, provider response,
and client response. Fix the layer that loses or changes data. Do not alter
upstream bytes that are intentionally preserved.

## Schema changes

Exercise a new migration against an isolated database when available. Keep the
runtime schema, baseline, forward migration, and readers/writers aligned. Never
edit a migration that has already been recorded.

## Completion

Report commands, relevant output, the boundary exercised, and limitations. Do
not say a gate passed when it was not run.
