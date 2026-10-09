---
name: cartethyia-dashboard
description: "Build and verify dashboard/ React code: shell layout and scroll rules, social metadata injection, share pages, toasts and dialog sizing, localStorage namespacing, and headless browser verification via the browser agent (Puppeteer)."
---

# Dashboard

Use for `dashboard/` React, TanStack Query, routing, page chrome, social
metadata, share pages, and browser verification.

Dashboard code must stay browser-safe: no Elysia, database driver, filesystem,
secret, or Node-only runtime import. It calls `/console/api`; it does not import
the backend.

## Rules at a glance

- The document is the only scroll container. `.app-topbar` and `.app-sidebar`
  are sticky against it; `.app-main-column`, `.dashboard-page`, and
  `.route-enter` are not scrollers. A sticky toolbar uses
  `top: var(--topbar-height)`, not a magic number, stays opaque and shadowed,
  and sits as a sibling above scrolling content. The sidebar collapses to a
  drawer on the shell's own width (`@container app-shell`), never a viewport
  breakpoint.
- Polling lists use stable sorting with a deterministic name tiebreaker.
- Every console mutation toasts on both arms: `toast.success(...)` on success
  (short outcome, e.g. "Proxy pool created") and `toast.error(...)` with
  `getErrorMessage(error, ...)` on failure. A silent `mutate` is unfinished.
- `Dialog` sizes come from `DialogSize` (`sm 420 / md 640 / lg 880 / xl 960`)
  in `dashboard/src/components/ui/dialog.tsx`; `size` wins over `width`, and
  arbitrary `width={...}` px is legacy. `expanded` caps at 1160px
  (`dashboard/src/styles/console.css`); at `max-width: 640px` panels become
  near-full-viewport bottom sheets.
- `localStorage` keys are namespaced `cartethyia:<area>:<name>`. Read
  defensively — `typeof window` guard, vocabulary check, typed fallback — and
  never throw on stored junk.

Read `references/dashboard.md` for the social-metadata and share-page
procedure, and the verification choice matrix.

## Social metadata

There is one `dashboard/index.html` for landing, console, and share routes.
Crawlers do not execute the client bundle, so route-specific
title/description/OG/Twitter tags must be injected into served HTML by
`src/console/dashboard-assets.ts`. Use sentinel comments, HTML-escape values,
preserve the shared document, thread the pathname through document serving, and
keep CSP hashing based on the final body. Do not add another Vite HTML entry.

## Verification

Pick the tool that can actually answer:

- **Markup/layout structure only** — throwaway SSR script with every query
  seeded; assert ids, text, count, and order. SSR does not prove CSS, effects,
  or stateful interaction.
- **CSS/layout/overflow** — a real browser engine headlessly, driven through the
  browser agent (Puppeteer under the hood). Prefer it over a hand-rolled CDP
  client: it is far easier to control. Reach for raw CDP only when the browser
  agent cannot express the check. Build first, serve the built dashboard on a
  separate port, measure DOM geometry at short and tall viewports, then tear
  down the temporary browser/profile/server. If no browser runtime exists, mark
  UI verification **unverified** instead of substituting markup guesses.
- **API stubbing** — intercept only the console API pattern, read actual request
  shapes, and use a fresh browser connection when changing handlers. Never pause
  the module graph.

```bash
bun run dashboard:typecheck
bun run dashboard:build
```

Also run root `bun run typecheck` when backend-serving or shared contracts
change. Report browser verification separately from typecheck.
