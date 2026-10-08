## Unreleased

- Renaming the default API key was silently a no-op again. A clause added
  alongside the usage-floor work dropped `label` from the PATCH exactly when an
  `isDefault` key was being given a *different* name — the only rename that
  matters — so the update reached `DrizzleApiKeyStore.update()` with an empty
  `set(...)` and drizzle threw "No values to set". `test/console/api-key-default.test.ts`
  had been red since that commit. The condition is gone; the default key
  renames like any other, which is what `c2a93545` established.

- Two cases in `test/unit/attachment-integrity.test.ts` read the original
  corrupt-screenshot capture from an absolute path on the author's Desktop that
  was never committed, so the file could not be replayed on any other machine
  and the backend suite never went green. The capture is unrecoverable; the
  synthetic `png_crc_mismatch` and well-formed-PNG cases above them assert the
  same two outcomes, and a comment records where the case came from.

- Documentation is rebuilt around what the code actually is. `configuration.md`
  is generated from `CONFIG_SPEC` by `scripts/generate/config-reference.ts` and
  guarded by `test/config`, so the operator's variable list cannot drift from
  the reader that enforces it. `protocol-and-translation.md`, `providers.md`,
  and `console-api.md` are new; `documentation/README.md` indexes all eight and
  points at `.skills/`. `cartethyia-console-api` is a new skill owning console
  authoring, which no skill owned before, and `AGENTS.md` routes to it.

- Four skills and two docs told contributors to create migration `0004` or
  `0005` when both already shipped, so the next forward file would have reused a
  number a live database has recorded — and a recorded number is skipped. Both
  now say to read the highest file in `migrations/full-postgres/` instead of
  carrying a count. Also corrected: `dashboard.md` had dialog `xl` at 1160 (the
  expanded cap) where `dialog.tsx` sets 960, `provider-catalog` filed
  `resolveByokWireProfile` under `probe-phases.ts` when it is defined in
  `operations/byok-wire-profile.ts`, and `health-routing` described one 429
  path in `plan()` where `router.ts` has two.

- Dead exports removed: `getCachedQuota`, `resetBackgroundQuotaRefreshesForTests`,
  `resetSweepLogMemory`, `setPoolForTesting`, `isToleratedMissingExtension`,
  `byteLength`, `groupEvents`, `installIdPath`, `DEFAULT_PROVIDER_ROTATE_COUNT`,
  and the `ApiKey` type that duplicated `apiKeys.$inferSelect`. Each was
  verified to have no reader in `src/`, `test/`, `scripts/`, or `dashboard/`.
  `groupEvents` went alone: `emptyTotals` and `accumulate` beside it are used by
  `test/observability/cached-token-totals.test.ts`.

- `utcDayStart` and `utcMonthStart` each had two implementations — one in
  `api-keys/bucket-spend.ts`, one in `share/` — cutting the spend and usage
  windows two domains share. Both now live in `console/shared/day.ts`, with the
  reason they are UTC (the admission counters in `admission.ts` cut theirs the
  same way) carried over rather than dropped. Equivalence was checked by
  execution across boundary dates, not by inspection.

- Four wrappers in `account-health-service.ts` existed only to re-export a
  private function under a public name. The private functions now carry the
  public names, so `probe-phases.ts`, `console/providers/catalog/store.ts`, and
  `boot/dependencies.ts` are unchanged. `reportAttemptOutcome` stays: it is the
  one that invalidates the route snapshot and never throws.

- `credential-resolver.ts` carried a `token_envelope` field no caller ever set,
  so `unwrapProviderToken` was always called with `undefined`; the field and its
  plumbing are gone. `KimiModelBootstrap.tokenizer` was written on six rows and
  read nowhere. `kiroUsage` built the same ten-field envelope in both branches;
  the two branches now differ only in how they compute `[input, output]`, and
  the merge was checked against the old behaviour on fourteen boundary cases
  including an explicit-input-only response, a non-positive context percentage,
  and a measured total below the completion estimate.

- A Cursor `not_found` now cools the model down instead of being reported and
  retried forever. Cursor answers it for a model the credential's plan does not
  reach, and the adapter collapsed it into a generic 502 with no provider code,
  so the classifier filed it as `server_error` with nothing to mutate: every
  probe of an unreachable model failed and the next request dialed it again.
  It is now surfaced as `model_not_found` carrying the Connect code, and
  classified as `model_unreachable` — a verdict on one (account, model) pair,
  written to that pair's cooldown while the account stays active and routable
  for every other model it holds. Every Cursor error also carries an upstream
  origin now; the local default had made even `resource_exhausted` unable to
  cool anything.

