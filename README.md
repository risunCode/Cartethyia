# ![](orca-paste-1790786723417-099ae9d3-f3a2-4dac-9c24-74887febf6fa.png) Cartethyia

<img width="1760" height="576" alt="Cartethyia banner" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

**A self-hosted multi-provider AI gateway.**

Cartethyia gives AI clients one stable, OpenAI- and Anthropic-compatible endpoint
while the gateway handles the operational work behind it: provider-aware
translation, account selection, health-aware failover, quota and cooldown
enforcement, usage accounting, telemetry, and optional proxy pools.

Configure provider accounts once, issue an API key, and point OpenCode, Droid,
Cline, Claude Code, Codex, or any compatible client at Cartethyia. The client
keeps its native protocol; Cartethyia normalizes the request, selects a viable
route, dispatches upstream, and returns the response in the contract the client
expects.

Built with Bun, TypeScript, Elysia, embedded SQLite or external PostgreSQL, and
optional Redis coordination.

> [!WARNING]
> **Development version.** This branch is under active development, so APIs,
> configuration, database behavior, and provider integrations may change without
> notice. Before reporting an error or opening an issue, update to the latest
> version of the upstream `dev` branch and verify that the problem still occurs.
> The stable release will be published on `main` once the current development
> cycle is considered ready.

## Install with npm

The npm package ships Cartethyia's source and dashboard assets; **Bun 1.4.0 or
newer is required to run it**. Install Node.js/npm and Bun first, then install the CLI:

```bash
npm install --global cartethyia
cartethyia setup
carte
```

Setup asks you to choose a database mode:

- **Lite** uses embedded SQLite and needs no database server. It is intended for
  a single Cartethyia instance and is the easiest local install.
- **Full** uses PostgreSQL and requires a reachable server you operate or already
  have access to; the installer does not install PostgreSQL. Redis is optional
  for one process and needed when coordination must be shared between processes.

`carte` starts the gateway in the system tray. The terminal shows a loading
message until the gateway is ready, then returns to the prompt; closing that
terminal does not stop Cartethyia. `cartethyia tray` is an equivalent command,
while `cartethyia start` runs in the foreground. Configuration and application
data remain in the user's OS directories, outside npm's global package.

The tray menu shows the running and latest published versions and offers an
update when npm has a newer release. Choosing it installs the update and starts
the new tray/gateway process before the old tray exits. **Open Console** opens
`http://127.0.0.1:<port>/console`; **Reset password** and **Backup & Restore**
open Console Settings, where password changes require the current password and
backup operations re-authenticate. **Exit** stops the gateway and tray. This does
not install an OS logon/startup service. To remove the CLI, run
`npm uninstall --global cartethyia`.

## Why Cartethyia?

| Capability | Operational value |
|---|---|
| **Protocol normalization** | Connect heterogeneous OpenAI- and Anthropic-compatible clients without making each client understand every provider. |
| **Health-aware routing** | Select by model, alias, capability, account state, cooldown, quota, and provider availability. |
| **Failover with accounting** | Retry viable candidates while preserving admission, usage, quota, and telemetry invariants. |
| **Provider-aware dispatch** | Keep authentication, headers, endpoint behavior, quota semantics, and streaming rules specific to each provider. |
| **End-to-end visibility** | Inspect Client Request → Provider Request → Provider Response → Client Response instead of debugging a black box. |
| **Explicit health semantics** | Keep healthy, cooling, cooldown, exhausted, disabled, and unavailable states distinct. |
| **Deployment flexibility** | Run self-contained with SQLite, use external PostgreSQL for higher workloads, and add Redis when coordination must be shared. |

Cartethyia is more than a router. It gives the gateway a consistent operational
model for provider accounts, routing policy, quotas, proxies, security, telemetry,
and backups.

> **One endpoint. Any client. Any provider. Operable by design.**

## What makes Cartethyia different?

Most gateways stop at “send the request to another provider”. Cartethyia focuses
on the details that make a multi-provider setup dependable in daily use:

| Distinctive capability | What it means in practice |
|---|---|
| **Client-faithful upstream identity** | Provider adapters can reproduce the client identity, headers, billing signals, and wire behavior expected by the upstream service instead of treating every request as a generic API call. |
| **Legitimate request impersonation boundaries** | OAuth/client-specific request behavior is isolated to the matching adapter and credential path; ordinary API-key traffic is not silently mixed with an OAuth client profile. |
| **Continuously refreshed client versions** | Client-version metadata is discovered in the background and reflected in provider-specific headers when required, instead of pinning an old version forever. |
| **Provider-aware routing** | Routing understands model capability, endpoint family, account health, cooldown, quota, aliases, combos, and proxy-pool availability. |
| **Failover that preserves state** | Retries do not bypass admission, usage accounting, quota metering, telemetry, or terminal error semantics. |
| **Four-stage request visibility** | Inspect the client request, translated provider request, raw provider response, and final client response with bounded, redacted capture. |
| **Honest failure semantics** | A disabled account, exhausted quota, unavailable provider, missing model, and network/pool failure remain different operational states. |
| **Web-session providers** | Claude Web, Grok Web, and Kimi Web use pasted signed-in sessions and static catalogs. They are not API-key providers and their sessions are not refresh grants. |
| **Portable deployment model** | Start locally with embedded SQLite, move to external PostgreSQL through JSON backup/restore, and add Redis only when coordination must be shared. |

These are not cosmetic dashboard features. They exist so an operator can answer
the questions that usually require reading upstream logs: **what did the client
send, what did Cartethyia translate, which account and pool were selected, what
did the provider return, and what did the client finally receive?**

