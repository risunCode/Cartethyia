# Development

## Orientation

- Backend lives in `src/`; browser code lives in `dashboard/src/`.
- Use CodeGraph for owners, callers, and call paths; `Read` for a known range;
  `Grep` for a known literal.
- Read the relevant layer and reference before touching a subsystem.
- One behavior should have one canonical owner.

## Add or change a feature

1. Define acceptance criteria and the real boundary to exercise.
2. Find the definition, callers, contracts, config, docs, and generated source.
3. Edit the canonical owner first.
4. Migrate every caller and remove the old path.
5. Update docs/config when a claim or setting changes.
6. Run the verification reference.

## Add a provider

Use `provider-lifecycle.md`. Do not copy metadata into multiple places without
naming the authority. Provider wire behavior, auth, catalog, account state, and
model availability each follow their owning source.

## Contract or schema changes

Find every producer, validator, persistence layer, reader, and dashboard mirror.
A schema change requires the runtime schema, baseline, and a new forward migration.
Dashboard contracts must remain browser-safe.

## Removal and deduplication

- Prove callers and dynamic reachability before deleting a symbol.
- Clean cutover: change the canonical definition, migrate callers, delete the old name.
- Do not preserve compatibility through aliases.
- If two implementations have different policy, unify the policy before moving code.

## Verification

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
bun run build                # when a build entry/contract changes
```

Then exercise the real boundary described by `verification.md`, plus the
affected test scope (`bun run test:backend`, `bun run dashboard:test`).


