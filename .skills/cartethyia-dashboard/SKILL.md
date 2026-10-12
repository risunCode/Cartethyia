---
name: cartethyia-dashboard
description: "Build and verify dashboard/ React code: shell layout and scroll rules, the token → utility → primitive styling dialect, social metadata injection, share pages, toasts and dialog sizing, localStorage namespacing, and real-browser verification of visual or interactive behavior through the agent-browser CLI."
---

# Dashboard

Use for `dashboard/` React, TanStack Query, routing, page chrome, social
metadata, share pages, and browser verification.

Dashboard code must stay browser-safe: no Elysia, database driver, filesystem,
secret, or Node-only runtime import. It calls `/console/api`; it does not import
the backend.

## Rules at a glance

- The document is the page scroll container; the sidebar/navigation and
  contained surfaces can scroll independently. `.app-topbar` and the desktop
  `.app-sidebar` stick at the shell's 16px inset; the narrow-shell sidebar is a
  fixed drawer. `.app-main-column`, `.dashboard-page`, and `.route-enter` are
  not scrollers. Keep the topbar opaque and shadowed as a sibling above page
  content. The sidebar collapses at its own `@container app-shell` width
  (currently 860px), not a viewport breakpoint.
- A card blurs only what is painted behind it in the same group. `BackgroundLayer` mounts inside `.app-main-column`, and `.route-enter` must not animate `opacity`, `transform`, or `filter` — any of those groups the page and the card blurs black instead of the image. `contain` other than `none` on `.custom-background` does the same, and also makes a `fixed` layer scroll. Clarity (`--blur-cards`) and blur (`--blur-cards-depth`) are separate; never let one slider write both.
- Polling lists use stable sorting with a deterministic name tiebreaker.
- User-initiated console mutations should report both outcomes: use
  `toast.success(...)` on success (short outcome, e.g. "Proxy pool created") and
  `toast.error(...)` with `getErrorMessage(error, ...)` on failure. A deliberately
  quiet or automated path may suppress toasts.
- `Dialog` sizes come from `DialogSize` (`sm 420 / md 640 / lg 880 / xl 960`)
  in `dashboard/src/components/ui/dialog.tsx`; `size` wins over `width`, and
  arbitrary `width={...}` px is supported but existing usage should be checked
  before standardizing it. `expanded` caps at 1160px
  (`dashboard/src/styles/app.css`); at `max-width: 640px` dialogs stay centered
  with reduced viewport margins. `Drawer` becomes a full-viewport panel.
- New persisted UI preferences should use namespaced
  `cartethyia:<area>:<name>` keys. Existing keys include older formats; follow
  the owning helper and do not rename persisted keys incidentally. Read
  defensively for SSR, unavailable storage, invalid values, and junk. Issued
  share keys are stored in IndexedDB rather than localStorage.

Read `references/dashboard.md` for the social-metadata and share-page
procedure, and the verification choice matrix.

## Styling contract

One styling dialect: **token → utility → primitive**. A visual decision lives in
exactly one place, so changing a token in `styles/tokens.css` restyles every
page. The layer that owns a fact decides where a change goes.

| Need | Use | Never |
|---|---|---|
| Colour, spacing, radius, type, shadow, z-index | the token → its utility (`bg-surface-1`, `gap-4`, `rounded-card`, `text-text-secondary`) | new page-level literals where an existing token or utility expresses the value |
| A repeated visual (toolbar, stat, list row, form field, banner, …) | the `ui/` atom or `patterns/` block that owns it | duplicating an existing atom or pattern in the page |
| A value computed at runtime (a bar width from state, a colour from data) | an inline `style` | — |
| Something a utility cannot express (keyframe, `backdrop-filter: blur(calc())`, `@container`, scroll region) | a named class in `styles/app.css` whose values are tokens | a utility forced to fit |

Current stylesheet ownership:

- `styles/tokens.css` — theme mappings and custom-property values; no component selectors.
- `styles/base.css` — reset and document defaults plus shared component-layer rules (for example controls, cards, and contained scroll regions).
- `styles/app.css` — shell frame and irreducible application layout, effects, and animations.
- `components/ui/` — atoms with variant props, primarily composed from utilities.
- `components/patterns/` — composed blocks built from atoms.
- `features/` — page composition, data, and utility classes; move repeated visuals into their owning atom or pattern.

Spacing is `--spacing: 2px`, so `gap-N` is `2N`px: `gap-[8px]` is `gap-4`,
`gap-[12px]` is `gap-6`. Current radius tokens are 9px for `rounded-control`
and 12px for `rounded-card`. Prefer the token-backed utility; use a named
stylesheet rule for a value the utility system cannot express.

`dashboard/test/style-guard.test.ts` and `dashboard/style-guard.json` enforce
the inline-style/arbitrary-utility ratchet: no file may exceed the recorded
counts, and a file absent from the manifest must be at zero. Lower the number
in the same commit that migrates a file, with
`STYLE_GUARD_UPDATE=1 bun test dashboard/test/style-guard.test.ts`.

## Social metadata

There is one `dashboard/index.html` for landing, console, and share routes.
Crawlers do not execute the client bundle, so route-specific
title/description/OG/Twitter tags must be injected into served HTML by
`src/console/dashboard-assets.ts`. Use sentinel comments, HTML-escape values,
preserve the shared document, thread the pathname through document serving, and
keep CSP hashing based on the final body. Do not add another Vite HTML entry.

## Verification

For dashboard changes that make a visual, layout, computed-style, focus,
overflow, or interaction claim, verify it with `agent-browser` yourself when
available. Documentation-only changes and checks unrelated to browser behavior
do not need a browser run. Do not delegate UI verification or write a harness
around the CLI — `open`, `eval`, `click`, `fill`, `press`, `wait`, `set viewport`,
`set media`, `storage local set`, `network route`, `screenshot`, `console`, and
`errors` cover the checks below. A claim about layout, computed style, focus, or
overflow that was not measured with `eval` is unverified, whatever else is green.

**Console surfaces need a sign-in.** `bun run dev:console-auth` does it from
`CARTETHYIA_DEV_ADMIN_PASSWORD` through the real form, after which plain
`agent-browser` commands share that browser already signed in. See
`references/dashboard.md` "Authenticated console session" — it also covers the
fresh-database `/console/setup` wizard and which origin serves what.

Pick the tool that can actually answer:

- **Markup/layout structure only** — throwaway SSR script with every query
  seeded; assert ids, text, count, and order. SSR does not prove CSS, effects,
  or stateful interaction.
- **CSS/layout/overflow** — `agent-browser`. Build first, serve the
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
