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
   `CARTETHYIA_DEV_ADMIN_PASSWORD`), and measures through the browser agent
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
and `CARTETHYIA_DEV_ADMIN_PASSWORD=… bun scripts/dev/visual-baseline.ts
compare` (which must stay green while a step only re-expresses styling, and is
re-captured in the scale-normalization step that intentionally changes pixels).

That script reads `CARTETHYIA_DEV_ADMIN_PASSWORD` (required), plus
`CARTETHYIA_DEV_ADMIN_USER`, `CARTETHYIA_VISUAL_PORT`, and
`CARTETHYIA_BROWSER_AGENT` when set. They are dev-tooling only — no runtime
path reads them, so they are absent from `CONFIG_SPEC` and
`documentation/reference/configuration.md` — and are listed in `.env.example`
under "Dev console admin". The password is an operator credential: take it from
the environment, never from a message.

`agent-browser` is what every UI claim is measured through, including this
script's own measurements; a page can also be measured by driving the CLI
directly, which is the normal path when no gateway credential is available.

## Authenticated console session

The console needs a sign-in, and the credential is an operator password — so it
comes from the environment and is never typed into a message. One command does
the whole thing:

```bash
bun run dev:console-auth
```

It reads `CARTETHYIA_DEV_ADMIN_USER` (default `admin`) and
`CARTETHYIA_DEV_ADMIN_PASSWORD`, signs in through the **real form on the real
route**, and exits non-zero naming what is missing when either the stack is down
or the password is unset. Nothing secret is printed — no password, no session
token.

Afterwards, plain `agent-browser` commands share the same browser and are
already signed in, so the rest of the verification is ordinary CLI work:

```bash
agent-browser eval "!!document.querySelector('button[aria-label=\"Sign out\"]')"
```

Three things worth knowing before it looks broken:

- **It deliberately uses the CLI's default session**, not a named one, and no
  `--idle-timeout`. Each `--session` is an isolated browser with its own
  cookies, so a named session would leave the agent's own unfangled commands
  signed out; the CLI's default idle timeout is one hour, which is what an
  interactive session wants. (`scripts/dev/visual-baseline.ts` does the opposite
  on purpose — it owns its browser start to finish.)
- **A fresh dev database lands on `/console/setup`, not `/console/login`**, and
  the wizard is the only real way an account comes to exist. `signInToConsole`
  in `scripts/dev/console-auth.ts` resolves all three terminal states
  (`setup` / `login` / already-`shell`), which is why re-running the command is
  safe and a no-op.
- **5173 serves `dashboard/src` with HMR; 12800 serves the built bundle** from
  `dist/dashboard` and needs `bun run dashboard:build` after an edit. The
  command defaults to 5173 and takes an origin argument for the other.

Sign-in, credential resolution, and the `agent-browser` CLI plumbing live in
`scripts/dev/console-auth.ts`, shared with `visual-baseline.ts` so there is one
implementation. No production code is touched and no auth gate is weakened: it
is the same form an operator fills, reached with a credential from the
environment.

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
