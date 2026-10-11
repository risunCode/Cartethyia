---
name: cartethyia-dashboard
description: "Build and verify dashboard/ React code: shell layout and scroll rules, the token → utility → primitive styling dialect, social metadata injection, share pages, toasts and dialog sizing, localStorage namespacing, and mandatory real-browser verification through the agent-browser CLI."
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
- A card blurs only what is painted behind it in the same group. `BackgroundLayer` mounts inside `.app-main-column`, and `.route-enter` must not animate `opacity`, `transform`, or `filter` — any of those groups the page and the card blurs black instead of the image. `contain` other than `none` on `.custom-background` does the same, and also makes a `fixed` layer scroll. Clarity (`--blur-cards`) and blur (`--blur-cards-depth`) are separate; never let one slider write both.
- Polling lists use stable sorting with a deterministic name tiebreaker.
- Every console mutation toasts on both arms: `toast.success(...)` on success
  (short outcome, e.g. "Proxy pool created") and `toast.error(...)` with
  `getErrorMessage(error, ...)` on failure. A silent `mutate` is unfinished.
- `Dialog` sizes come from `DialogSize` (`sm 420 / md 640 / lg 880 / xl 960`)
  in `dashboard/src/components/ui/dialog.tsx`; `size` wins over `width`, and
  arbitrary `width={...}` px is legacy. `expanded` caps at 1160px
  (`dashboard/src/styles/app.css`); at `max-width: 640px` dialogs stay centered
  with reduced viewport margins. `Drawer` becomes a full-viewport panel.
- `localStorage` keys are namespaced `cartethyia:<area>:<name>`. Read
  defensively — `typeof window` guard, vocabulary check, typed fallback — and
  never throw on stored junk.

Read `references/dashboard.md` for the social-metadata and share-page
procedure, and the verification choice matrix.

## Styling contract

One styling dialect: **token → utility → primitive**. A visual decision lives in
exactly one place, so changing a token in `styles/tokens.css` restyles every
page. The layer that owns a fact decides where a change goes.

| Need | Use | Never |
|---|---|---|
| Colour, spacing, radius, type, shadow, z-index | the token → its utility (`bg-surface-1`, `gap-4`, `rounded-card`, `text-text-secondary`) | a hex, `rgba()`, or `Npx` literal |
| A repeated visual (toolbar, stat, list row, form field, banner, …) | the `ui/` atom or `patterns/` block that owns it | flex/grid hand-rolled in the page |
| A value computed at runtime (a bar width from state, a colour from data) | an inline `style` | — |
| Something a utility cannot express (keyframe, `backdrop-filter: blur(calc())`, `@container`, scroll region) | a named class in `styles/app.css` whose values are tokens | a utility forced to fit |

Layers, and what each may contain:

- `styles/tokens.css` — `--*` definitions only. No selectors, no classes.
- `styles/base.css` — reset and element defaults (`html`, `body`, `#root`, scrollbars, `::selection`, `:focus-visible`). No feature class.
- `styles/app.css` — only the irreducible set above, plus the shell frame (topbar/sidebar grid).
- `components/ui/` — atoms with variant props; utility-only, no page styling.
- `components/patterns/` — composed blocks built from atoms.
- `features/` — composition of atoms and blocks plus data. No local styling.

Spacing is `--spacing: 2px`, so `gap-N` is `2N`px: `gap-[8px]` is `gap-4`,
`gap-[12px]` is `gap-6`. Radius literals map to `rounded-control` (10px) and
`rounded-card` (14px). Do not add a second style beside one that exists; extend
the atom or block that owns the pattern.

`test/style-guard.test.ts` enforces this as a ratchet: no file may exceed the
static-inline or arbitrary-utility count recorded for it in
`style-guard.json`, and a file absent from the manifest must be at zero. Lower
the number in the same commit that migrates the file, with
`STYLE_GUARD_UPDATE=1 bun test test/style-guard.test.ts`.

## Social metadata

There is one `dashboard/index.html` for landing, console, and share routes.
Crawlers do not execute the client bundle, so route-specific
title/description/OG/Twitter tags must be injected into served HTML by
`src/console/dashboard-assets.ts`. Use sentinel comments, HTML-escape values,
preserve the shared document, thread the pathname through document serving, and
keep CSP hashing based on the final body. Do not add another Vite HTML entry.

## Verification

**`agent-browser` is mandatory for any dashboard or UI work**, and you drive it
yourself. Do not delegate browser verification to a subagent, and do not write a
harness around the CLI — `open`, `eval`, `click`, `fill`, `press`, `wait`,
`set viewport`, `set media`, `storage local set`, `network route`,
`screenshot`, `console`, `errors` cover the checks below. A claim about layout,
computed style, focus, or overflow that was not measured with `eval` is
unverified, whatever else is green. Never substitute markup guesses.

Pick the tool that can actually answer:

- **Markup/layout structure only** — throwaway SSR script with every query
  seeded; assert ids, text, count, and order. SSR does not prove CSS, effects,
  or stateful interaction.
- **CSS/layout/overflow** — `agent-browser`, always. Build first, serve the
  built dashboard on a spare port, set the viewport, then measure
  `getBoundingClientRect()` and `getComputedStyle()` through `eval` at both a
  desktop and a narrow viewport, in both themes. Tear down the session, the
  server, and any scratch file when done. If no browser runtime exists, mark
  UI verification **unverified** instead of substituting markup guesses.
- **API stubbing** — intercept with `agent-browser network route`, read actual
  request shapes, and use a fresh session when changing handlers. Never pause
  the module graph.

```bash
bun run dashboard:typecheck
bun run dashboard:build
```

Also run root `bun run typecheck` when backend-serving or shared contracts
change. Report browser verification separately from typecheck.
