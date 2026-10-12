# Changelog

All notable changes to Cartethyia are recorded here. Entries are written for the
operator who reads them, not for the contributor who wrote the diff: what
changed, and what it means for an install. Migration numbers refer to files
under `migrations/full-postgres/` and their same-named SQLite twins.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## 2.2 Zhezhi

Released 2026-10-12.

### Added

**Providers**

- 28 providers added, in three auth shapes.
- **API key, live discovery.** `groq`, `together`, `deepinfra`, `siliconflow`,
  `siliconflow-cn`, `novita`, `venice`, `nanogpt`, `baseten`, `synthetic`,
  `stepfun`, `sakana`, `helmcode`, `coralbricks`, `aiand`, `wafer-serverless`,
  `qianfan`, `coreweave`, `qwen-portal`, `zhipu-coding-plan`, `umans`,
  `minimax`, `minimax-code`, `minimax-code-cn`, `firepass`. Each lists its
  models from the provider's own `/v1/models` rather than a restated catalog,
  with limits and pricing resolved from the bundled `base-models.json` rows.
- **OAuth.** `factory-droid` signs in with the WorkOS device-code grant and
  keeps a real refresher — the access token expires with its JWT, and the
  organization claim that Factory requires on every call travels with it.
  `cloudflare-ai-gateway` and `alibaba-coding-plan` take a pasted credential
  instead: the gateway needs the account and gateway slugs that form its base
  URL, and the Alibaba plan needs the region that selects which of two hosts
  serves it. Neither has a refresh grant, so neither registers a refresher.
- Provider-specific wire rules that are not a bare bearer: `coreweave` sends the
  `OpenAI-Project` header from account state, `qwen-portal` coalesces multiple
  system messages into one (the portal answers 500 otherwise), `minimax*` and
  `umans` serve Anthropic Messages rather than OpenAI chat, and `firepass`
  carries a Kimi context cap.
- The dashboard's **Fetch models** control now appears for any provider that
  registers a discovery resolver, instead of only for custom ones. A bundled
  provider with no resolver still shows no button; nothing that worked before
  changes.

**CLI and system tray**

- The package installs globally as `cartethyia` and `carte`. `cartethyia setup`
  still runs the configuration wizard; `carte` starts Cartethyia in the system
  tray instead of a foreground terminal.
- The tray menu carries the running version, a link to the repository, a version
  tracker that reads the npm registry, and entries for the Console, a password
  reset, and backup/restore — both of which open Console Settings, so neither
  action duplicates a flow the Console already owns. Exit drains the gateway
  through the authenticated `POST /admin/drain` route and waits for in-flight
  requests instead of killing the process.
- Choosing the update entry installs `cartethyia@latest` through npm and relaunches
  the tray, confirming readiness over a one-shot signal file before the old
  process exits. An install that fails restarts the current version instead of
  leaving the operator with nothing running.
- Tray launches detach and hide their window, so no console stays attached
  behind the tray icon; the launching terminal prints `Loading Cartethyia…` and
  the URL once `/health` reports ready.

**Media generation**

- `POST /v1/images/generations` is a separate service from chat, with its own
  dispatch path and body envelope. Chat turn headers, turn metadata, and routing
  hints are not sent on it.
- Provider-owned image wires: Gemini asks `:generateContent` for `IMAGE` and
  reads `inlineData`; Antigravity streams its agent envelope and reads
  `inlineData`; Codex sends a Responses `image_generation` tool on a dedicated
  image path and decodes streamed frames.
- A video generation route is mounted, and a custom provider can declare image
  or video as a service kind.
- Buddy image models are served by CodeBuddy and WorkBuddy only.

**Providers**

- Web-session providers (Claude Web, Grok Web, Kimi Web) use pasted sessions and
  static catalogs. Grok accepts only `bash`, `readFile`, `webSearch`, and
  `browsePage`; Kimi accepts no function tools.
- The provider list gains collapsible sections, and custom providers render in
  their own section again.
- Direct egress resolves through the OS resolver, so a pool on a VPN is not
  misclassified as a dead proxy.

**Web search**

- A chat web-search query routes through the selected model first. A route whose
  *provider* serves hosted search keeps its native tool; a route that cannot serve
  it runs the query on an operator-configured search provider and continues on the
  selected route with the results injected as a user context turn. The direct
  `POST /v1/search` API is unchanged.
- Web-search capability is a property of the provider rather than a column on the
  model row. A discovery gap could previously filter a capable route out of
  native search.
- Hosted search tools are translated per wire instead of forwarded verbatim —
  Codex receives `{"type":"web_search"}`, an `[OI]` wire receives
  `web_search_preview`, and a bare `web_search` declaration on
  `/v1/chat/completions` is recognized rather than dropped.
- The provider-detail "Test search" control reports the probe's latency, result
  count, and normalized hits (or the upstream error) instead of a pass/fail line.

**Console**

- A batch account import is one round-trip instead of one per account.
- Backup export writes compressed raw connections.
- The dashboard adds a privacy mode that masks proxy and account values, and the
  quota controls get their own panel.

