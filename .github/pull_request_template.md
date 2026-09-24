## What

<!-- One or two sentences: what changes and why. -->

## Verification

<!-- Paste or check what you ran. Do not claim a command passed unless it was executed. -->

### Backend (required for any `src/`, `test/`, `scripts/`, `drizzle/` change)

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check:coverage`

### Dashboard / API contracts (required for `dashboard/` or API contract changes)

- [ ] `bun run dashboard:typecheck`
- [ ] `bun run dashboard:test`
- [ ] `bun run test:contracts`

### DB-gated skips

<!-- DB suites skip without CARTETHYIA_TEST_DATABASE_URL, and run against that
     database (never DATABASE_URL) when it is set — see test/helpers/db-gate.ts.
     Report them separately from failures: how many skipped, and whether you ran
     them against a real database. -->

- Skipped suites: <!-- e.g. "none — ran with local Postgres" / "12 DB suites skipped, no local DB" -->
- Failures: <!-- "none" or link to logs -->

## Docs

<!-- Required when the change adds a layer, route group, provider capability,
     env var, or DB table. See AGENTS.md "Documentation currency" for the
     co-change rules and the never-record list. -->

- [ ] No doc update needed (why: <!-- ... -->)
- [ ] Updated: <!-- e.g. src/transport/TRANSPORT.md, .env.example -->
- [ ] `ARCHITECTURE.md` map updated (only if a layer doc was added/renamed)
- [ ] New procedure/debugging fact folded into `.skills/cartethyia-engineering/references/` (no competing skill files)
- [ ] No `file:line` refs added outside `.skills/cartethyia-engineering/references/debugging.md`; touched debug line refs re-verified

🤖 Generated with [Claude Code](https://claude.com/claude-code)
