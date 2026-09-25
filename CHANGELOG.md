# Changelog

## Unreleased

> All changes below are pre-release. Cartethyia has not been tagged or
> released; this document reflects the current production codebase architecture and capabilities.

### Abuse admission costs one Redis round trip per request

The per-IP abuse check read the ban, incremented the route window, and
incremented the identity-wide escalation counter as three separate Redis calls
(four once a ban fired). They are now one static Lua script over the three keys,
so an admitted request is a single round trip and a banned one still is. The ban
is read first and short-circuits without writing, so a banned identity cannot
extend its own counters. The two counters stay separate — admission per
`(identity, route)` for fairness, escalation per identity so rotating the path
cannot dodge the ban — and the ban marker carries its duration as its own TTL.

### Token-budget counters no longer leak in Redis

`admission:lifetime:*` is the only thing bounding a key's lifetime token total,
and two writes dropped that bound. The reserve script seeded a missing counter
with a plain `SET` and no TTL, and the reconcile script wrote every bucket with a
plain `SET`, which replaces the key and strips the expiry the reserve had just
armed. A counter with no expiry is never reclaimed, so the total leaked for the
life of the deployment; a *rejected* reserve leaked it too, because the seed runs
before the budget check that returns early. The seed now carries its TTL and
reconcile adjusts with `INCRBY`, which preserves it.

### Route and pool inflight slots share one crash-recovery TTL

Routing admission expired its per-account inflight key after a hardcoded 60
seconds, while the network-pool selector derived its own from the upstream
deadline plus the stream stall budget. A stream running longer than a minute
therefore lost its slot mid-flight and a second request could admit against the
freed slot, exceeding the configured ceiling. Both now use
`resolveInflightTtlSeconds()` — 600s at the defaults — so raising either timeout
keeps them in step.

### Telemetry retention prunes in bounded batches

The retention sweep deleted every aged `telemetry_events` row in one statement.
On a long-lived deployment that statement grows without limit, and once it
exceeds the pool's `statement_timeout` it is cancelled and the sweep never
converges, so retention silently stops working. Aged events are now removed in
bounded 5000-row batches that commit independently, mirroring the payload
sweeper, so progress survives a cancel or a restart.

### The flat model catalog reads the catalog once, not per provider

`listFlatModels` called `listModels` for every provider, and each call was two
queries, so the picker's cost grew with the bundled provider count. One grouped
read now serves the whole tenant: a tenant with 50 providers issues 2 queries
instead of 100, and the count is constant as providers are added.

### The cooldown sweep prunes model cooldowns in one statement

`sweepExpiredCooldowns` selected every account holding a cooldown and then
issued one `UPDATE` per row, all inside one transaction. It now recomputes the
pruned object in a single set-based `UPDATE`, so the sweep's cost no longer
grows with the number of throttled accounts and its locks are held for one
statement instead of many.

### The orphan `backup_status` table is gone

`backup_status` existed only in the baseline SQL: no Drizzle definition, no
reader, no writer, and absent from the backup feature's own table lists, so a
fresh install carried a table nothing could touch. It is removed from the
baseline and dropped from existing databases by
`drizzle/migrations/manual/0012_drop_backup_status_table.sql`, with a contract
test asserting the baseline cannot reintroduce it.

### Shared API-key templates enroll non-authenticating child keys

API keys can be personal or share templates. Templates store no authentication
hash or recoverable secret; public enrollment issues one child key per globally
unique canonical trusted client IP and reveals its secret once. Owners can
revoke children and view masked-IP, model, request, error, and token telemetry.
Revoking a template or converting it to personal mode revokes its children and
enrollment links. The landing page, console, and share enrollment now use one
dashboard index while share styling remains isolated.

### Provider accounts expose concurrency limits and usage

Operators can set a per-account in-flight ceiling that overrides tenant/provider
routing defaults, with an empty value inheriting the configured default. Account
rows also show UTC-today and durable lifetime request/token totals. Lifetime
totals are initialized from telemetry still retained at rollout and continue
after raw telemetry retention expires.

### Provider probes use an internal marker instead of a probe User-Agent

Provider dispatch probes carry `Cartethyia-Probe` only in their internal
dispatch context and telemetry. A shared probe-fetch wrapper removes
`User-Agent` before upstream requests, including discovery, BYOK connection
tests, and API-key connectivity checks.

### Codex turn metadata has one serialized form

The request header and `client_metadata` body carry the same turn metadata.
Codex dispatch now builds that JSON once and reuses it at both wire locations;
the outbound request test pins their byte-for-byte equality.

### Backup routes no longer advertise a credential that cannot use them

`BACKUP_SCOPES` listed `providers:write` on the stated grounds that a tenant API
key could script a backup. It cannot: both actions re-authenticate by verifying
the operator's password against their session's user row, and a key carries no
session, so a key reaching the route failed one step later with "password is
incorrect" instead of at the scope check. The list now names only
`dashboard:write`, and tests pin that a `providers:write` key, a
`routing:invoke` key, and an unauthenticated request are each rejected before any
export runs.

### A pool with no cooling providers no longer fails its own overview

The Proxy page reported "Failed to load network pools". The read batches every
cooling provider into one `MGET`, and `MGET` with no keys is a Redis error — but
a healthy pool lists no cooldown members, so the empty call is the *common* case,
not an edge one. Every pool overview therefore failed with `ERR wrong number of
arguments for 'mget' command` whenever nothing was throttled. The empty case now
returns an empty list without the round trip, and the test double rejects a
zero-key `MGET` the way Redis does, so a double can no longer hide this.

### Catalog scopes no longer include `dashboard:write`

The catalog scope lists were `["dashboard:write", "providers:write"]`, which
made `dashboard:write` imply the ability to add an upstream or delete a model —
the exact thing the scope model says it must not, and reachable in practice
because a tenant API key may hold `dashboard:write`. The lists now hold only the
catalog scope, and the console session is granted the catalog scopes by name
(`consoleSessionScopes`) because the dashboard is the operator and must keep
working. A regular console user keeps its read-only ceiling. Covered by tests
over five principals, including that a `dashboard:write`-only key is rejected.

### A restore no longer deletes rows the payload never described

Restoring a payload that named a table and declared it empty emptied that table.
A config-only file carrying `provider_accounts: []` — a router export with no
connections, an export taken before any account existed — ran a table-wide
`DELETE` before inserting nothing, so an operator's accounts disappeared and the
dashboard showed "No accounts connected". The file's silence was being read as an
instruction to delete.

Two things were wrong, and both are fixed. The clear was **not scoped to the
restoring tenant**: `providers` and `models` hold the shared built-in catalog and
`provider_accounts` holds every tenant's accounts, so the delete reached far
outside the tenant that ran it. Ownership is now declared per table
(`ownershipOf`), and a restore clears only rows the restoring tenant owns; a
table with no declared owner throws rather than falling back to clearing it. And
the clear **ran for a table with zero rows in the payload**: an empty array
describes nothing, so it now clears nothing. A non-empty array still replaces the
tenant's rows, which is what "restore my configuration" means.

The regression test replays the exact payload shape against a real database and
asserts the tenant's accounts survive; it fails on the account count (1 → 0) with
the fix removed, reproducing the incident rather than a compile error.

### Backup and restore, and importing a router export

`GET /backup/export` writes the tenant's configuration and telemetry metadata as
plain JSON; `POST /backup/import` restores one, auto-detecting whether the file is
our own backup or a router export. Both re-authenticate the operator's console
password, because an export is every provider credential and API-key hash in the
clear and an import replaces it — a stolen session cookie must not be enough to
walk away with the secrets or overwrite them.