- The Cursor catalog exposes Auto and Composer only. Grok and Claude Opus are
  dropped on evidence rather than taste: this account's plan answers
  `resource_exhausted` for the Grok rows and `not_found` for the Opus rows, so
  a catalog that listed them advertised a model no request could ever reach.

- Cursor is a bundled provider. A signed-in account dispatches chat through
  Cursor's own `agent.v1.AgentService` backend over Connect-RPC/HTTP2, with
  the deep-link login and automatic token refresh the console already drives
  for other providers. The model list comes from the account
  (`GetUsableModels`), so it reflects what that plan can actually reach. A
  caller's system message is delivered as labelled history, because Cursor
  composes the model prompt itself and discards a real system role.

- The Devin provider is removed. Its adapter, OAuth client, quota collector,
  model discovery, client-version tracking, catalog metadata, and dashboard
  icons are gone, and nothing references it. On the next boot the unowned
  `providers` row it left behind is retired and its builtin model row goes
  with it through the foreign key; telemetry history is not touched.

- `db.execute` on the SQLite backend returns the types the schema declares.
  It read through `prepare().all()` and handed back stored values, so a
  timestamp came back as text and a boolean as an integer — the mismatch that
  rejected a correct login, on the read the backup import uses to decide
  whether a row already exists. It now maps each column the way the query
  builder does. The same path dropped every interpolated value and sent the
  statement to SQLite with a hole in it; the values are bound now.

- Telemetry payload frames are gzipped. Each capture wrote its JSON to disk
  uncompressed, and the bodies are the same prompt and tool schema repeated
  per request, so the files were almost entirely repetition. A frame is now
  compressed once, at the write, and the row names that encoding as
  `jsonl-file`. A frame written before this stays `jsonb-file` and still
  reads back. The storage check accepted only the old name, so the forward
  migration widens it; on SQLite, which cannot alter a check, the table is
  rebuilt and its rows are kept.

- Console login accepts a correct password on the SQLite backend. The user
  row stores its flags as integers, and the login check requires booleans, so
  a valid account read back as no account at all and every login answered
  "Invalid credentials". The same read handed timestamps back as text where
  the schema declares `Date`. The SQLite handle now maps both on read, for
  every boolean and timestamp column, not just the login row. Reproduced with
  a user written through the setup insert and read back through the login
  query, and confirmed against the live database.

- Console login works on the SQLite backend. A wrong password writes a
  lockout row whose timestamp Drizzle binds as a `Date`, and bun:sqlite
  rejects that binding, so the login answered 500 — "the gateway hit an
  internal error" — instead of "invalid credentials". Every statement the
  handle prepares now converts a `Date` binding to the ISO string the text
  timestamp columns store. Reproduced against a real setup, then fixed.

- The Usage page counts cached tokens, not whole requests. A request with any
  cache hit had its entire input counted as cached, so the cached total, the
  cache hit rate, and the per-model and per-bucket breakdowns all read as if
  nearly every token were cached. The estimated cost was never computed from
  that total — each request is priced from its own cached and fresh split — so
  the two numbers could not be reconciled. The folds now sum
  `cached_input_tokens`.

- First-boot setup completes on the SQLite backend, and a migrated database
  reports ready. The bun-sqlite transaction builder has no `execute`, so the
  setup lock threw and the wizard answered with an internal error; the handle
  now adds `execute` to the transaction it hands the callback. The same alias
  returned only `changes()` and no rows, so the readiness check read an empty
  migration ledger and held every request at "not ready". A select through it
  now returns its rows. Found by booting Lite and sending a real request, not
  by the suite.

- A schema change now has to land in both migration sets. Every file in
  `migrations/full-postgres/` needs a same-named file in
  `migrations/lite-sqlite3/`, and `test/persistence/sqlite-baseline.test.ts`
  fails when one is missing — the baseline parity check only compared
  `0000`, so a forward migration could ship for PostgreSQL and never reach an
  existing SQLite database. The SQLite runner skips an `ADD COLUMN` whose
  column already exists, because this SQLite build rejects `ADD COLUMN IF NOT
  EXISTS`. The procedure is in the `cartethyia-schema-telemetry` skill.

- Payload capture is off by default. A tenant with no stored choice, and a
  preference read that fails, keeps nothing — previously both fell back to
  metadata capture. Depth still defaults to Minimum (1 MiB) once an operator
  turns capture on.

- Payload capture keeps less in memory, and its depth caps are smaller.
  Minimum stays 1 MiB; Moderate drops from 16 to 8 MiB and Maximum from 32 to
  16 MiB, in Settings → Capture depth. The capture used to serialize every
  body twice — once to measure, again to store — and a body past the cap was
  serialized and walked anyway before being thrown away. It now serializes
  each body once, stops at the first one that crosses the cap, and writes the
  frame from that text, so a capture holds one copy of what it keeps instead
  of two copies of everything. Reading a captured payload back reads that one
  frame instead of the whole hourly file. `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES`
  now defaults to 16 MiB and rejects anything above it.