## Supported client routes

| Route | What it is for |
|---|---|
| `/v1/chat/completions` | OpenAI-style chat requests |
| `/v1/responses` | Responses API requests, including Codex-style tools and reasoning |
| `/v1/responses/compact` | Responses compaction |
| `/v1/messages` | Anthropic Messages requests, including Claude Code |
| `/v1/completions` | Legacy text completions |
| `/v1/models` | List available models |
| `/v1/search` | Web search |
| `/v1/systemone` | System One decision requests |
Web search uses a stable failover order — **Exa → Gemini → Codex** — for the
providers that are enabled and have an eligible account. The dashboard's Search
detail provides a model dropdown and direct search test; there is no drag-and-drop
ordering preference stored in the database.


The client protocol belongs to the connection, not to the route you configure. Once
a request is normalized, the same routing, admission, retry, accounting, and telemetry
rules apply across the supported surfaces.

## Choose your setup

The application features are the same in both modes. Choose based on how you
intend to run Cartethyia:

| Recommended setup | Choose this when | Why |
|---|---|---|
| **Lite** | Personal use, local development, or one casual gateway process | Embedded SQLite; no PostgreSQL server to install or maintain |
| **Full** | Sharing, selling, VPS deployment, or sustained/high workload | External PostgreSQL is better suited to independent database operations and heavier concurrency |

Lite is not a reduced feature edition. It changes the database backend and keeps
coordination in process memory. When the workload grows, export a JSON backup
from Lite and restore it into Full; the application configuration does not need
to be rebuilt.

`.env.example` defaults to Lite for local installs. Docker Compose defaults to
Full because Docker deployments generally target VPS or higher-capacity use.
See the [Getting started guide](documentation/getting-started.md#choose-a-database-mode)
for the installation details.

## Roadmap and where help is wanted

These are the open items we know about, roughly in the order they unblock real use.
Each is stated with what is already true, so nobody has to re-derive it. If you want
to pick one up, these are the ones worth your time.

| Item | Status | Where to start |
|---|---|---|
| **Web search in Claude Code and Model Lab** | Bridge works; one defect fixed. A served search round was addressed to a gateway-minted `tool_use_id` instead of the client's own, so a hosted-search client could not close its pending tool call and re-issued the search — the "search loops forever" report. Fixed by carrying the caller's `call_id` through the bridge (`websearch-bridge.ts`, `translation/search.ts`). **Not yet confirmed against a live terminal.** | Point Claude Code at the gateway on a search query and confirm the round closes. Then widen native detection: today only `codex` is registered native (`metadata.ts`), while the `antigravity` and `gemini` adapters already frame a correct hosted tool. Registration needs a live proof that a *chat* turn grounds — the existing adapter tests only prove the `/v1/search` service path. |
| **Media generation (image/video) via `/v1` and Model Lab** | Implemented end to end — buddy image through the chat wire, `seedance-2.5` video through its async task API, contract, route, and adapters. Teeth-tested against a mock upstream. **Two seams are unverified against a live upstream** because the CodeBuddy account ran out of credits: the exact field carrying a finished image, and the video task-query path. Both are single constants in `buddy-media.ts` and are marked there. | Re-run one image and one video request with a credited account and correct those two constants. |
| **Memory optimisation** | The 140 MB idle baseline is **native runtime, not a JS leak** — `heapUsed` is 24 MB of 141 MB, so ~117 MB is Bun, OpenSSL, `bun:sqlite`, and the `pg` pool. Code restructuring does not reduce it. `bun run dev` also retains ~25–30 MB per hot reload, which is why the dev server appears to leak and the production binary does not. One genuine defect found and fixed (unbounded Xiaomi SSO caches). **Streaming is still unmeasured** and is the only place a real leak remains plausible. | Read [documentation/memory-behaviour.md](documentation/memory-behaviour.md) — it holds the measurements, the ruled-out list, and the recipe. Then drive large *streamed* responses through a stub adapter and watch `heapUsed`/`external`. |
| **Web search as a first-class provider capability** | Capability is split across two places: a hardcoded allowlist in `metadata.ts` decides "native", while the actual tool framing lives in each adapter. Five adapters (`antigravity`, `gemini`, `claude`, `grok`) already contain working hosted-search code the allowlist never enables. | Move search model and endpoint into provider-level configuration so they share one source of truth instead of a hardcoded allowlist. |
| **Search providers beyond Exa and Parallel** | We ship 2 dedicated search sources: Exa and Parallel. | Add whichever the operator actually wants, following the existing `/v1/search` adapter contract. |
| **Unified `mediaGeneration` service kind** | Requested, not built. `imageGeneration` and `videoGeneration` are separate service kinds, so a provider card cannot show a single "media" section with an Image/Video pill. | Fold the two kinds into one `mediaGeneration` and project the pill from the model's declared output modalities. |

Anything not on this list is probably a bug rather than a plan. Found one? The
fastest way to get it fixed is a reproduction: the request, the provider and account
it hit, and what the gateway answered versus what it should have.

## License

Cartethyia is licensed under the **GNU General Public License v3.0 only**.
See [`LICENSE`](LICENSE) for the complete terms.

You may use, copy, modify, and share this software under GPLv3. If you distribute
Cartethyia or a modified version, you must keep the license and copyright notices,
provide the corresponding source code, and license the covered work under GPLv3.
You may not add restrictions that remove the freedoms granted by the license.

This software is provided **without warranty**. It is distributed in the hope that
it will be useful, but there is no guarantee that it is fit for a particular purpose,
secure, available, or free from defects. See the warranty disclaimer and limitation
of liability in `LICENSE`.
