## Unreleased

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