- Lite's auth lookup no longer rebuilds its query per call. The three reads a
  cache miss makes — the key by hash, its parent by id, and the children's
  consumed sum — are prepared once when the SQLite handle is built and mapped
  back to the row shape auth reads. Measured on this machine against 200 keys,
  the hash lookup went from 0.118 ms through the query builder to 0.008 ms
  prepared. A file database also opens with WAL, `synchronous=NORMAL`, a 64 MB
  cache, and a 5 second busy timeout. PostgreSQL is untouched: it has no
  prepared statement here and still uses the builder.

- Migrations are split by backend. `migrations/full-postgres/` holds the
  PostgreSQL chain and `migrations/lite-sqlite3/` the derived SQLite baseline.
  The old `migrations/` directory is gone; runners, the supervisor, and the
  generator read the new paths.

- Lite mode now runs on embedded SQLite instead of PGlite. The database is a
  single file at `<data dir>/cartethyia.sqlite`, opened through `bun:sqlite`,
  and it carries the same tables, constraints, and indexes as the PostgreSQL
  schema — derived from it by `scripts/generate/sqlite-ddl.ts`, not written a
  second time by hand. The SQL that differs between the two backends (JSON
  merge, cooldown pruning, case-insensitive match, the usage-flush batch
  update) lives in `src/persistence/dialect.ts` and is chosen per statement.
  PGlite, its WASM assets, and the build step that copied them are gone.
  An existing PGlite data directory is not migrated: Lite has to be set up
  again. Full mode is unchanged.

- The default gateway API key is now mandatory, renamable, and undeletable.
  Three separate defects made it unmanageable, and they surfaced as one symptom
  from the console — a key that could not be touched:
  - **It was sometimes never created.** Seeding was gated on
    `CARTETHYIA_API_KEY` being set, so an install that never configured it
    booted with no gateway key and failed later, at Studio, with "the default
    gateway API key is missing". It is now always seeded, and when the variable
    is unset the secret is generated at the same strength as the encryption key
    (32 random bytes) instead of being skipped.
  - **It could not be renamed.** `label` was accepted and validated by the PATCH
    body but never copied into the patch sent to the store, so saving a new name
    was a silent no-op.
  - **It could be revoked.** Revoke did not distinguish it, so the one key
    routing depends on could be removed, stranding the installation with no way
    to authenticate. Revoke is now refused for it; rotate replaces the secret
    and keeps the key present, which is what the console offers instead.
  It is identified by a new `is_default` column rather than by its label, so
  renaming cannot break the Studio lookup and a partial unique index rejects a
  second live default per tenant. Migration `0004_api_keys_is_default.sql`
  promotes a key seeded by an earlier build, so an existing installation keeps
  its key rather than seeding a duplicate.

- Mistral and DeepSeek now carry a model catalog. Both were registered as
  generic OpenAI-compatible providers with no catalog at all, so every model
  they serve was absent from the console and unavailable to routing until a
  discovery run happened to fetch them. Mistral gets its current
  large/medium/small families plus the two Magistral reasoning rows; DeepSeek
  gets only the two V4 families still live upstream, `deepseek-v4-pro` and
  `deepseek-v4.1-flash`. 9router's capability tables — newer than its provider
  registry, which still lists eight ids — record that `v4.1-flash` replaces
  `v4-flash`, dropped from the published server list, and that
  `v4-flash-vision-exp` routes to it; `v4-pro-max` and `v4-pro-none` are
  aliases of `v4-pro`, not models of their own. All four are gone rather than
  marked. There is no `v4.1-pro` row: neither 9router nor the base catalog
  carries that id, so `v4-pro` remains the Pro row. The V3.2 families
  (`deepseek-chat`, `deepseek-reasoner`) are excluded as V3, not V4. Limits and
  pricing resolve from the base catalog via `providerId`, so no number is
  restated in the catalogs to drift — `v4-pro` reads 1000000/384000 from
  DeepSeek's own row, and `v4.1-flash`, which the base catalog files under other
  providers, resolves to 1048576/384000 through the majority row.
- Fireworks, GMI, and B.AI intentionally carry no static catalog. The base
  catalog has zero rows for all three, and 9router — the other reference — has
  none for `gmi` and gives `bai` no ids either (it serves `bai` by fetching
  `api.b.ai/v1/models` live and accepting any id). Listing ids here would mean
  inventing them, and listing them without any catalog row would publish the
  generic 200k/64k default as if it were measured. Add ids for these providers
  when a real source for them exists.
