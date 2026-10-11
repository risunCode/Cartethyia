# Dashboard reference

Procedure detail for the share page, social-metadata injection, and verification
choice. Summary rules live in `../SKILL.md`.

## Styling migration

The dashboard styling uses one dialect — token → utility → primitive.
The current inventory:

- CSS is three files: `styles/tokens.css` (tokens), `styles/base.css`
  (reset/elements), `styles/app.css` (irreducible + shell frame). The old
  `console.css`, `landing.css`, and `share.css` are dissolved into utilities and
  components.
- Repeated visuals become `components/ui/` atoms or `components/patterns/`
  blocks. A page composes them; it does not restyle them.

Order of work, so a step never lands blind:

1. `test/style-guard.test.ts` + `style-guard.json` hold the ratchet.
2. `scripts/dev/visual-baseline.ts` covers the console pages: it builds the
   dashboard, boots the real gateway (serving the built dist and `/console/api`
   on one origin), signs in through the real form (`admin`; password from
   `CARTETHYIA_VISUAL_ADMIN_PASSWORD`), and measures through the browser agent
   (`agent-browser`, not a hand-rolled CDP client). Live-by-nature answers are
   stubbed at the browser so they cannot drift a comparison: `/system/health`,
   `/updates/release`, the `/system/usage/*` and `/quota/overview` telemetry, the
   `/logs` snapshot+stream, and the discovery-derived fields of
   `/console/api/providers` (`clientVersion`, `routeIdentityVersions`) that the
   background npm/PyPI monitor fills. Client-side non-determinism is pinned by
   an init script too:
   - `Math.random` is pinned to **one fixed draw**, not a sequence. The Model Lab
     draws its session name twice — once in the `useState` initializer and again
     when IndexedDB hydration replaces the session — so a sequence still lets the
     chip's title change width mid-load, and when both names are the same length
     the document's text length is unchanged and `settle` cannot see the swap.
   - `Date.now` is pinned to a fixed instant (React Query's `dataUpdatedAt`,
     which the Quota page renders as a `HH:MM` stamp). This is a client clock, so
     no response stub can pin it.
   - The landing and share pages load star/fork counts as live-width images from
     the badge host; their `src` is rewritten to a fixed-size local `data:` SVG
     before the element is created (CSP already admits `data:` in `img-src`).
     They arrive as images, so they are invisible to the in-flight `fetch`
     counter that `settle` waits on.
   Everything else stays live.
3. Build or revise the `ui/` atom, then the `patterns/` block, before the pages
   that use it.
4. Migrate one page per commit, worst-first; lower its `style-guard.json` entry
   in the same commit.

Verification per step: `bun run dashboard:typecheck`, `bun run dashboard:test`,
and `CARTETHYIA_VISUAL_ADMIN_PASSWORD=… bun scripts/dev/visual-baseline.ts
compare` (which must stay green while a step only re-expresses styling, and is
re-captured in the scale-normalization step that intentionally changes pixels).

## Share page

Keep share data and token units sourced from one provider. Public recipients may
copy model ids but must not receive admin controls such as probe, enable,
disable, or delete. Treat theme, backdrop, responsive layout, and model grouping
as UI behavior to verify.

## Social metadata injection

One `dashboard/index.html` serves landing, console, and share routes. Crawlers
do not execute the client bundle, so route-specific tags must be injected into
served HTML by `src/console/dashboard-assets.ts`:

1. Use sentinel comments to mark the replaceable region.
2. HTML-escape every injected value.
3. Preserve the shared document; do not branch per route in Vite.
4. Thread the pathname through document serving.
5. Keep CSP hashing based on the **final** body, after injection.

Do not add another Vite HTML entry. Verify the built document and live route
responses, not only the source.
