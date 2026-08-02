## Summary

<!-- State the user-visible problem and the intended outcome in 2–5 sentences. -->

## Change classification

- [ ] Bug fix
- [ ] Feature
- [ ] Provider/integration change
- [ ] Security or access-control change
- [ ] Persistence/schema change
- [ ] Dashboard/UI change
- [ ] Documentation/release change
- [ ] Performance change

## Scope

### What changed

-

### What did not change

-

### Affected surfaces

- [ ] Proxy request path
- [ ] Provider registry/routing/model catalog
- [ ] OAuth/tokenkeeper/account health
- [ ] API keys/ACL/budgets/share links
- [ ] Config SQLite (`DATA_DIR/cartethyia.sqlite`)
- [ ] Runtime SQLite/telemetry (`DATA_DIR/runtime.sqlite`)
- [ ] Dashboard
- [ ] Docker/Railway/deployment
- [ ] Public documentation

## Security and data handling

- [ ] No credentials, API keys, OAuth tokens, cookies, databases, `.env` files, runtime payloads, or generated logs are included.
- [ ] External input is validated and narrowed at the boundary; no unsafe `any`, unchecked assertion, or unescaped untrusted Markdown was introduced.
- [ ] Auth, ACL, rate limits, budgets, share-link privacy, and provider error behavior were reviewed when affected.
- [ ] Provider errors remain typed and are not converted into successful empty responses.
- [ ] If secrets/configuration are required, the documented secret/configuration path is used and no secret is embedded in source or history.

## Persistence and compatibility

- [ ] No database schema migration is required.
- [ ] Existing config/runtime database separation is preserved.
- [ ] Backup/restore compatibility was considered if persisted fields changed.
- [ ] Existing routes, provider prefixes, aliases, and credential kinds remain compatible or are deliberately migrated.

## Performance and operations

- [ ] Hot-path work, polling, retries, caches, and single-flight behavior were reviewed.
- [ ] Quota/token refresh has an explicit cooldown and does not create unnecessary upstream traffic.
- [ ] UI animation/background work is responsive on mobile, desktop, hidden tabs, and reduced-motion environments.
- [ ] Docker/Railway behavior was checked when deployment files or runtime configuration changed.

## Testing and evidence

Commands actually run:

```text
# Replace this with exact commands and keep only commands that ran.
# bunx tsc --noEmit -p .
# bun test test/path.test.ts
# cd dashboard && bun run test && bun run build
```

Observed results:

-

Manual verification (if applicable):

- [ ] Browser interaction tested
- [ ] API request path exercised
- [ ] Provider request path exercised with credentials
- [ ] `/health` exercised
- [ ] Not applicable

## Screenshots or recordings

<!-- Required for visible dashboard, landing, or share-page changes. Include desktop/mobile views when layout is affected. -->

## Release and changelog

- [ ] User-visible change is recorded in `CHANGELOG.md`.
- [ ] README/deployment docs are updated when behavior or configuration changed.
- [ ] Version alignment was checked for root and dashboard packages when this is a release.

Suggested commit subject:

```text
<type>: <specific summary>
```

Release notes / migration notes:

-
