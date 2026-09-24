# Dashboard

`dashboard/` is the React/Vite client for the authenticated `/console` surface.
The backend serves the built files from `dist/dashboard`; source changes are not
visible to a running backend until the dashboard build is regenerated.

## Route map

`src/App.tsx` mounts a `BrowserRouter` with basename `/console` and lazy route
chunks:

| Path | Route component | Backend domain mirror |
| --- | --- | --- |
| `/login`, `/setup`, `/banned` | `Login`, `Setup`, `Banned` | `console/auth` |
| `/` | `Overview` | dashboard summary APIs |
| `/usage` | `Usage` | `console/domains/stats` and usage contracts |
| `/providers` | `Providers` | `console/providers/catalog` |
| `/providers/:providerId` | `ProviderDetail` | `console/providers/detail` and catalog |
| `/combos` | `Combos` | `console/routing/model` |
| `/quota` | `Quota` | `console/quota` |
| `/proxy` | `Proxy` | `network/pool` and routing |
| `/customization` | `Customization` | none (browser-local: `dashboard/src/lib/customization`) |
| `/model-lab` | `Studio` | `console/domains/studio` |
| `/cli-tools`, `/cli-tools/:toolId` | `CliTools`, `CliToolDetail` | `console/cli-tools` |
| `/console-log` | `ConsoleLog` | `console/domains/logs` and SSE |
| `/settings` | `Settings` | `console/settings` |

Unknown protected paths redirect to `/`. Session transitions clear the shared
query cache and navigate to `/login` or `/banned` rather than rendering stale
tenant data.

## Contracts and parity

- `src/lib/contracts.ts` is the dashboard's API mirror. Backend DTOs remain the
authority; update the mirror in the same change and keep `dashboard/src/*-parity.test.ts`
  checks green.
- Provider display names in `src/lib/provider-names.ts` mirror the canonical
  bundled provider registry. Keep the exact bundled count and ids synchronized;
  BYOK providers are runtime data, not bundled registry entries.
- `src/components/ProviderIcon.tsx`'s `iconAssets` map and `Providers.tsx`'s
  `FREE_LIMITED_IDS` / `FREE_AVAILABLE_IDS` / `FOUNDING_IDS` sets are the same
  kind of hand-copied provider-id list, guarded by
  `src/provider-lists-parity.test.ts`. The icon map may carry extra keys for
  ids a user can type into a compatible-provider form; every bundled id must
  have one.
- `src/lib/contracts.ts` derives the session mirror from the backend
  `SessionStatusResponse` (a discriminated union on `status`) and pins it in
  `src/session-parity.test.ts`, so the wire arm and the dashboard view cannot
  drift field-by-field.
- `src/lib/contracts.ts` re-exports the backend `USAGE_DIMENSIONS` tuple as a value, not a
  type-only copy, because the Usage page validates `?dim=` against it at runtime and offers one
  breakdown tab per member. Pinned by `src/usage-dimensions-parity.test.ts`.
- Usage periods are generated into `src/lib/generated/usage-periods.json` by
  `bun run codegen`; do not hand-maintain a second period list.
- Query keys, hooks, and route components must use the existing `consoleRequest`
  API boundary instead of constructing another HTTP client or importing backend
  modules.

## Browser-safe boundary

Vite bundles this tree for browsers. Never import backend modules, Elysia,
`node:*` APIs, database clients, provider adapters, secrets, or server-only
crypto into `dashboard/src`. Keep browser contracts as plain types and values;
hand-copy only the intentionally mirrored display metadata and protect it with
a parity test. OAuth tokens and provider credentials must stay server-side.

For route changes, update the lazy import, protected route map, shell navigation,
API hook, and this table together. For backend contract changes, update the
backend DTO, dashboard mirror, hook/request shape, affected route, and parity
coverage in one change.

## Development and verification

From the repository root, use the dashboard workspace scripts:

```bash
bun run --cwd dashboard dev
bun run dashboard:typecheck
bun run dashboard:test
bun run dashboard:build
```

`dev`, `typecheck`, `test`, and `build` run the usage-period code generator
first. Use `dashboard:build` before live-verifying a backend-served console.
