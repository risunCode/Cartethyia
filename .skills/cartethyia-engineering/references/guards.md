
# Cartethyia Guards

This is the single guard skill for repository-wide invariants. Choose the
relevant sections before editing; multiple sections may apply. These checks are
about preventing silent drift, duplicate authorities, dead compatibility paths,
and unsafe cleanup.

## K1 — No compatibility aliases

Use for removals, renames, and contract cutovers.

1. Search runtime, tests, scripts, dashboard, and active docs for every old
   symbol/path.
2. Migrate every caller and remove the obsolete export in the same change.
3. Reject aliases, deprecated re-exports, migration facades, and silent
   fallback branches unless an explicit external compatibility boundary
   requires one.
4. If retained, document the consumer and removal condition.

Evidence: report the old-name search result and replacement call path. A clean
cutover requires zero runtime references to the old name.

## K2 — Single source of truth

Use when a value or contract is mirrored across backend, dashboard, tests,
generated output, or docs.

1. Name the authority before editing.
2. Trace all consumers and distinguish generated/mirrored copies from a second
   source of truth.
3. Move shared logic to the authority or generate the mirror.
4. Remove stale duplicate definitions.

Evidence: report authority, consumers, and the command/inspection proving no
competing source remains.

## K3 — Provider registry authority

Use for provider identity, capability, alias, addition, removal, rename, or
count changes.

- `src/providers/provider-metadata.ts` owns provider identity.
- `src/providers/default-registry.ts` owns capability and lazy-loader entries.
- Dashboard names, tests, docs, and catalogs are synchronized consumers.
- Every bundled identity needs exactly one capability entry; custom/BYOK paths
  remain separate.

Evidence: report registry keys checked, mirrored consumers updated, stale aliases
removed, and intentionally custom paths retained.

## K4 — Wire bytes

Use for parser, codec, endpoint, header, query, or provider adapter changes.

1. Identify the surface codec and provider adapter that own the bytes.
2. Separate structural cleanup from intentional protocol changes.
3. Preserve exact endpoint paths, prefixes, content types, headers, query
   parameters, and serialized shapes unless the upstream contract changes.
4. Verify with a focused fixture or captured request/response shape.

Evidence: report before/after wire contract and focused proof. Never replace a
wire requirement with a generic helper merely because it looks redundant.

## K5 — Naming and location

Use for file moves, splits, merges, and role-oriented module layout changes.

1. Confirm the canonical path from `AGENTS.md`, `ARCHITECTURE.md`, and
   neighboring modules.
2. Trace imports, dynamic imports, scripts, tests, Docker/build readers, and
   active docs before moving.
3. Perform a clean cutover: update callers, remove old path, update naming tests
   and maps.
4. Do not add barrels or compatibility files to preserve the old location.

Evidence: report old-path search, new path, and synchronized architecture/docs/
test references.

## K6 — Envelope and version boundary

Use for quota, telemetry, cache, API, database, or persisted envelope changes.

1. Define canonical shape and version discriminator.
2. Decide whether reads tolerate prior data and state the release boundary for
   removing that branch.
3. Write the new envelope consistently at every producer.
4. Preserve bounded retention, validation, and failure behavior while migrating
   callers and docs.

Evidence: report producer/consumer coverage, old-data handling, and exact
migration/removal condition.

## K7 — Dead keys and branches

Use for env vars, settings fields, feature flags, fallback constants, and dead
branches.

1. Search literal readers and semantic consumers across source, tests, scripts,
   dashboard, Docker, and active docs.
2. Distinguish live kill-switches/safety fallbacks from obsolete keys.
3. Remove dead key, parser/schema field, docs, and tests together.
4. Re-run a zero-reference search; note intentional historical changelog hits.

Evidence: report reader inventory and why each retained key is live or each
removed key is unreachable.

## K8 — Documentation synchronization

Use for every behavior, setting, route, provider, schema, worker, or file-layout
change.

1. Identify code authority and every active doc describing it.
2. Update the smallest authoritative docs in the same change; do not copy
   implementation detail into `AGENTS.md`.
3. Remove dead links, stale counts, obsolete names, and contradicted claims.
4. Anchor citations to symbols and paths, never line numbers: the repository
   forbids line numbers in committed docs because they drift on every edit, and
   a stale number sends the reader to unrelated code. Keep line numbers for
   throwaway reports only.
5. Keep historical changelog entries historical while correcting active docs and
   environment templates.

Evidence: report docs updated, links/counts checked, and unresolved evidence
instead of guessing.

## K9 — Bundled-provider coverage

Use when bundled providers are added, removed, renamed, or de-aliased.

1. Enumerate canonical identities from `RAW_BUNDLED_PROVIDER_METADATA`
   (`src/providers/provider-metadata.ts`) — not dashboard labels or aliases.
2. Keep every mirror in step: `BUNDLED_PROVIDER_IDS` and the registered modules
   (`src/providers/provider-registry.ts`), `PROVIDER_CAPABILITIES` and
   `BUNDLED_PROVIDER_MODULES` (`src/providers/default-registry.ts`), and the
   dashboard hand copies (display name, icon asset, section/free-tier sets).
3. Exclude BYOK/custom providers and removed aliases.
4. No file pins a provider *number*: the contract is set equality. Prove
   coverage with `test/providers/default-registry.test.ts` and
   `dashboard/test/provider-display-names-parity.test.ts` /
   `dashboard/test/provider-lists-parity.test.ts`, and confirm no stale id
   remains in any mirror.

Evidence: report the identity source, the mirrors checked, the coverage test
result, and any intentionally custom path retained.

## K10 — Skill self-improvement

Use after a cleanup review, rejected change, or newly discovered drift class.

1. Confirm the lesson is procedural/reusable, not a one-off implementation note.
2. Search both consolidated skills before adding content; extend the closest
   owner instead of creating another skill.
3. State trigger, required check, failure mode, and expected evidence.
4. Keep examples tied to current repository authorities and update `AGENTS.md`
   only when the guard is a required repository rule.

Evidence: report repeated failure/drift class, owning section, and why no
competing skill exists.

## K11 — Proved deadness

Use for every deletion, and for every guard or fallback branch proposed as
redundant.

1. A symbol is not dead because grep finds only its declaration. Rule out
   interface dispatch, callback fields, re-exports, dynamic imports, test
   doubles, use inside its own declaring file, and dashboard copies.
2. For a guard or probe, ask what the *other* arm does before calling it
   defensive noise. A skipped transaction or advisory lock can be load-bearing
   for a partially-implemented dependency.
3. Prefer the experiment: delete, run `typecheck` and the directly affected
   suites, and read the failure. Green output is evidence; a confident reading
   is not.
4. When a removal turns out to be wrong, restore it **with a comment stating why
   it stays**. A silently restored guard invites the next agent to delete it
   again.

Evidence: report the call chain traced, the paths ruled out, and the
typecheck/test output. A deletion claim without a traced chain is not evidence.

## Shared evidence format

For every applied guard, report:

```text
Guard: K<n> <name>
Authority: <canonical file/symbol>
Scope: <files/surfaces checked>
Evidence: <search/test/command result>
Exceptions: <intentional compatibility/history, or none>
```

## Verification

Run only checks relevant to the changed boundary first, then the repository
baseline from the engineering skill. Never call a guard satisfied from prose
alone; the evidence must come from current source, search results, generated
artifacts, or executed checks.
