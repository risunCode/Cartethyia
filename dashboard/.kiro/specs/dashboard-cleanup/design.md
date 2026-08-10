# Dashboard Cleanup Design

## Overview

Cleanup dilakukan sebagai beberapa batch kecil dengan invariant utama: URL route, endpoint API, payload, dan perilaku operator tidak berubah. Rename memakai TypeScript language server untuk memastikan dynamic import, test, dan exported symbol ikut berpindah. Refactor hanya dilakukan setelah characterization test untuk kontrak yang belum terlindungi.

Baseline yang sudah diverifikasi sebelum perubahan:

- `bun run test`: 19 test files, 157 tests passed.
- `bun run build`: typecheck dan Vite production build passed.
- Build masih mengeluarkan satu warning CSS existing dari selector utility `backdrop-blur-[6px]`; warning ini dicatat sebagai batch terpisah, bukan disuppress.

## Current hotspots

- `src/app/layout.tsx` — 856 lines; navigation metadata, shell state, command palette, dialogs, focus/keyboard handling, and footer.
- `src/features/model-studio/page.tsx` — 910 lines; streaming, markdown, sessions, attachments, prompt controls, message rendering, and page state.
- `src/features/providers/detail.tsx` — 1,943 lines; provider normalization, model test, account CRUD/OAuth, custom model modal, routing health, and page state.
- `src/components/model-picker.tsx` — 965 lines; catalog fetching, browser, modal, single picker, multi picker, aliases, combos, and custom providers.
- `src/features/customization/page.tsx` is reached through `features/advanced/page.tsx`, while `features/advanced/tools.tsx` wraps the CLI tools page and Automation placeholder.

The large files are not split mechanically. Each extraction must have a stable input/output contract and a testable behavior boundary.

## Canonical naming decisions

1. Keep user-facing URLs canonical as currently deployed: `/advanced`, `/advanced/token-saver`, `/advanced/cli-tools`, and so on.
2. Keep `/customization` and `/token-saver` as explicit compatibility redirects, with route tests. Do not remove them in this cleanup.
3. Make `CustomizationPage` the direct entrypoint for `/advanced`; remove `AdvancedPage` only after the route test and references confirm it is unused. The source domain remains `features/customization` because the page owns appearance/customization behavior, while `advanced` is a navigation namespace.
4. Make `CliToolsPage` from `features/advanced/cli-tools/page` the direct route entrypoint; remove `CliToolsPage` indirection from `features/advanced/tools.tsx`. Keep `AutomationPage` only if its route still needs the placeholder.
5. Do not rename every generic `page.tsx`. Rename only ambiguous exported symbols/files when a concrete collision or indirection exists. Candidate high-value rename: provider `detail.tsx` / `custom-detail.tsx` to explicit provider-detail names, performed with LSP references and a single atomic verification.
6. Use one terminology map for route metadata, nav labels, component names, and test descriptions. Product copy changes are out of scope unless required to remove a misleading legacy name.

## Architecture and batch boundaries

### Batch A — route and entrypoint cleanup

- Add characterization tests for canonical routes and legacy redirects.
- Change router lazy imports to canonical page exports where wrappers add no behavior.
- Remove dead wrapper files only after symbol references are empty.
- Keep the router's `basename`, guard loader, dynamic-import reload recovery, and exact path title lookup unchanged.

### Batch B — test infrastructure and high-risk contracts

- Add small test helpers for Query Client creation and deterministic API response routing.
- Preserve suite-local scenarios while removing duplicated `withQueryClient` and fetch parsing boilerplate.
- Add tests for:
  - `401` and unsafe `next` route handling;
  - legacy redirects;
  - successful and failed provider/account mutations;
  - model-picker selected alias/combo/custom-provider behavior;
  - dialog/drawer keyboard lifecycle;
  - SSE reconnect and unmount cleanup;
  - destructive database/settings actions and invalidation.
- Prefer exported pure normalizers/builders over mounting the 1,943-line provider page.

### Batch C — focused component extraction

Only after Batch B passes:

- Extract AppShell navigation metadata and command palette/notifications into bounded modules if their props are stable.
- Extract Model Studio streaming/session persistence/message row helpers while preserving stream abort, stale-session handling, autosave debounce, and attachment limits.
- Extract Provider Detail account/OAuth/model-test/routing sections only where state ownership is clear; do not move shared mutation ownership without tests.
- Split Model Picker catalog normalization from view components; retain one public picker API for existing callers.

### Batch D — warning and debt cleanup

- Investigate the CSS `backdrop-blur-[6px]` warning at the source and replace the invalid generated selector with a supported utility or explicit style if the visual result is preserved.
- Remove obsolete comments, `REQ-*` references, and imports only when they no longer describe current contracts.
- Keep the intentional Automation placeholder and its `Soon` badge.

## Interfaces and invariants

- Router exports: `router`, `guardLoader`; redirect targets remain basename-relative `/login`, `/overview`, and canonical advanced paths.
- API boundary: `api`, `apiGet`, `apiPost`, `apiPatch`, `apiDelete`; all mutation requests retain JSON bodies and same-origin credentials.
- Query boundary: all new query and invalidation sites use `qk` factories from `src/lib/query-keys.ts`.
- Component callbacks: picker `onChange`/`onToggle`, dialog `onClose`/`onConfirm`, and page mutation callbacks keep their current argument shapes.
- Async lifecycle: every EventSource, timeout, listener, and object URL created by extracted code has a matching cleanup path.

## Error handling

- Do not swallow API errors or replace them with optimistic success.
- Preserve `ApiError` status/code/message behavior and unauthorized handler invocation.
- Preserve toast error paths for mutation failures.
- Preserve lazy import reload behavior and cooldown guard.
- Tests must assert failure paths before dead code is deleted.

## Testing strategy

- Run targeted Vitest files after each batch, then `bun run test`.
- Run `bun run build` after route/file changes and after extraction.
- Use role/name-based DOM assertions for accessible behavior; avoid class-name assertions except for a component whose contract is specifically styling.
- Use fake timers only for controlled debounce/reconnect contracts and restore them in `afterEach`.
- Keep external API calls mocked at the fetch boundary with deterministic response tables; no network tests.

## Verification and rollback

Each batch is independently revertible and must leave the suite/build green. A rename batch is accepted only when no stale import or exported symbol remains and both legacy and canonical navigation scenarios pass. A component extraction is accepted only when its focused tests and the original page contract pass; if not, revert the extraction instead of weakening assertions.