- A reseller suffix on a model id no longer hides its limits. OpenRouter lists
  `deepseek/deepseek-v4.1-flash:free`, and the `:free` — its own billing tier,
  not a different model — made the id match nothing, so a discovered free model
  published `n/a` context and output while the same id unsuffixed resolved.
  `:free` and `@variant` are now stripped before the lookup, provider-scoped
  first so OpenRouter's own row still wins over another reseller's. An id the
  catalog genuinely disagrees about still fails closed.
- A context-window overflow that an upstream reports only in prose is now
  classified as `context_length_exceeded` (413) instead of a generic
  `invalid_request` (400). WorkBuddy reports it as `code: 11115` with
  `extError.type: invalid_request_error` and the cause only in `msg`
  ("prompt is too long: 100001 tokens > 100000 maximum"), so reading
  structured identifiers alone told the client nothing it could act on:
  Claude Code compacts when it is told the prompt exceeded the window and
  does nothing on a 400 that looks like any other bad request. The prose form
  is recognized in its measured-size shape (`N tokens > M`, with `N > M`)
  and never as a bare phrase, so a message that merely quotes the phrase —
  including one the client's own prompt wrote — still does not match.
- `context_length_exceeded` is now retryable, so an overflow fails over to the
  next candidate. An overflow is a property of the window the chosen route
  offers, not of the request: a sibling on a larger window is tried verbatim
  and nothing is shrunk or rewritten. Only exhausting the candidates returns
  the 413, still carrying the measured size and ceiling.

- A buddy-family channel rejection (`400 · 11128`, "Illegal API invocation
  from an unapproved channel") now parks the account for 6 h instead of
  leaving it in rotation. It is account-wide and repeats on every invocation,
  but it used to classify as `unknown` with `mutates=false`, so the account
  kept failing and — every account failing the same way — the whole pool
  looked dead with nothing ever parked, so routing never moved to the next
  account. A suspended account ("Request illegal: Account Suspended.") is
  matched the same way.
- Reverted: the buddy family keeps its variant's fixed leading system prompt.
  Replacing it with the caller's system text made CodeBuddy (`cb`) reject every
  request with `400 · 11128 — Illegal API invocation from an unapproved
  channel`: the upstream validates the leading system prompt as the calling
  channel, so a foreign prompt reads as an unapproved client. Because every
  account failed, the whole pool was marked unhealthy. The fixed prompt is
  sent again and caller `system`/`developer` turns are dropped as before.
- Custom providers render in their own section again. The service-aware
  provider tabs (`01cfbeb4`) left a "Custom Providers" entry in the built-in
  section list while the dedicated section above it had its cards suppressed,
  so a custom provider only appeared once, in the last section at the bottom.
  The duplicate list entry is removed and the dedicated section renders its
  cards again.
- `search:invoke` is now revocable. Unchecking it on an API key used to be
  undone on the next read: `createAccessDecision` re-granted the scope to any
  key holding `routing:invoke`, so no key could ever hold routing without
  search. Migration `0040` writes the grant onto the rows that were receiving
  it implicitly, and the implicit grant is removed.
- A tenant API key can read its own request telemetry for remote debugging: a
  key holding `dashboard:read` reaches `GET /console/api/system/usage/requests`
  and `GET /console/api/telemetry/events` with `Authorization: Bearer <key>`.
  This worked before but was untested, so a change to console auth could have
  removed it silently; it is now pinned by regression tests.
- Web-search requests from chat clients (Claude Code, Codex CLI) now route
  through the selected model first: a route whose *provider* serves hosted
  search keeps its native tool, and a route that cannot serve it runs the
  query on an operator-configured search provider (exa → gemini → codex →
  tavily → brave) and continues on the selected route with the results
  injected as a user context turn. The direct `POST /v1/search` API is
  unchanged.
- Web-search capability is now a property of the provider, not the model row:
  `models.web_search` is dropped (migration `0039`), and native search is
  decided by `providerSupportsWebSearch`. Discovery previously wrote `false`
  for models it had no metadata for, which filtered capable routes out of
  native search on a metadata gap.
- Hosted search tools are translated per wire instead of being forwarded
  verbatim: Codex receives `{"type":"web_search"}` (it rejects both the raw
  Anthropic payload and `web_search_preview`), and an [OI]-compatible wire
  receives `web_search_preview`. A bare `{"type":"web_search"}` declaration
  on `/v1/chat/completions` is now recognized and no longer dropped.
- The provider-detail "Test search" control now shows the probe's latency,
  result count, and the normalized hits (or the upstream error) instead of a
  bare pass/fail line.