**Durability**

- A schema change must land in both migration sets. Every file in
  `migrations/full-postgres/` needs a same-named file in
  `migrations/lite-sqlite3/`, and `test/persistence/sqlite-baseline.test.ts`
  fails when one is missing — the parity check previously compared `0000` only, so
  a forward migration could ship for PostgreSQL and never reach an existing SQLite
  database.

### Changed

- `scripts/` is grouped by purpose rather than by mixed role: `cli/` (the global
  commands, launchers, setup wizard, and doctor), `operations/` (start, restart,
  health sweeps), `install/` (the host-level shell installer), `build/`, `generate/`,
  `dev/`, `test/`, and `shared/`. `scripts/ci-run-tests.ts` is now
  `scripts/test/run.ts`, `scripts/install-lite.sh` is `scripts/install/lite.sh`,
  and `scripts/internal/env.ts` is `scripts/shared/env.ts`. No script changed
  behavior; only its path did.
- The release build sequence moved out of a chained `package.json` string into
  `scripts/build/build.ts`, which names each step and stops at the first failure
  instead of relying on `&&`.
- The npm package description is now a full paragraph naming the proxy, both
  protocols, and the delivery engine behind the endpoint, instead of a single
  line.
- Documentation no longer embeds a copy of the Lite installer.
  `documentation/installation.md` links the canonical
  `scripts/install/lite.sh` and describes what it does; the inlined copy had
  already drifted from the script it claimed to reproduce.

- A fresh profile's glass is retuned so cards read as glass over the page
  background while the chrome framing them stays lighter. Cards ship clarity 45 /
  blur 20 (an 11px backdrop blur), sidebar and topbar clarity 25 / blur 10
  (7.5px) — was 70/5 and 67/67, which made the chrome the blurriest surface on
  screen. Existing saved profiles keep their own values; only the default moved.
- DeepSeek now dispatches on its Anthropic Messages wire
  (`https://api.deepseek.com/anthropic` + `/v1/messages`, `x-api-key`) instead of
  the OpenAI chat wire. The `/v1/models` OpenAI-compatible discovery still reads
  from the provider's bare host, so the two surfaces stay separate. The Anthropic
  adapter takes an explicit provider id so the registry's identity check and the
  provider-keyed quirks resolve against DeepSeek, not the Anthropic builtin.
- The dashboard stylesheet cutover is complete. `console.css`, `landing.css`, and
  `share.css` are gone; the tree is `tokens.css` (tokens), `base.css`
  (reset/elements), and `app.css` (the irreducible set plus the shell frame). One
  dialect styles every surface: token → utility → primitive. The type scale is
  role-named (`micro`/`badge`/`caption`/`body`/`body-lg`/`lead`/`title`/`display`/
  `hero`) at a 2px spacing step, and radii, shadows, stacking, and named viewport
  breakpoints are tokens rather than literals. All 464 static inline styles are
  gone, and 462 arbitrary literal utilities are down to 79, both held by a
  ratchet that no file may exceed (`dashboard/style-guard.json`).
- `Model Lab` is the Studio surface: the old playground is retired from both the
  console and the dashboard (`0011_drop_studio_sessions.sql`), and routed models
  are chatable.
- Buddy protocol, cache, quota, and tool recovery are aligned across the
  CodeBuddy, CodeBuddy CN, and WorkBuddy variants.
- Stop-reason mapping is consolidated per wire family.
- The default gateway API key is identified by a new `is_default` column
  (`0004_api_keys_is_default.sql`) rather than by its label, so renaming cannot
  break the Studio lookup, and a partial unique index rejects a second live
  default per tenant. The migration promotes a key seeded by an earlier build.
- Docker Compose reads its bundled Redis address from `CARTETHYIA_REDIS_URL`, so a
  host-oriented `REDIS_URL=redis://localhost:6379` in `.env` cannot enter the
  container. PostgreSQL remains external.
- Invalid-model IP bans use a 30-minute sliding window: ten hits inside it ban the
  address for 6 hours. A valid request no longer resets the count.
- Payload frames are gzipped at the write, and the storage check widens to the new
  encoding; a frame written before this stays readable.
- Documentation is split into `reference/` (indexes, one page per layer) and
  `features/` (narrative per feature), with the entry pages at the root.
- The agent guide names `agent-browser` as the mandatory tool for UI verification
  and consolidates the gate list into one owner.

### Removed

- The pasted web-session providers `claude-web`, `grok-web`, and `kimi-web`, with
  the `shared/web-session` module only they used. `mimodesktop` and `mimostudio`
  are the remaining signed-in-session providers and now share the console's
  "Web Session Providers" section on their own.

### Fixed

**Providers**

- A rejected credential now says what the operator can actually do. `Re-login
  required` was rendered for every `auth_invalidated` account, which is only
  true of an OAuth one; a BYOK API key has no login to return to, and the row
  sent the operator after a sign-in button their provider does not have. An API
  key now reads `Replace API key`.
