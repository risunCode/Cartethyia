# Dashboard development and verification

Use for `dashboard/` React, TanStack Query, routing, page chrome, social metadata,
share pages, and browser verification. Dashboard code must remain browser-safe: no
Elysia, database, filesystem, secrets, or Node-only runtime imports.

## Layout rules

- `.app-main-column` is the only scroll container.
- `.app-topbar` is sticky inside it; `.dashboard-page` and `.route-enter` are not scrollers.
- A sticky toolbar uses `top: var(--topbar-height)`, not a magic number.
- The toolbar stays opaque and shadowed, as a sibling above scrolling content.
- Polling lists must use stable sorting with a deterministic name tiebreaker.

## Social metadata

There is one `dashboard/index.html` for landing, console, and share routes. Crawlers
do not execute the client bundle, so route-specific title/description/OG/Twitter tags
must be injected into served HTML by `src/console/dashboard-assets.ts`.

Use sentinel comments, HTML-escape values, preserve the shared document, thread the
pathname through document serving, and keep CSP hashing based on the final body. Do
not add another Vite HTML entry. Verify the built document and live route responses.

## Share page

Keep share data and token units sourced from one provider. Public recipients may copy
model ids but must not receive admin controls such as probe, enable, disable, or delete.
Treat theme, backdrop, responsive layout, and model grouping as UI behavior to verify.

## UI feedback and modal scale

- Every console mutation toasts on both arms: `toast.success(...)` on success
  (short outcome, e.g. "Proxy pool created"), `toast.error(...)` with
  `getErrorMessage(error, ...)` on failure. Never ship a silent `mutate`.
- `Dialog` sizes come from `DialogSize` (`sm 420 / md 640 / lg 880 / xl 1160`);
  arbitrary `width={...}` px is legacy. `expanded` caps at 1160; on
  `max-width: 640px` panels become near-full-viewport bottom sheets.
- `localStorage` keys are namespaced `cartethyia:<area>:<name>`
  (`cartethyia:provider:<id>:thinking-effort`, `cartethyia:overview:low-stress`).
  Read defensively (`typeof window` guard, vocabulary check, typed fallback);
  never throw on stored junk.


## Verification choice

- Markup/layout structure only: use a throwaway SSR script with every query seeded;
  assert ids, text, count, and order. SSR does not prove CSS, effects, or stateful interaction.
- CSS/layout/overflow: use a real browser engine headlessly whenever Edge/Chrome
  CDP is available; do not require a visible browser window. Build first, serve
  the built dashboard on a separate port, measure DOM geometry at short and tall
  viewports, inspect screenshots, then tear down the temporary browser/profile/server.
  If no CDP-capable browser exists, mark UI verification unverified instead of
  substituting markup guesses.
- API stubbing: intercept only the console API pattern, read actual request shapes,
  and use a fresh browser connection when changing handlers. Never pause the module graph.

## Gates

```bash
bun run dashboard:typecheck
bun run dashboard:build
```

Also run root `bun run typecheck` when backend-serving or shared contracts change.
Report browser verification separately from typecheck.
