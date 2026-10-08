## Unreleased

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