Two sections, and the split is the point: `config` (where traffic goes, with
which credential) and `telemetry` (per-request status, tokens, cost, latency).
`telemetry_payloads` — captured prompt/response bodies — is never exported and
never restorable, so a backup is not a substitute for a database dump. Config is
replaced (for the restoring tenant's rows only, and never for a table that mixes
in other tenants' rows or rows the payload omits); telemetry is merged, never
deleted, so re-importing the same file does not double-count history. Everything
runs in one transaction, and nothing is written until the whole payload
validates against the live schema.

The importer never guesses and never drops silently: a provider id with no
counterpart is skipped with a named reason rather than mapped onto something that
merely looks similar, and everything not imported is reported. Credentials are
re-encrypted with this instance's key.

Restored history is still subject to `CARTETHYIA_TELEMETRY_RETENTION_DAYS`, so
rows older than the window are pruned on the next sweep; retention is a
deployment decision and is left alone, and the report says so rather than letting
a successful-looking restore quietly empty.

### Catalog writes over an API key, on their own scopes

`providers:read`/`providers:write` and `models:read`/`models:write` join the scope
union, so a key can register a BYOK upstream or add a model without a browser
session. They are deliberately separate from `dashboard:write`: a key minted to
read usage, or to change a display setting, must not thereby be able to add an
upstream or delete a model, because those writes change where traffic is sent and
which credentials are used. The console router resolves a bearer key through the
same authorization path `/v1` uses, so the catalog operations have one
implementation and two auth paths.

### Discovery stops inventing limits for providers models.dev files elsewhere

`/v1/models` reported `200000`/`64192` for 64 of the 80 models `opencodeft`
serves. The upstream states no limits at all — its `/zen/v1/models` response
carries only `id, object, created, owned_by` — so every entry fell through to
the offline models.dev snapshot, and that lookup missed: Cartethyia calls the
provider `opencodeft`, while models.dev files those rows under `opencode`. The
exact lookup never matched, the bare fallback correctly refused to answer
(because many providers carry the same id and disagree), and the entry was
published with the fallback floors. A 1,000,000-token model was advertised as
200,000, which is the number a client uses to decide whether its request fits.

`MODELS_DEV_PROVIDER_IDS` now maps the ids that genuinely differ
(`opencodeft`/`opencodezen` → `opencode`, `opencodego` → `opencode-go`,
`ollamacloud` → `ollama-cloud`, `xiaomipg`/`xiaomitp` → their Xiaomi token-plan
rows). The lookup tries the id as given first and the mapped name second, so a
provider the catalog already carries under its own id still wins. Only ids
backed by the deployment's own upstream are mapped: a match resting on shared
model ids was rejected, because the same generic id appears under hundreds of
resellers and a guess would attribute a stranger's limits — the failure the
bare-id disagreement rule exists to prevent.

The snapshot itself was four days stale and had lost rows the catalog now needs,
so `scripts/ci-generate-models-dev-snapshot.ts` re-downloads models.dev and
rewrites it (2.0 MB, 8,126 rows across 223 providers, minified like before).
Precedence is unchanged and now documented: upstream first, then the catalog,
then the floors. models.dev remains authoritative for pricing — an upstream
`/models` response rarely states a price — with limits as a secondary source.

### Alias entries report the limits their target actually has

`/v1/models` described every alias with the same `200000` context and `64192`
output tokens, no matter what it routed to. The metadata lookup only read ids
shaped `provider/model`, so a target that is a *combo* name — the common case,
since an alias usually fronts a pool — was discarded and the entry fell back to
invented defaults. A pool whose members serve 1,048,576 tokens was advertised as
200,000, which is the number a client uses to decide whether its request fits.

The walk now follows the same chain dispatch follows: alias → combo → member,
recursing through members that are themselves aliases or combos, bounded to 16
hops to match the engine's `resolveAlias`. An entry advertises the minimum
across the catalog rows it can reach, and only the modalities every member
shares, because dispatch may pick any of them. The three aliases on the local
deployment now report 1,000,000/384,000 and 1,048,576/131,072 — the values in
the catalog — instead of the shared defaults.

### Discovery shows an alias, not the providers that share its name

A key allowlisted to three aliases also saw four provider rows on `/v1/models`.
The shadow filter in `PublicModelCatalogStore` compares a catalog row against
the allowlisted alias, but it compared the row's full `modelId` only. A provider
that nests a path inside its own model id (`cline-free/deepseek-v4.1-flash`,
`ali/deepseek-v4.1-flash`) has the alias's bare name and a different full id, so
it escaped the filter and was published as a separate, selectable model on a
provider the operator never named. Rows whose `modelId` is already bare were
correctly hidden, which is why the leak looked partial rather than total.

Both sides are now compared by bare name as well as full id, and the same
applies to combos. An explicitly qualified allowlist entry still wins — naming
`workbuddy/glm-5.3-flash` remains an unambiguous grant of that exact row. The
filter is covered by a DB-backed regression test on the real `listPublicModels`
boundary, including the nested-id shape that caused the leak.

### Share pages advertise the origin that serves them

A share page reached through a tunnel told its recipient to call
`http://127.0.0.1:12800`. The Base URL card copied the value the gateway sent,
and `configuredOrigin` preferred `CARTETHYIA_PUBLIC_ORIGIN` — a variable pinned
to the OAuth redirect host, which is a loopback address in a local deployment —
over the origin the page was actually reached by. The `publicOrigin` option that
could have overridden it was never passed at its one construction site, so the
loopback branch always won.

The gateway cannot know that origin: a tunnel, a reverse proxy, and the OAuth
host can each differ from what the request reports. The browser is the only
party that knows for certain, so the share payload no longer carries an origin
at all and the share app derives the Base URL from `window.location.origin` —
the same source the `/v1` hint beside it already used. A regression test pins
the loopback case on both the payload and the rendered page.

### Client-version pins refreshed, and their sources documented

Every CLI/IDE impersonation pin in `operations/client-versions.ts` was re-read from its upstream source
rather than left to age. The stale ones were the pins that decide the `User-Agent` and version headers an
upstream gates on, so a drift there is a request rejected with "please make sure you're using the latest
version" rather than a visible error. `clineClient`'s `minVersion` floor moved with its fallback — the two must
travel together, or discovery can accept a version the provider has already stopped serving.

Two pins outside that table moved as well: the Antigravity client version (its electron-builder manifest now
reports a 2.x line well past the pinned value) and the Devin/Windsurf IDE and extension pair, which ship
together.

The lookups are now recorded in `PROVIDERS.md` — one row per entry, with the URL, the field read, and the
reason two entries cannot be fetched at all (`claudeSdk` lives inside a compiled binary; the Devin/Windsurf
update endpoints are private, so the IDE version comes from the release-notes page the download site links to,
and the extension version from the Marketplace query API). Refreshing a pin is now a fetch instead of a hunt.

### Error taxonomy: one status table, honest attribution, and a named context overflow

The public error codes were measured against three other gateway
implementations and audited against our own source. Six
gaps were found; four of the ideas found there were rejected on their merits
(substring classification, empty codes, contradictory tables, cooling a
credential for an unclassified failure). Two premises in the original analysis
were wrong and are corrected here rather than quietly dropped.

**Correctness — a client could not tell whose fault a failure was**

- An explicit error frame inside a `200 OK` was recorded only as a terminal
  `state: "failed"`, which `terminalFailure` rewrites to `transport_unavailable`
  (502, origin `cartethyia`). Three things were wrong with that. The client was
  told the *stream* failed when the upstream had named its own reason. The
  provider was never cooled down: `shouldCooldownPool` needs an
  `origin: "upstream"` 429, so a rate-limited provider kept being dialed. And
  because `pool-health-machine.ts` treats `transport_unavailable` as a pool
  fault, the **network pool was degraded** — blaming the egress proxy for the
  provider's rate limit. The chat, responses, and codex decoders now classify
  the frame through one shared `stream-error-frames.ts` classifier (the Claude
  and Gemini decoders already raised), so a rate-limit frame becomes
  `quota_exceeded` (429, provider-scoped), an overload frame becomes
  `platform_unavailable`, and a named overflow becomes `context_length_exceeded`.
  A frame that declares a failure with nothing recognizable becomes
  `platform_unavailable` rather than `invalid_request`: blaming the client for
  the provider's problem invited an identical retry. Classification reads
  structured identifiers only, never prose — a substring rule on a word like
  "capacity" fires on any message containing it, including text the client
  itself wrote. Each decoder's catch block now rethrows a `GatewayError`
  unchanged; without that, the classification was rewritten as a malformed-SSE
  failure and the code was lost anyway.
- 28 sites labelled upstream protocol corruption as `invalid_request` (502).
  A malformed SSE event, an empty stream, a body that is not JSON, a Claude
  stream that ends before `message_stop` — all told the client *"your request
  is invalid"*, so a well-behaved client retried a byte-identical request
  against the upstream that was already broken. These are now
  `platform_unavailable` (502) with `origin: "upstream"`. The origin move is
  part of the fix, not decoration: `ingress.ts` prefixes a `cartethyia`-origin
  message with "Cartethyia Error:", which blamed the gateway for the provider's
  bytes — the same defect the HTML-error-page guard already corrected.
- There were **two** status→code tables, not one, and they disagreed. The
  second (`statusToErrorCategory`) mapped every upstream 5xx to
  `proxy_unreachable`, so the generic path used by seven providers reported a
  provider outage as "network proxy was unreachable" (the console's own
  wording). It also mapped 529 to a non-retryable code while the first table
  mapped it to a retryable one. Both callers only ever re-derived a code from
  it, so it is deleted and every caller reads the one table.
- `codex-errors.ts` pinned every non-auth/rate/proxy status — 5xx included — to
  `invalid_request`. A Codex upstream 500 reached the client as "your request
  was invalid" and telemetry recorded a client fault for a provider outage.
- `qoder.ts` kept a private copy of the mapping that sent every 5xx to
  `proxy_unreachable`. Because `pool-health-machine.ts` treats that code as a
  pool fault, a Qoder upstream outage **degraded the network pool** and could
  disable it — punishing the egress proxy for the provider's failure.

**New contract — one code, no synonyms**

- `context_length_exceeded` (413) names a request that exceeded the model's
  context window, which previously arrived as a bare `invalid_request` with no
  way for a client to know it should shorten the prompt. Detection reads the
  structured `error.code` / `error.type` identifiers only
  (`isContextLengthFailure`); prose is never matched, so an upstream that
  reports overflow only in a sentence keeps its generic code. A false "your
  prompt is too long" is worse than a missing one — it tells the client to
  truncate a request that was fine. `providerStatus` preserves the literal
  upstream status when the envelope is normalized to 413.
- `retry-after` is emitted on every response that carries real wait evidence
  (`retryAfterMs`, or `retryAt` converted to seconds), not only on a literal
  429. Several retryable failures are 503 (`admission_unavailable`,
  `proxy_pool_*`), and the client had no way to learn when to return. A 429 with
  no parsed evidence keeps its one-second floor; nothing is invented when there
  is no evidence at all.

**Documentation**

- `TRANSPORT.md` now documents all 29 codes with status, origin, retryability,
  and meaning, replacing a partial list that named 12 and omitted every status.
  `PROVIDERS.md`'s Qoder paragraph was corrected to match the shared table.

### Second cleanup pass: a stranded concurrency slot, a dropped model, and the last duplicates

The previous pass left a backlog. Re-verifying every one of its items against the
current source (rather than trusting the notes) found that most were already
done and several premises were simply wrong, but it also surfaced two real
defects and a set of round-trip regressions.

**Correctness — these were wrong, not merely untidy**

- A crashed request's concurrency slot could never be reclaimed. The Redis
  admission lease key's own TTL was set to exactly the `expires_at` horizon the
  lease hash recorded, so Redis evicted the hash at the same moment the sweeper
  became allowed to read it: `HGET state` returned nil, the sweep skipped every
  lease, and a process that died between reserve and release left its
  concurrency and tenant-concurrency slots held. Because every later
  reservation re-arms the counter's own TTL, a key still in use never recovered
  them. The key TTL now exceeds the reap horizon by a grace window. The
  existing sweeper test could not see this — its fixture kept every hash alive
  forever — so a new contract suite runs both stores against the same
  invariants with a Redis double that models eviction honestly.
- `grok-4.7` was dropped from live model discovery. The discovery allowlist in
  `default-registry.ts` accepted only `grok-4.5`/`grok-4.6` while `GROK_MODELS`
  and the request builder both served `grok-4.7`, so an upstream that advertised
  it had the model filtered away. Both the discovery filter and the
  reasoning-effort check now derive from `GROK_MODELS` instead of restating it,
  which is what let the lists drift apart in the first place.
- The Claude quota 429 cooldown never activated. `claude-quota.ts` compared
  `quotaCooldown.get(key) ?? 0 > now` — an absolute future timestamp against
  `0` — so a rate-limited credential was retried into the limit on every call.

**Performance — round trips removed from hot and periodic paths**

- The admission `purge` (key revocation) issued one `HGET` per lease while
  scanning; it now pipelines one round trip per scan page.
- The pool selector read cooldown entries with one `GET` per member; it now
  issues a single `MGET`.
- The quota refresh sweep resolved each account's cache age with one Redis round
  trip per account; it now batches per lens through the cache's own reader, so
  the key format stays owned by the cache module.
- Model discovery inserted discovered models one row at a time; it now batches.
- `checkAvailable()` ran a `PING` before every admission and IP-abuse check, on
  top of the atomic script that already fails closed. Both probes are gone:
  the store operations surface their own failure and the service maps it to the
  same bounded `admission_unavailable`.

**Schema**

- `telemetry_events (api_key_id, created_at)` had no index, so every render of a
  public share page aggregated the largest table in the schema with a scan.
  Added to `schema.ts`, the baseline, and as a hand-run migration
  (`drizzle/migrations/manual/0010_*`). Existing databases need the migration.

**Single owners and duplicates removed**

- `Counter` and `Gauge` duplicated their sample store, cardinality guard, `inc`
  accumulation, and rendering byte for byte; both now extend one base, with the
  rendered exposition unchanged.
- `openaiCacheControl` is deleted. Its ≤4-breakpoint check was already
  superseded by `validateCacheBreakpoints` at the preflight boundary (a typed
  400 before admission), and its 1024-visible-token minimum was never supplied
  by any production caller, so it enforced nothing. The rule it documented is
  gone with it.
- The last three hand-assembled terminal envelopes (in the Codex and Claude
  Messages decoders) now use `canonicalTerminal()`; the helper omits fields
  rather than emitting `undefined`, so the wire bytes are unchanged.
- Eight copies of the `output_index` coercion became one `readOutputIndex()`.
- Three copies of the source-tree walker became `test/helpers/source-tree.ts`
  (`token-saver.test.ts` keeps its deliberately broader variant), and one
  duplicated SSE `collect` moved to the shared fixture.
- `formatTokens` had two implementations with different signatures; the
  dashboard now owns one numeric version.

**Fixed a structural test defect**

`test/transport/streaming.test.ts` declared a `describe` that contained no tests
at all and wrapped a second `describe` of the same name, so seven tests ran under
a misleading label while `streamOf`/`collect` were each declared twice. Renamed
and hoisted; all ten tests still run.

**Tooling**

- `.claude/` is now gitignored. `git add -A` would otherwise stage entire
  duplicate repository trees from agent worktrees.

### Whole-tree cleanup: single owners, dead paths, six correctness fixes

A read-only audit of every `src/` layer and the dashboard produced 88 findings; a
second pass refuted three and corrected six before any code moved. The result is
one owner per concept, plus the correctness bugs the duplication had been hiding.

**Correctness — these were wrong, not merely untidy**

- In-memory admission budgets never rolled over. `InMemoryAdmissionCounterStore`
  (the `REDIS_MODE=single_instance_local` production mode) keyed its daily and
  monthly counters by api key alone, with no date bucket and no reset, so a key
  that exhausted its daily budget on day one was rejected every day after,
  forever. The Redis store avoided this by putting the bucket in the key; the
  in-memory store now does the same and records the bucket keys on the
  reservation — mirroring how the Redis lease hash stores them — so a request
  spanning midnight settles the bucket it actually charged.
- The Redis-less mode could not boot at all. `main.ts` threw when `redis` was
  undefined, while `readiness.ts` treats `single_instance_local` as "Redis not
  configured". `ProductionAppDeps.consoleApi` is now optional and the console
  mounts only when a Redis client exists, so that mode serves `/v1/*`, `/health`
  and `/metrics` with no console surface.
- First-boot setup skipped its advisory lock. A `typeof` probe fell through and
  ran the tenant, administrator and gateway-key creation unserialized when the
  handle could not take the lock. It now fails closed.
- Two ad-hoc health writes bypassed the health machine in
  `providers/discovery/probing-service.ts`. Both wrote `status: "degraded"` with
  `cooldownUntil: null`, clobbering the cooldown the classifier had just computed
  and parking the account in a state nothing recovers from. The second fired on a
  regex over the model's own answer text, so any probe whose sample contained
  "202" degraded the account.
- A registry failure was reported as "no adapter registered": `void error` threw
  away the cause and turned a real failure into a configuration-shaped message.
  The typed error now propagates.
- `scripts/build-icons.ts` broke a clean-checkout `bun run typecheck`
  (`TS2307: Cannot find module 'sharp'` — an undeclared dependency, an input
  directory that no longer exists, and committed outputs). Removed, with two
  other unreferenced scripts.

**Cold start**

- Boot blocked on two live network fetches before `getDb()`, holding the listener
  for up to the 4 s fetch timeout on a blackholed network while the pinned
  fallback was already serving correctly. Discovery is now fire-and-forget after
  the listener. `RUNTIME.md` documents the real boot order.
- The boot seed ran 72 sequential statements; each seeder is now one upsert.
  Verified against a real database that an operator's custom compatibility key
  still survives a re-seed.

**Security**

- The session cookie was marked `Secure` whenever `NODE_ENV=production`, so a
  plain-HTTP self-host looped the login page with no error. It is now keyed on
  `CARTETHYIA_PUBLIC_ORIGIN`; the per-request upgrade for TLS and trusted proxies
  is unchanged.
- `retry-after` reports the real remaining lock instead of a hardcoded 3600, and
  `bun run doctor --reset-lockout <user> <ip>|--all` is the operator escape hatch
  that did not exist.
- `/auth/refresh` had no caller anywhere — the dashboard referenced it only in an
  exemption list — yet carried two live CSRF and mutation-throttle exemptions.
  The route, `refreshSession`, `store.refresh` and both exemptions are gone.
- CLI-tool configs no longer require pasting a raw secret. The console already
  stores a recoverable AES-256-GCM copy; `console/cli-tools/secret-source.ts`
  resolves it server-side from a key id, tenant-scoped, failing loudly
  (`api_key_unresolvable`) for a key with no recoverable copy instead of emitting
  a blank token. `POST /cli-tools/:toolId/apply` reports which delivery paths ran
  (`file` / `remote` / `both` / `none`), so a guide tool with no injectable config
  no longer claims a file write.

**One owner per concept**

- One record guard. `object` (41 uses) and `isRecord` (169) were byte-identical;
  `isRecord` now lives in `protocol/primitives` and 30 files migrated. That also
  removes a cross-layer cycle — `protocol` had been importing the guard from
  `transport/surface`, which imports from `protocol`.
- One terminal envelope. Eight hand-assembled copies became `canonicalTerminal()`,
  typed against a named `CanonicalTerminalEvent`, which removed five redundant
  casts with it.
- One terminal→error mapping. The streaming and non-streaming dispatch paths had
  drifting wording for the same conditions; `terminalFailure()` owns it now.
- One completion context. `completionContext()` replaces three copies of the same
  twelve-field literal, so a field added for one path cannot miss the other.
- One console error hook. 95 handlers wrapped their body in the same
  `try { … } catch { errorResponse(…) }`, 22 of them with the same message in one
  file. A group-level `error(consoleErrorHandler(msg))` produces the identical
  envelope, including `ValidationError` → 422.
- One tenant guard: eleven identical six-line access blocks in `account-quota.ts`
  became one line each, with the scope still explicit at every call site.
- One formatter set. Four `formatBytes` copies disagreed on the unit threshold,
  the decimal count and the placeholder, so the same byte count read as "0 MB" on
  Overview, "1536B" in Studio and "—" in Usage. `dashboard/src/lib/format.ts` owns
  bytes, duration, uptime and number.
- One wave scheduler (`runGrowingWaves()`), one provider-account invalidation
  helper, one clipboard hook, one modal focus contract (the Drawer re-implemented
  what `useModalFocus` already owned), one `ledgerKey`, one `isUniqueViolation` at
  the persistence boundary, one `REASON_META` table (three of the four originals
  were rebuilt per rejection), one `completeRequiredSchema`, one
  `stripEndpointBasePath`, and one `jsonResponse`/`streamOf`/`collect` for tests.

**Performance**

- `CompletionStreamEncoder` kept every canonical event and rescanned the array per
  text delta — O(n²) over a long completion — while retaining the whole response.
  It tracks three scalars.
- `liveProviderUpstreamHosts` returned a hand-rolled Map facade that allocated a
  fresh array per lookup on the dispatch path. It is a live closure over the
  registry's own map.
- The Usage page re-read the same preferences row per request on the list, detail
  and breakdown paths; it goes through the revision-cached reader.
- The Usage analytics queries no longer poll in a background tab, so a dashboard
  left open does not hit the gateway forever.

**Removed as dead**

`preContentEvents`/`attemptEventStart` (write-only), the `AsyncIterable` encode
overload and `encodeResponsesStream` (zero callers), the `canContainToolResult`
re-export shim, `reconstruct()`, `assertBounded`, `stateStore.delete()`,
`attemptDailyCheckin` + `resetDailyCheckinLedger` (four tests migrated to the
growth pass), the `ci-fixtures` test island (705 lines), `TtlCache.has`,
`isSecretKeyName`'s options object, `getCount` from the IP-abuse store contract
and its Redis implementation, `CLAUDE_OAUTH_*` and `CODEBUDDY_INTL_*` aliases,
`upstreamIdForIntl`, `StatusBadge` (which rendered CSS-less classes),
`isQuotaStale` and its mirror constant, a forwarding `isValidDatabaseUrl` shim,
stale `.dockerignore` entries, and two byte-identical test blocks.

**Deliberately not applied**

- `exchangeCodeVia` is live (`exchangeCode` → the console OAuth callback);
  deleting it would have broken OAuth login. The first audit called it dead.
- Allowlisting the ingress header record would be fail-open — the record reaches
  surface detection and every parser, so a new header would become invisible.

The one exception is now resolved in the other direction: `openaiCacheControl`
was kept in that round as "the only implementation" of a 1024-visible-token
minimum, but no production caller ever supplied a token count, so the rule
enforced nothing while its ≤4-breakpoint check was already superseded by
`validateCacheBreakpoints`. It is deleted: the function, its two payload types,
both call-site spreads, its tests, and the `TRANSPORT.md` claim. The ≤4 limit
keeps its single owner at the preflight boundary.

Two further removals were reverted after verification: the `typeof db.transaction`
probe in `account-health-service.ts` is load-bearing for a partially-implemented
test double, and `InMemoryIpAbuseStore.getCount` is used by tests as
introspection. Both were restored with comments explaining why, rather than
removed for symmetry.

**Configuration**

`CARTETHYIA_KIMI_QUOTA_BASE_URL` replaces the undocumented `KIMI_CODE_BASE_URL`
read and is declared in `CONFIG_SPEC`, so it is covered by the drift check.


### Proxy pool status
- Consolidated the tool-result placement rule that had been re-derived (and gotten wrong) in eight places. "A tool
  answer may live in a `tool` turn **or** a `user` turn" is a fact about the canonical model, so `canContainToolResult`,
  `toolResultParts` and `toolCallParts` now live beside `CanonicalMessage` and every consumer uses them: the buddy drop
  policy, the orphan scan, the interleaved-batch repack, the Codex orphan repair, and the Chat, Messages, CommandCode,
  Qoder and Devin encoders. A `role === "tool"`-only check missed every Messages-origin history, which caused three
  separate upstream 400s: `tool_call_sequence_broken`, "tool calls and tool results do not match", and the
  thinking-mode reasoning replay — the last because the buddy policy stripped a *complete* round's `tool_calls` while
  leaving its result behind, so the replayed reasoning turn no longer had a call to attach to. A shared contract test
  asserts the rule across all consumers.
- The thinking-mode 400 ("the reasoning content from the previous turn must be passed back in thinking mode") is fully
  closed, across three shapes the Chat encoder got wrong. An assistant turn carrying `tool_calls` dropped
  `reasoning_content` — exactly the turn a thinking model emits it on. The field was gated on non-empty text, so a
  `display: "omitted"` thinking block (empty text plus a signature) lost it. And a reasoning-only assistant turn was
  dropped entirely. The field is now emitted whenever an assistant turn carries a reasoning part, regardless of text
  length. It stays assistant-only: leftover reasoning on a user turn folds into the preceding tool message as before.
  Separately, `backfillDeepSeekReasoningContent` wrote an **empty** `reasoning_content` onto assistant turns with no
  trace, which the upstream reads as thinking-mode-with-the-reasoning-stripped; it now only writes the field when a real
  reasoning trace exists.
- A provider that states its reset as an **absolute instant** now sets the cooldown correctly. WorkBuddy/CodeBuddy
  `6004` answers a 429 with "your usage will reset at 2026-09-24 02:12:51 UTC+8", but `parseProviderResetDuration`
  only understood relative durations ("in 3 hours"), so the account fell back to the 15-minute default — it
  re-entered rotation and failed every request inside the provider's own reset window. Absolute timestamps are now
  parsed (including a bare `UTC±H` offset), and the provider's stated reset always wins over the fallback.
- Fixed three upstream-failure shapes that surfaced as unusable client errors:
  - A `toolResult` orphan living in a **`user`** turn (every Anthropic Messages tool flow re-homes results there)
    survived the orphan scan, which only inspected `role: "tool"`; `chat.ts` then emitted it as an unpaired
    `role:"tool"` message and the upstream rejected the whole history with "tool calls and tool results do not
    match". The scan now uses the shared `canContainToolResult()` rule.
  - The buddy-family drop policy (`dropIncompleteToolRounds`) ran *after* the generic repair, which had already
    synthesized a `<missing tool output>` result for the unanswered call — making every partial batch look complete
    and silently disabling the policy, so `assistant[c1 c2] + tool[c1]` still dispatched. Dropping now runs first.
  - A non-SSE, non-JSON upstream body (plain text, garbage, or an HTML page on a 2xx) threw a bare `SyntaxError`
    from `res.json()`, which no classifier recognizes: telemetry recorded `unknown_error` and the client got a 500
    "the upstream failure could not be classified". It is now a typed 502 `transport_unavailable` carrying the
    upstream's own message, and a JSON error envelope on a 2xx is surfaced instead of decoding as an empty success.
    HTML error pages are also attributed to `upstream` instead of blaming the gateway.
- Proxy HTTP 402/407 responses now report `Proxy reachable`, disable the affected pool from
  routing, and appear in Health & Activity without misclassifying the error as a provider failure.
- Upstream disable policy is now explicit: only real credential evidence disables an account.
  Deterministic content-policy rejections (`11140`) and hosted-tool failures
  (`web_search`/`x_search`/`web_fetch`) never do, a 402 quota response cools down instead of
  disabling, and a 407 is `network`-origin so it can never mutate an upstream account.
- The buddy family (`cb`/`cbcn`/`workbuddy`) is the one policy exception: its `11140` block keeps
  failing every subsequent invocation, so the account is parked in a 24h `policy_blocked` cooldown
  (never `disabled`) to stop routing from selecting it.
- xAI Grok Build free-tier exhaustion (`subscription:free-usage-exhausted`, "included free usage",
  "rolling 24-hour window") is a 24h `quota_exhausted` cooldown instead of the generic 1h fallback —
  it no longer parks the account as `degraded` and can no longer re-enter rotation inside the
  provider's own reset window.
- Account and proxy-pool health delays are operator-tunable through `CARTETHYIA_ACCOUNT_*_COOLDOWN_MS`
  and `CARTETHYIA_POOL_COOLDOWN_MS`; upstream `Retry-After`/reset evidence still wins over every
  fallback.

### Breaking cleanup contracts

- Removed environment knobs that were never operator policy: `CARTETHYIA_SERVER_REUSEPORT`
  (always on), `CARTETHYIA_ELYSIA_PRECOMPILE` (derived from `NODE_ENV`),
  `CARTETHYIA_PROXY_KEEPALIVE_TIMEOUT` (fixed 60 s), `CARTETHYIA_IP_ABUSE_MAX_KEYS`
  and `CARTETHYIA_IP_ABUSE_CAPACITY_PER_KEY` (fixed store bounds), and the
  `CARTETHYIA_ANTIGRAVITY_{VERSION,CL,OS,ARCH}` client fingerprints (pinned
  constants; the version still tracks the upstream manifest).
- `CARTETHYIA_MODEL_CATALOG_CACHE_MAX_ENTRIES` and
  `CARTETHYIA_GC_ON_MEMORY_PRESSURE` became constructor parameters instead of
  environment variables; they were test seams rather than deployment settings.
- `src/config.ts` now declares every knob it reads in one `CONFIG_SPEC` table,
  and `test/config-env-drift.test.ts` derives the documented variable set from
  it. The drift check previously scanned only `process.env.X` dot access, so
  bracket reads (`process.env["X"]`) escaped it entirely; both forms are now
  collected, and the one remaining indirect reader (`REDIS_MODE`) is declared
  explicitly.
- Removed the four always-null `telemetry_payloads` body columns
  (`response_body`, `client_response_body`, `provider_request_body`,
  `provider_response_body`) from `schema.ts` and the baseline. No writer ever
  filled them: the capture path stores `{ _payload_ref }` in `request_body` and
  the bodies live in the frame file that reference names, so the readers
  overwrote all four from the frame. Existing databases converge with the
  hand-run idempotent DDL in
  `drizzle/migrations/manual/0005_drop_telemetry_payload_body_columns.sql`.
- Removed the eleven per-provider CLI client-version env overrides
  (`CARTETHYIA_{QODER,OPENCODE,COMMANDCODE,GROK,CODEX,CODEBUDDY,KIMI_CLI,CLINE_CLIENT,CLINE_SDK,WORKBUDDY_CLIENT,WORKBUDDY_CLI}_VERSION`).
  They existed to freeze a version offline or force one the registry had not
  published; neither is operator policy, and a stale pin silently defeated the
  `minVersion` guard that protects providers gating on a specific artifact.
  `createClientVersionResolver` now takes no `envVar` and resolves
  discovered → pinned fallback, with `reset()` as the test seam.
- Quota cache writes use the v2 envelope; reads tolerate the legacy bare form
  only during the N release, with the legacy branch and SCAN invalidation
  scheduled for removal in N+1.
- Provider routing persists `rotateCount` — the number of requests one account
  serves before round robin advances (clamped 1..1000); exact model lookup no longer
  guesses from suffixes or bare ids and returns the qualified model contract.
- Studio persists one `toolRounds` representation; `toolCalls` is derived only
  for display.
- Missing active pools are an explicit 503 (`pool_unavailable`) rather than a
  silent fallback to the first pool.
- Removed the `contentStrip` runtime preference and its `stripContentTypes()`
  module. It was stored, validated, and returned but had no dispatch consumer —
  and as a route-blind pre-strip it would have preempted capability routing.
  Modality support is already handled, in order, by candidate filtering, then
  model fusion (`fusion:*`, then same-provider capable models), and only then by
  the preparer's degrade ladder, which substitutes a `[image]`-style text
  placeholder and logs `degradedCapabilities`. One path, not two.
- `buildCapabilityProfile()` grants `reasoning`, `reasoningEncryptedContent`,
  `tools`, and `parallelToolCalls` unconditionally. A `false` in
  `models.reasoning` or `models.tool_call` — whether a discovered row recorded
  it for lack of metadata or a builtin/manual row set it explicitly — no longer
  strips the request. The upstream decides whether it can serve them. Content
  modalities still fall open for every non-`native` wire, and `web_search`
  still follows the row.

### Routing & CLI mapping

- Added API-key-scoped CLI model mapping via the `routing:cli_mapping` scope.
  Keys without the scope retain ordinary model/alias routing and are never
  remapped by CLI source-to-target rows.
- Network pools gained a per-tenant round-robin selection strategy
  (`GET`/`PATCH /network/pools/strategy`, `pool_routing_settings` table):
  `round_robin` strides the per-tenant cursor by `rotateCount` positions per
  admission (mirroring the account strategy's 1..1000 clamp), with full/cooldown
  pools failing over to the next offset. `least_loaded` remains the default,
  and the Proxy page exposes the toggle.
- Claude Code family selectors (`sonnet`, `claude-sonnet-4-5`,
  `claude-sonnet-5`, and related variants) now resolve through the same CLI
  mapping slot without defining fake native provider models.
- Unified provider identity and routing across exactly 40 bundled providers via
  `RAW_BUNDLED_PROVIDER_METADATA` and declarative capability matrices.
- Preserved CLI aliases through the in-memory route snapshot and exposed the
  post-mapping `routedModel` beside the client-requested model in Console Log.
- Credential decryption failures now surface as account/pool authentication
  failures with actionable re-save guidance instead of generic unknown or
  transport errors.

### Architecture & composability

- Reorganized `src/providers/` by domain ownership: provider implementations reside under `integrations/`, shared infrastructure is partitioned into `authentication/`, `quota/`, `discovery/`, and `operations/`, and foundational registry contracts stay at the root.
- Clean root module relocations: moved single-child nested controllers directly to their domain root (`src/transport/dispatch/proxy-request.ts`, `src/providers/discovery/probing-service.ts`) and eliminated redundant directories.
- Clean feature cutoff: completely excised the legacy Filter Sanitize feature cluster end-to-end (removed runtime text scrubbers, dashboard routes, query hooks, database tables, and baseline schema artifacts) with zero backward-compatibility facades.
- Dead-code sweep with no compatibility aliases: removed the unreachable canonical `citation` content variant and its consumer branches, the dead `extension_fields` provider opt-in with its field-promotion mechanism, 39 unused persistence row-type aliases, and the unused generation-control passthrough fields, client-version refresh wrappers, quota target listers, upstream status mapper, and provider URL/User-Agent constants left behind by earlier refactors.
- Removed the remaining declare-thread-discard fields: `OpenAICompatibleAdapterConfig.model_discovery_endpoint` and the `ApiKeyProviderSpec.discovery` option that only fed it, `BundledProviderCatalog.endpointsByProvider`, `ProviderDispatchContext.network_binding` (with `buildUpstreamDispatchContext`'s now-unread `binding`/`candidate` inputs), `TransportPipeline.stages`, `SURFACE_DESCRIPTORS[].pathPrefixes` (an array-of-one whose inner `surface` restated the descriptor's own), `KimiModelBootstrap.thinkingMode`, `QoderModeProfile.cosyVersion`, `ClaudeCredentialPolicy.header_name`, `GuideStep.copyable`, `StudioSessionSummary.mediaCount`, and the dashboard's `ProxyPoolSummary.{disabled,configuredMaxConcurrency}`. `responseParts` no longer extracts a `reasoningSignature` no caller read, and the three one-line surface usage wrappers now call the `providers/usage.ts` builders directly.
- Removed the remaining restated-vocabulary tables: `REJECTED_HEADERS` (a drifted second copy of the security layer's `BASE_PROTECTED_HEADERS`, now read through `isProtectedHeader`), `LOG_LEVELS` (the `CONSOLE_LOG_LEVELS` tuple is the single source and `ConsoleLogLevel` derives from it), the settings `RESPONSES_*`/`MESSAGES_*`/`REDIS_MODES` arrays that restated their own union types, `mapReasoningEffortToWireTier`'s unreachable identity table, and the re-exported `GROK_VERSION`/`CODEBUDDY_TRANSPORT_VERSION`/`CODEBUDDY_OAUTH_VERSION` aliases (every consumer now reads the `FALLBACK_*` constants).
- `GatewayShellDeps` (the route-only constructor in `src/app.ts`) now declares only the knobs route-only mode reads. The six transport/console options it accepted but silently ignored — `db`, `resolvePeerAddress`, `trustedProxyBoundary`, `maxBodyBytes`, `requestDeadlineMs`, `verifiedHttps` — are gone, so passing one is a compile error instead of a no-op. The route-only constructor itself stays: `bun run build:aot` and no-database boot depend on it.
- Protocol dependency inversion: error mappers, tool prefixing, and OAuth token ceilings reside in `src/protocol/`, keeping transport codecs decoupled from provider internals.
- Deduplicated shared logic that had been copied per provider and per surface. The CodeBuddy family (`cb`, `cbcn`, `workbuddy`) now shares one `src/providers/integrations/buddy-chat-shared.ts` for payload normalization (mandatory `stream`, conditional `reasoning_summary`, agent-field stripping) and consecutive-`user`-turn coalescing; each provider keeps its own identity headers and catalog table. The Messages surface reads `stringValue`/`finiteNumber` from `protocol/primitives` like every sibling surface instead of redefining them, and `provider-registry.ts` re-exports `BundledProviderId` from `provider-metadata.ts` instead of declaring a second copy.
- Collapsed pure forwarding aliases into their canonical implementations (`sanitizeSchemaForAnthropic`, `freezeSnapshot`, `REASONING_EFFORT_VALUES`, the `PROVIDER_CUSTOM_HEADER_*`/`PROVIDER_PROTECTED_HEADERS` header constants, `CLAUDE_CODE_COMPATIBILITY_VERSION`) and removed a duplicated `OptionalIntConfigEntry` declaration in `src/config.ts`.
- Extracted the buddy-family Tencent billing-meter parser into `src/providers/integrations/buddy-quota-shared.ts`. `codebuddy-quota.ts` and `workbuddy-quota.ts` had carried the same refill/bonus split, cadence labelling, and bonus numbering twice; each now keeps only its endpoint, identity headers, and display name. The shared module's behavior is covered by `test/providers/integrations/buddy-quota-shared.test.ts`.
- Extracted the buddy-family auth token envelope into `src/providers/integrations/buddy-oauth-shared.ts`, removing the duplicated `data.{accessToken,refreshToken,tokenType,expiresIn}` accessor from `codebuddy-oauth.ts` and `workbuddy-oauth.ts`. Their header sets and response-code handling stay per provider — those have genuinely diverged.
- Finished that extraction: the buddy-family device login is one flow again. `buddy-oauth-shared.ts` now owns the state POST, the `11217` token poll, the refresh POST, the identity header set, and the JWT account label behind one `BuddyOAuthClient` parameterized over a `BuddyOAuthVariant`, so `codebuddy-oauth.ts` and `workbuddy-oauth.ts` hold only their variant — endpoints, domain, platform, user agent, and envelope-code reading. This supersedes the note above that header sets and response-code handling must stay per provider; the one real divergence is preserved and pinned by `test/providers/integrations/buddy-oauth-shared.test.ts`: CodeBuddy reads the envelope code strictly, WorkBuddy through `Number()`.
- Unified the responses-native model-id predicate: `isInferhubResponsesModel` and the discovery-local `isResponsesNativeModelId` were the same rule stated twice, so both now read `isResponsesNativeModelId` from `src/providers/model-definition.ts`.
- Extended `buddy-chat-shared.ts` with `applyBuddySystemPrompt`, the message envelope every buddy variant with a fixed leading prompt applies (drop caller `system`/`developer` turns, install the variant's prompt, rebuild bare string user content as a typed text block, coalesce consecutive user turns). `codebuddy.ts` and `workbuddy.ts` had carried it verbatim; each now passes only its own prompt constant. CodeBuddy CN keeps its own path — it neutralizes caller system text rather than replacing it — and shares only `coalesceConsecutiveUserMessages`.
- Moved the two test-only modules that lived under `src/` to `test/helpers/` (`provider-dispatch.ts` from `src/providers/integrations/test-helpers.ts`, `cli-injector.ts` from `src/console/cli-tools/injectors/test-helpers.ts`), migrating all four importing suites. `src/` now contains production code only, and the coverage gate no longer measures test scaffolding as production lines.
- Moved the shared message-text extractions into `src/transport/canonical-model.ts`: `firstUserText` (Antigravity session seed, [CC] billing suffix) and `joinTextParts` (Cursor, Devin, and CommandCode single-string wire fields) each replace a per-provider copy, so the captured shape is defined once.
- Extracted the provider/account operations layer into `src/console/providers/catalog/provider-operations.ts` (`createProviderCatalogOperations` + `ProviderCatalogConfig`), matching the existing `model-operations.ts`. `routes.ts` now holds only the Elysia body schemas and `createProviderCatalogRoutes` (823 → 386 lines).
- Moved the native Codex Responses-compact handler into `src/transport/dispatch/responses-compact.ts`. `proxy-request.ts` keeps only the canonical dispatch path and no longer imports the compact route's preparer, model predicate, or adapter.
- `ProviderProbingService` builds its provider wire context through one `wireContextFrom` helper and reads the provider row through one `loadProviderWireRow` helper, replacing three inline context literals and two duplicate selects. Static-endpoint resolution now goes through the exported `staticEndpointForWire` instead of a private second copy, and the unreachable static-definition merge in `persistDiscoveredModels` is gone.
- The API-key model allow/deny rule has a single implementation: `modelRejectionReason` in `src/security/api-key-auth.ts` returns `ModelRejectionReason | null`, and `isModelAllowed` is now its boolean projection. `admit()` no longer runs a second, independently written copy of the same rule.
- Split `dashboard/src/routes/ProviderDetail.tsx` into four props-only modules under `dashboard/src/routes/provider-detail/` (`RoutingStrategyCard`, `Accounts`, `OAuthDialogs`, `Models`), taking the route file from 2621 to 486 lines with no behavior change.
- Moved Studio's client tool layer into `dashboard/src/routes/model-lab/tools.ts` and its key-persistence unit into `dashboard/src/lib/studio-session-storage.ts`, so the tool-execution tests no longer pull in the whole route module.
- Removed the never-read Gemini thought-signature capture from `protocol/response/gemini.ts` (`responseParts` no longer returns `reasoningSignature`, per call or per response — none of its four consumers read it, and the outbound `thoughtSignature` emit in `protocol/request/gemini.ts` is untouched). The same pass collapsed the three one-line surface usage wrappers (`outputUsage` in `chat/encode.ts`, `wireUsage` in `messages/encode.ts`, `usageToWire` in `responses/encode.ts`) onto the `providers/usage.ts` builders they renamed, so each surface now calls the canonical usage-to-wire home directly.
- Deleted four single-caller indirections that carried no policy. `devinModel` in `integrations/devin/catalog.ts` became a plain `defineModel({...})` literal, the idiom the other catalogs already use. `encodeCursor`/`encodeEventCursor` in `console/domains/{audit,stats}/store.ts` went away with their `encodeCursor as encodeGenericCursor` import aliases, the `{createdAt, id}` projection now written at the call site — which also dropped two non-null assertions. `getToolDef` in `console/cli-tools/contracts.ts` went away with it: its one caller's job is membership, so `CliToolService.isValidTool` is now `Object.hasOwn(TOOL_REGISTRY, toolId)`. That is a fix, not a simplification — the old `TOOL_REGISTRY[id as ToolId] ?? null` walked the prototype chain and reported `true` for `"toString"`, `"constructor"`, and `"__proto__"`, on a gate that `saveMappings` reads `TOOL_REGISTRY[toolId]` right behind; `test/console/cli-tools/cli-backend.test.ts` pins it. `createPerformanceOperations` in `console/domains/performance/routes.ts` was a factory with one caller and no test, unlike every sibling domain's operations layer, so its two statements moved into the route handler.
- `console/settings/contracts.ts` no longer re-exports `RedisMode`. The type belongs to `persistence/readiness.ts`, and the re-export's only consumer was the dashboard's type-mirror block in `dashboard/src/lib/contracts.ts`, which now imports it from the canonical module.
- Collapsed the hand-restated literal unions that fed Elysia body schemas into projections of the canonical runtime tuples. `WIRE_FAMILIES` (`transport/canonical-model.ts`), `REASONING_EFFORTS`, `TRANSPORT_KINDS` (`network/pool/agent.ts`), `CREDENTIAL_KINDS`/`ACCOUNT_STATUSES` (`console/providers/catalog/contracts.ts`), `POOL_KINDS`/`POOL_STATUSES` (`console/routing/pools/contracts.ts`), `SHARE_LINK_KINDS` (`persistence/schema.ts`), and the probe's deliberately narrower `PROBE_REASONING_EFFORTS` (`providers/discovery/discovery-types.ts`) are now the single declarations; the TypeScript unions derive from them and a new `literalUnion` helper (`console/shared/elysia-schema.ts`) builds each `t.Literal` union from the same tuple. `t.UnionEnum` was rejected as the helper: it stamps a `default` of the first member, which would make an absent body field validate as that member instead of staying absent. Every rewritten schema was diffed against its pre-change literal list and emitted JSON — all twelve byte-identical. The routing and combo schemas now read `ROUTING_STRATEGIES` and `modelComboStrategy.enumValues` directly, so a new strategy cannot land in the tuple and be missing from the HTTP boundary.
- Structural copies in the console now derive from their source. `UpdateProviderRoutingRequest` is `Partial<ProviderRoutingSetting>` (it had restated the six fields, drifting from the runtime type and the body schema), `UpdateRuntimeSettingsRequest` is `ConsoleSettingsPreferences`, and `StudioSessionRow` is `typeof studioSessions.$inferSelect` — which let `DrizzleStudioSessionStore` drop its nine-field `map()` and return rows directly. `CONSOLE.md`'s "five coordinated edits" note for a new runtime preference is now three, because the request type is the persisted bag.
- Merged the remaining provider-family duplication. The buddy static catalogs share one `buddy-catalog-shared.ts` (the seven-field `BuddyRawEntry` tuple and `makeBuddyModel`), so `makeCodebuddyModel` and `makeWorkBuddyModel` are gone; identity headers deliberately stay per provider. `cursor`, `devin`, `kimi`, and `muse` each exported a class *and* a factory *and* a singleton for one adapter, with tests split between the two seams — the class is now module-private and the factory is the one construction path, matching the other sixteen adapters. The Gemini-family SSE line policy is one `decodeGeminiStreamEvent` in `protocol/response/gemini.ts`, shared by Gemini and Antigravity; the two real divergences stay at the call site, since `[DONE]` means *skip* to one and *stop* to the other. `codexJwtAccountId` reads its claims through the shared `decodeJwtPayload` instead of a local `atob(…replace(/-/g,"+")…)`: the two agreed on every ASCII payload, but `atob` decodes to a Latin-1 string, so a payload containing multi-byte UTF-8 came back mojibake. `provider-version-cache.ts` and `model-discovery-cache.ts` had each hand-rolled the same `Map<number, TtlCache<T>>` + `cacheFor(ttlMs)` memo; `TtlCacheFamily<T>` in `runtime/ttl-cache.ts` now owns it.
- `providers/discovery/probe-wire.ts` no longer carries its own `DISCOVERY_CONFIG_BY_PROVIDER` endpoint table — it was a byte-identical second copy of the registry's `endpointPathsByWireFamily`, and it had already drifted. `discoveryPathsFor` reads the registry, so endpoint paths are declared once. That measurement surfaced three real defects, all fixed and pinned by `test/providers/endpoint-map-parity.test.ts`: `ollamacloud` advertised `native` and `messages` paths that its adapter spec rejects with `capability_unsupported`, and `opencodeft`/`opencodezen` advertised a `messages` path with no catalog row and no support in `supported_wire_families`.
- Fixed a silent stream-truncation bug in the Qoder adapter. Its pre-stream deadline was released only in `finally`, so the timer stayed armed across the response body; every other streaming adapter releases it as soon as headers arrive, because from there the gateway's stall/first-chunk watchdog owns the body. The symptom was silent rather than loud — `decodeSseEvents` cancels its reader on abort, so the read resolves as *done*, the loop exits, and `qoderBodyToCanonicalEvents` then synthesized a `state: "complete"` terminal for a body it never finished reading. A healthy slow stream came back as an empty successful response. `test/providers/integrations/qoder.test.ts` reproduces it and fails without the fix.
- The dashboard's session mirror is derived, not hand-written, and finally guarded. The backend `SessionStatusResponse` is now a discriminated union on `status` (the route already emitted every authenticated field together, so the flat optional bag let the mirror omit `username` and mark `display_name`, `is_first_boot`, and `session_expires_at` required without a compile error). `dashboard/src/lib/contracts.ts` aliases `SessionResponse` to it and pins `SessionUser`'s field set in `dashboard/src/session-parity.test.ts`; the two dashboard fixtures missing `username` were corrected. Two further unguarded dashboard provider-id copies — `ProviderIcon.tsx`'s `iconAssets` and `Providers.tsx`'s `FREE_*`/`FOUNDING_IDS` sets — are covered by `dashboard/src/provider-lists-parity.test.ts`. That guard immediately caught a real drift: `workbuddy` had no icon entry, so every WorkBuddy row rendered initials instead of the logo.

### Provider ecosystem & protocol fidelity

- **Codex and Claude model SKUs now expose the current provider catalog.** Codex gains
  `gpt-6-sol`, `gpt-6-luna`, and `gpt-daybreak-blue-latest`, and its `gpt-6-astra`/`gpt-5.5`
  context windows are corrected to the 272k the ChatGPT Codex backend actually serves (the 5.6
  generation keeps 1M). Claude gains `claude-mythos-5`, `claude-mythos-5-1`, and `claude-opus-5-5`
  on both the Claude Code and API-key surfaces plus the discovery fallback, with
  `claude-sonnet-4-6` output and `claude-opus-4-5`/`claude-sonnet-4-5` limits aligned to the
  anthropic catalog. Reasoning-effort ladders follow the reference per model — budget-era Claude
  drops `max`, the 4.6 pair stops at `high`, new-gen Claude and the OpenAI 5.6/6/daybreak rows take
  `max` without `minimal`, and `gpt-5.5` takes neither — enforced at the Messages codec as well as
  the chat/Responses codecs. The Claude fingerprint is now a view over `VERSION_SOURCES`: the CLI
  fallback moves to `2.1.280` (current `@anthropic-ai/claude-code`) and the SDK version to
  `0.112.1`, the release-bundled value the Claude Code release ships into the OAuth refresh User-Agent, replacing
  npm's standalone-SDK latest, which never matched what Claude Code ships. The Codex adapter also
  warms its version cache through the adapter's own fetch instead of `globalThis.fetch`.
- **A reasoning effort a model cannot serve no longer kills the request.** `mimo-v2.6` answers
  `minimal`, `xhigh`, and `max` with a bare `500 {"type":"error","error":{"message":"Internal server
  error"}}` that names no parameter — a client asking for `xhigh` simply saw the request die, with
  nothing to act on. Verified live against OpenCode's `/zen/v1` on 2026-09-22: `low`/`medium`/`high`
  and an omitted field answer `200`, while that model's siblings on the very same endpoint
  (`mimo-v2.5-free`, `nemotron-3-ultra-free`, `big-pickle`) accept the full ladder — so the narrowing
  is a property of the model, not the route, and the resolver now applies it there. Every level the
  clamp can return is accepted by all hosts of the id, so the worst case for a host that would also
  take `xhigh` is one tier below what was asked instead of a failed request.
- Proxy pools now record network/tunnel failures as health events and enter `degraded`/`cooldown`,
  leaving new route snapshots until a successful pooled request, operator recovery, or expiry sweep.
  The Proxy page shows recovery and health history, and its existing SSE stream now carries pool
  status/error transitions alongside live inflight usage. Provider-scoped upstream 429 cooldowns
  remain per-provider and do not sideline an otherwise healthy proxy.
- **OAuth failures now say what to do.** A token exchange that threw a `GatewayError` authored by one
  of our own integrations showed only "token exchange failed — check the console log for details", so
  an actionable reason — for example a provider integration reporting that a required local resource is
  unavailable — was visible nowhere but the server log. `GatewayError.origin` already marks which
  boundary authored a message, and its contract calls a non-upstream error safe to expose, so a
  `cartethyia`-origin message is now shown as-is. Upstream bodies, network failures, and arbitrary
  throws keep the generic wording — an upstream response can echo credentials.
- Prompt-cache identity is now surface-independent: `resolvePromptCacheKey` reads the caller's
  explicit cache key from any wire (chat `extension:prompt_cache_key`, Responses
  `extension:responses.prompt_cache_key`, Messages `extension:metadata_user_id`) before falling
  back to the inbound session id, so switching surfaces mid-conversation no longer misses the
  upstream cache. Client IP stays out of the key — it is telemetry, not cache identity.
- Cline `api_key` accounts probe `/models` for connectivity instead of the OAuth-only
  `users/me` surface: keys carry no OAuth envelope and upstream exposes no quota endpoint for
  them, so a 401 from `users/me` would be an unactionable credential verdict. The OAuth path is
  unchanged.
- Tool-history repair now covers all three shapes an OpenAI-compatible upstream rejects with `tool_call_sequence_broken` (WorkBuddy/CodeBuddy code `11148`), not just one. `repairRequestToolCalls()` previously synthesized a `<missing tool output>` result for a `toolCall` with no answer — but left a **`toolResult` whose `toolCall` is absent** and left results **split by an interleaved turn** (Codex's `image_resize_notice` lands between two parallel results) untouched, and both are rejected the same way. It now drops orphan results, fills missing ones, and repacks interleaved batches so results are contiguous. This matters because a broken history stays broken: the client replays it on every later turn, so one bad round kills the whole conversation. Verified end to end — the orphan result reached the wire before the fix and does not after.
- Upstream error envelopes whose code is a **number** with the specific string nested in `extError` (the WorkBuddy/CodeBuddy shape) lost both their code and their message: `mapUpstreamHttpError` read only a nested string `code`, and `extractUpstreamMessage` never looked at the top-level `msg`. A 400 that explained itself exactly — "tool calls and tool results do not match" — reached the operator as an empty message with no provider code. Both are now extracted, preferring the most specific string available.

- The base-catalog lookup now resolves context/output limits and pricing **per provider**. A bare model id is not unique in the models.dev snapshot: `claude-sonnet-4-6` is recorded under 32 providers, and 428 bare keys disagree about `context` (503 on `output`, 551 on pricing). The lookup kept the first row it saw, so the winner was whichever provider sorted first — `302ai` — and a Cartethyia model could report a reseller's limits and price. `resolve(providerId, modelId)` still prefers an exact `provider:model` hit; the bare fallback now answers only when every row for that id agrees, and returns `undefined` otherwise so the caller keeps its own declared values. Discovery callers pass their `providerId`, so limits come from the row for the provider actually serving the model. Two existing tests were asserting the old arbitrary winner (`cb:hy4-preview`, `cb:deepseek-v4.1-flash` — `cb` has no row in the catalog at all) and were corrected to assert the new, honest behaviour. Also removed `refreshWorkBuddyClientVersion`, which had no caller.

- **Codex Responses**:
  - Enforced `fc_` prefix compliance on tool call items in Responses payloads, resolving upstream validation rejections.
  - Resolved duplicate reasoning summary emissions by deduplicating delta streaming chunks against terminal `output_item.done` summaries while preserving encrypted continuation state.
  - Attached persistent `prompt_cache_key` mapped to the active session identifier (`effectiveSessionId`) on every turn, matching official `codex-rs` caching behavior.
- **Qoder (Modern Cutover)**:
  - Completely decommissioned legacy COSY v0.1.43 profiles and switched exclusively to `MODERN_PROFILE` pointing to `https://api2.qoder.sh`.
  - Added dynamic version resolution via `createClientVersionResolver` targeting npm `@qoder-ai/qodercli` with automated TTL caching and modern `1.0.22` fallback.
  - Injected modern business headers (`cosy-business-product: "cli"`, `cosy-business-type: "agent"`, `cosy-scene: "assistant"`, `x-model-key`, `x-model-source`) and enabled top-level system prompt mirroring into `chat_prompt` and context.
- **Custom (BYOK) Providers & CLI Identity**:
  - Added official CLI request header emulation for custom OpenAI-compatible (Codex CLI User-Agent & originator) and Anthropic-compatible ([CC] CLI User-Agent & Stainless headers) endpoints.
  - Supported optional `cli_identity` toggle in `CompatibilityProfile` and exposed it via dashboard modal controls.
  - Fixed custom provider model discovery in the dashboard so custom endpoints never hide the "Fetch models" action, while cleanly hiding it for builtins lacking discovery implementations.
  - Model discovery no longer overrides the provider's own wire contract. The generic `/models` fetcher carries no wire information, so it guessed a family from the model id alone — `chat` for everything, `responses` for `gpt-5`/`gpt-6`/`o3`/`o4`-style ids — and `applyDiscoveredWire` let that guess win. A Messages-only custom provider therefore persisted every discovered model as a `chat` row, and each probe died with `capability_unsupported`: `htf supports only wire family "messages", got "chat"`. The same class hit chat-only OpenAI-compatible providers, whose `gpt-5.x` ids were routed to a `responses` wire the adapter rejects. A guess is now admitted only when the provider's derived `supportedWireFamilies` contains it, the cross-wire `discoveryPaths?.chat` endpoint fallback is gone, and a sync prunes the superseded `discovered` rows for the ids it resolved — a corrected wire family lands on a new `(model, endpoint)` row, so the stale pair would otherwise survive as a dead route. `ProviderResponse.supportedWireFamilies` exposes the derived set, and the dashboard's Add-Model wire selector is constrained to it instead of re-deriving the rule.
- **CodeBuddy & WorkBuddy**:
  - Replaced per-request random UUID generation for `x-conversation-id` with inbound session preservation (`x-conversation-id`, `x-session-id`, `x-session-affinity`, `x-opencode-session`), preserving upstream conversation continuity and prompt cache reuse.
- **Grok CLI, Muse, Devin, Cursor, Antigravity, and Claude Code ([CC])**:
  - Maintained provider-native wire adaptations, protobuf serialization, and token/quota tracking with high prompt-cache hit rates across production workloads.

- Restored the MiMo flash row to the bundled OpenCode catalog and made a broken alias diagnosable. `opencodeft/mimo-v2.6-flash-free` is live on the shared `/zen/v1` base, but the bundled catalog had stopped declaring it, and `seedBundledModels` deletes every `builtin` row the catalog no longer declares — so the next boot pruned it and both tenant aliases that address it by name (`mimo-2.6-flash`, and the `fallback-mimo2.6` combo member behind `cb/deepseek-v4.1-flash` and `workbuddy/deepseek-v4.1-flash`) began answering `model_not_found`, which reads like a typo in the client's own request. The row is back with its authoritative models.dev metadata (200k context, 32k output, free, text/image/document/audio input, reasoning), and `model_not_found` now carries the post-alias/combo target in both its message and `details.resolved_models`, so the missing target is visible instead of hidden behind the alias name. A catalog test pins the row and a routing test pins the diagnostic.

- OpenCode tier limits and pricing now resolve from the committed models.dev snapshot instead of hardcoded numbers. Every `defineModel` row in the three OpenCode catalogs carried explicit `ctx`/`out`, which silently overrode `modelsDevCatalog.resolve()`, and fourteen of them disagreed with the snapshot this repository already ships: `mimo-v2.5-free` claimed 512k/64k against 200k/32k, `nemotron-3-ultra-free` 128k/32k against 1M/128k, `deepseek-v4-flash` 128k/32k against 1M/384k, and `big-pickle` an output limit double the real one. The overstated direction is the dangerous one — the gateway admits a request the upstream then rejects — while the understated rows silently capped what the model could serve. Rows the snapshot covers now pass `providerId` and declare no limits, so the snapshot is the single source; the three rows newer than it keep explicit limits, and the MiMo row pins `free` so its cost resolves to zero instead of an unknown fallback. A catalog test now fails on any row whose limits disagree with the snapshot, verified by reintroducing the old `big-pickle` output limit.

### Dashboard & observability
- Usage request telemetry now persists the client-facing HTTP status as metadata. The Requests
  panel has clickable 200/499/503 filters with period-wide counts; 499 cancellations are a
  separate sub-count, not an error, while failed and truncated requests remain errors. Breakdown
  now sits left of Traffic. Payload-body capture defaults off (metadata remains stored), and
  metadata retention defaults to 30 days via `CARTETHYIA_TELEMETRY_RETENTION_DAYS`. Previously
  the Usage page offered `7d`/`30d`/`all` while telemetry was pruned after 3 days, so long-window
  totals were silently capped and could shrink as older rows were pruned.

- **Quota Management can now redeem Codex and Claude saved rate-limit resets, and every
  attempt is logged as account health activity.** Both providers keep a small pool of
  "reset credits" that lift a spent window before its natural reset, and both are reachable
  from the account's own credential: Codex through
  `GET/POST /wham/rate-limit-reset-credits[/consume]` (the consume body carries a
  `redeem_request_id` idempotency key, so a retry cannot double-spend), Claude through
  `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` — falling back to the Juniper
  `at_wall=1` session reset — plus `POST /api/organizations/:orgId/reset_rate_limits` with a
  `cedar_ember` grant (`{ program, grant_id, request_id }`) or `{ program: "juniper_tide" }`.
  The card reads the account's live inventory from a dedicated `GET /accounts/:id/resets`
  rather than mirroring a count onto the quota payload, because Claude's usage body leaves the
  `cedar_ember` block `null` until the probe asks for it — a mirrored count would silently read
  zero. The Zap action opens a per-account table listing every credit with its **status, title,
  granted-at, and expiry**, each with its own **Use** button (the backend still auto-selects the
  soonest-expiring credit when none is named, since credits are perishable and expiry order
  maximizes the bank's value). The provider set is one shared predicate
  (`supportsAccountReset`) so the button and the route agree, and both provider User-Agents come
  from the existing authorities — `getCodexVersion()` (`codex_cli_rs/<version>`) and
  `CLAUDE_CODE_USER_AGENT` (`claude-cli/<version> (external, cli)`) — so the reset calls never
  carry a hardcoded version that drifts from what dispatch sends. A successful redemption
  also repairs the account in place: `consecutiveFailures` resets to 0, `cooldownUntil` clears,
  and `status` returns to `active`, so the account rejoins dispatch rotation immediately
  instead of waiting out a cooldown that no longer reflects reality. Success and failure both
  write a `health_events` row (reason `Rate limit reset consumed …` or
  `Rate limit reset failed: [code] …`), so the outcome lands in the account's existing Health &
  Error Log modal rather than a separate surface. `listAccountResetCredits` and
  `consumeAccountResetCredit` live in `src/providers/operations/account-reset-service.ts`.
- Dashboard polish pass: mobile pull-to-refresh on scrollable routes, SSE-driven live views
  (in-flight, pools, logs) that stay fresh without a manual reload, provider toasts on mutations,
  custom-provider model wire types constrained to the families the backend resolves for that
  provider, the API-format
  selector hidden for Anthropic-compatible providers, Usage breakdown rows rendered without a
  fail column, and Studio's `web_search` tool removed (web-fetch only).
- A client-cancelled request no longer reports as an unexplained gateway failure. Telemetry labelled every non-`GatewayError` abort `unknown_error` with origin `cartethyia`, so a request the client simply hung up on (TTFB 9.15 s, no content delta ever, disconnect at ~119 s) rendered in Usage as `499 · "the upstream failure could not be classified"` — blaming the gateway for an ordinary cancel. `classifyTerminalCategory()` now reads the abort signal behind the failure: a `TimeoutError` deadline reason becomes `deadline_exceeded`, a `GatewayError` reason (stall watchdog) keeps its code, any other aborted signal becomes `transport_closed` ("request was cancelled by client"), and only a failure with no abort behind it stays `unknown_error`. The streaming and attempt-loop paths both use it, pinned by five regression tests. Separately, the operator-facing effect of model aliases is now documented (`TRANSPORT.md` planning, `CONSOLE.md` routing): `requested_model` keeps the client-facing name while the provider columns show the resolved target, so a row like `claude-opus-5` served by `opencodeft` is an alias or CLI mapping working as configured.

- Added a **Client IP** breakdown to the Usage page. The backend gained a `client_ip` dimension that groups telemetry by stored address and masks on read through the same fail-closed gate as the request list (`privacyMode !== "full"`); because masking can collapse two hosts into one display name, rows sharing a masked name are re-aggregated so the operator never sees two indistinguishable rows or understated totals. The dimension list is one runtime tuple (`USAGE_DIMENSIONS`) read by the route table, the operations validator, and the dashboard union — the four hand-written `by-<dimension>` routes became one parametric `/system/usage/by-:dimension`, so adding a dimension can no longer reach one layer and miss another.
- Each breakdown row now reports hits, successes, and failures, with the card subtitle totalling them across the group. Previously a row showed only a request count and the failure count was computed but never surfaced.
- Fixed the Usage breakdown tab not switching. The page keeps its view state in the URL and re-renders on its own every 10s (four queries carry `refetchInterval`), so a handler that built its `URLSearchParams` from the `searchParams` of an earlier render could write that stale snapshot back and revert a sibling parameter — a click set `dim` and a concurrent update from an older closure restored the previous value. Parameter updates now go through React Router's functional form via a tested `withParam` helper, so only the intended key changes.

- **Usage & Metrics**:
  - Aligned "Cached tokens" metrics to aggregate total input tokens covered by cache hits (`inputTokens` where `cachedInputTokens > 0`), ensuring consistent cache efficiency visibility across summary cards and breakdowns.
  - Corrected request table display to format cache as `{cached} / {input}` tokens.
  - Removed deprecated error summary cards in favor of focused capacity and throughput metrics.
  - Upgraded Requests table with 50-entry initial capacity, auto-paging dynamic scroll loading (+50 per page up to 500), and transient highlight animations for newly completed requests.
  - Added privacy masking toggle ("Mask" / "Mysterious") replacing provider labels and truncating model slugs while retaining full tooltips on hover.
  - Refined in-flight request indicators and status pills to use clean, accessible typography without distraction.
- **Branding & Layout**:
  - Replaced the placeholder "C" icon in the dashboard sidebar with the official Cartethyia branding asset (`favicon_love.webp` with fallback and Customization overrides).
  - Expanded request detail drawer on mobile viewports (`max-width: 640px`) to a full-screen sheet, eliminating awkward top spacing.

### Security, database & migrations

- Telemetry now records **which layer** failed, beside the error code. `errorCategory` alone could not separate the gateway's own failures from an upstream's: `invalid_request` is written both when the caller's body is malformed and when the provider rejects a well-formed body, so an operator triaging a spike could not tell whether to look at the router or at the provider. `telemetry_events.error_origin` (`cartethyia` | `upstream` | `network`) is written from the `GatewayError`'s own origin at every dispatch and ingress failure site, and the Usage drawer prefixes the layer onto the message. Existing databases converge with the hand-run idempotent DDL in `drizzle/migrations/manual/0006_add_telemetry_error_origin.sql`; rows written before it read as unknown.
- Every non-`active` account classification now carries a `retryAt`. `sweepExpiredCooldowns` selects on `cooldownUntil IS NOT NULL`, so the `degraded` classifications — 5xx, timeout, and unclassified failures — which set `retryAt: null` were **never swept back**: the account stayed unroutable until an operator restored it by hand. A new 1-minute budget covers the unclassified case.
- The console now shows per-model backoffs. A throttle with a `modelId` cools the (account, model) pair through `modelCooldowns` rather than the account, so the account stays usable for every other model — but that map was never sent to the console, so the table read `Active` for an account whose requests for a throttled model were all being routed away. `ProviderAccountResponse.modelCooldowns` carries the still-live deadlines (expired ones dropped) and the account badge reports them.
- Added the thirteen `GatewayErrorCode` values that had no dashboard label, so they render a sentence instead of a mechanical underscore-to-space of the raw code.

- Single consolidated database baseline migration (`drizzle/migrations/0000_baseline.sql`) verified against strict integrity contracts.
- Dropped deprecated `filter_rules` table and columns cleanly from PostgreSQL persistence and schema definitions.
- Dropped the unused `network_pools.degraded_since` column from `schema.ts` and the baseline; existing databases converge with the hand-run idempotent DDL in `drizzle/migrations/manual/0004_drop_degraded_since_column.sql`.
- Strict CSP, frame ancestry protection, and HMAC-backed API credential validation on all ingress routes.

### Test infrastructure & documentation

- `test/helpers/db-gate.ts` now routes as well as gates. It previously only
  decided *whether* DB suites ran (on `CARTETHYIA_TEST_DATABASE_URL`) while
  `getDb()` resolved `DATABASE_URL`, so a developer whose two URLs pointed at
  different databases ran the suites against their working database and left
  test fixtures there. Setting the isolated URL now rewrites `DATABASE_URL`
  before any pool is opened; CI was unaffected because it already set both.
- `test/console/quota/account-quota.test.ts` registered its `afterEach` /
  `afterAll` cleanup inside the first of its two `dbDescribe` blocks while
  both appended to the same module-scope id arrays, so the second block's
  global accounts were never deleted and accumulated a few rows per run. The
  hooks moved to file scope.
- One layer doc per top-level `src/` folder, covering its whole subtree; the
  twenty per-subfolder docs were merged into their parents and deleted. Each
  doc is named for its layer in caps (`src/console/CONSOLE.md`,
  `src/providers/PROVIDERS.md`, `src/transport/TRANSPORT.md`,
  `src/network/NETWORK.md`) so no two share a basename — only the repo-root
  `README.md` and `dashboard/README.md` keep the `README.md` name. The
  architecture map, contributor guide, agent contract, and develop skill now
  describe the one-doc-per-folder rule.