- A declared endpoint path is no longer rewritten against the provider's base
  URL. The strip existed so `https://api.openai.com/v1` plus
  `/v1/chat/completions` would not join into `/v1/v1/chat/completions`, and it
  hid the fact that 13 bundled providers declared exactly that doubled path. The
  specs now declare the path below the version root they actually sit under, so
  a wrong path reaches the operator as the wrong URL instead of being quietly
  corrected into a different address.

**Packaging**

- The root manifest version was `2.2.0` while the dashboard manifest carried
  `2.2`, so the version guard failed and the Console and tray header disagreed
  with the published package. The root is now `2.2`.

**Gateway**

- A pasted full endpoint in a BYOK Base URL no longer breaks discovery. The model
  list was derived from the whole pasted path, so
  `https://api.deepseek.com/anthropic/v1/messages` discovered at
  `…/anthropic/v1/messages/models` (404). The endpoint tail is now stripped and the
  root is used, the connection test says what it corrected, and the dashboard form
  shows the root to save. The wire derivation is unchanged — a `messages` base still
  reads `x-api-key`.
- `search:invoke` is now revocable. It was implicitly re-granted on every read, so
  no key could hold `routing:invoke` without search.
- A context-window overflow reported only in prose is classified as
  `context_length_exceeded` (413) instead of a generic `400`, and is retryable — an
  overflow is a property of the chosen route's window, so failover tries a sibling
  on a larger window verbatim. Only exhausting the candidates returns the 413.
- A reseller suffix on a model id (`:free`, `@variant`) no longer hides its limits.
  Stripped provider-scoped first, so OpenRouter's own row still wins.
- A mistyped Redis IP-abuse key is deleted and the request is recounted; a live ban
  or limit still applies. Redis being unreachable remains a 503.
- Buddy credit exhaustion is a hard `quota_exhausted` cooldown for 12 hours, and a
  buddy-family channel rejection (`400 · 11128`) parks the account for 6 hours
  instead of leaving it in rotation. The existing sweep restores both.
- Inline `<think>` tags split across SSE chunks stay one reasoning span across
  chat, completion, Responses, and Messages.
- A plain-HTTP `CARTETHYIA_PUBLIC_ORIGIN` keeps the console session cookie
  non-Secure even when the production binary has `NODE_ENV` baked in.
- Direct egress resolves through the OS resolver, so a pool on a VPN is not
  recorded as a hang.
- A regional model rejection now cools the account; a proxy VPN hang is recorded as
  such.
- The buddy family keeps its variant's fixed leading system prompt — replacing it
  with the caller's system text made every request fail as an unapproved channel.

**Console and dashboard**

- The default gateway API key renames. A later clause had dropped `label` from the
  PATCH exactly when an `isDefault` key was given a different name, so the update
  reached the store with an empty `set(...)`.
- The Usage page counts cached tokens, not whole requests — a request with any
  cache hit had its entire input counted as cached.
- Account rows, proxy masking, the usage headline, and the quota panel are
  tightened; nested cards stay clear and proxy tables stay consistent.
- Active OAuth and JWT account badges are distinguished.
- Model Lab turns stay readable after reload.
- System health is restored and the background toggle behaves.
- A late import, `tailwind-merge`, dropped a role font size when a colour utility sat
  beside it — `cn("text-badge", "text-text-secondary")` silently emitted only the
  colour.

**Removed**

- `scripts/commands/grok-health-sweep.ts`, an unreferenced operator tool that
  probed Grok accounts one by one for the `407` exhaustion signal. Nothing ran it
  and nothing imported it. The 407 probe itself is unchanged —
  `src/providers/discovery/probe-phases.ts` and its coverage in
  `test/providers/grok-feature-probe.test.ts` remain — so the gateway reads Grok
  exhaustion exactly as before.
- The Cursor and Devin providers, with their adapters, OAuth clients, quota
  collectors, discovery, catalog metadata, and dashboard icons. On the next boot
  each unowned `providers` row is retired and its builtin model rows cascade away;
  telemetry history is untouched.
- The Studio playground surface and its sessions table.
- Verified dead exports: `getCachedQuota`, `resetBackgroundQuotaRefreshesForTests`,
  `resetSweepLogMemory`, `setPoolForTesting`, `isToleratedMissingExtension`,
  `byteLength`, `groupEvents`, `installIdPath`, `DEFAULT_PROVIDER_ROTATE_COUNT`, and
  the `ApiKey` type that duplicated `apiKeys.$inferSelect`.

### Migration notes

- `0004_api_keys_is_default.sql` — the default gateway API key is identified by a
  column, not its label. An install keeps its existing key; a second live default
  per tenant is rejected.
- `0005_payload_jsonl_storage.sql` — widens the payload-frame storage check to accept
  gzipped frames. On SQLite the table is rebuilt and its rows kept.
- `0010_account_identity_enrichment.sql` — adds the account identity a batch import
  now returns in one round-trip.
- `0011_drop_studio_sessions.sql` — drops the retired Studio sessions table.

Each has a same-named SQLite twin under `migrations/lite-sqlite3/`.