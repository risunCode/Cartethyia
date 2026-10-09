# Cartethyia documentation

Start here if you are installing or running Cartethyia:

- [Getting started](getting-started.md) — requirements, database mode, `bun setup`,
  encryption key, starting the stack, Docker, migrations, and verification.
- [Installation](installation.md) — local / VPS / Docker, Lite and Full modes,
  one-shot install script, systemd, auto-deploy, endpoints, backup.

How the system is built — [reference/](reference/README.md), one page per layer:

- [Architecture](reference/architecture.md) — process, request path, routing
  snapshot, data.
- [Backend](reference/backend.md) — boot, public routes, dispatch, protocol,
  persistence.
- [Protocol and translation](reference/protocol-and-translation.md) — wire
  families, the canonical model, and where a provider's dialect is applied.
- [Providers](reference/providers.md) — the provider layers, credentials,
  discovery, and what makes each family non-standard.
- [Console API](reference/console-api.md) — the admin/operator surface: domains,
  feature inventory, and the browser mirror.
- [Dashboard](reference/dashboard.md) — pages, data flow, layout, mutations.
- [Configuration](reference/configuration.md) — every environment variable.
  **Generated** from `src/config/spec.ts`; regenerate, never edit by hand.
- [SQLite parity](reference/sqlite-parity.md) — measured dialect differences
  between Lite and Full.

One page per feature — [features/](features/README.md): what it is, the data
behind it, who owns it. CLI model mapping, share keys, network pools, routing
aliases and combos.

## The split

The reference pages hold the **indexes** — route tables, console domain
inventory, dashboard page map, snapshot mechanics. They summarise one row and
link into `features/` for the narrative behind it. Do not grow them into feature
manuals; add a page under `features/` instead.

```text
documentation/
├── getting-started.md    installing and running it
├── installation.md       install variants, one-shot script, Docker
├── reference/            how it is built, one page per layer
└── features/             one page per feature
```

Procedure lives in `.skills/`, not here. Each skill owns one topic and names the
layer's owner: `cartethyia-engineering` (invariants, taste, gates),
`cartethyia-trace-replay` (reproducing a failing request),
`cartethyia-schema-telemetry` (schema and migrations),
`cartethyia-health-routing` (account and model health),
`cartethyia-provider-catalog` (adding and authenticating a provider),
`cartethyia-console-api` (authoring a console domain), and
`cartethyia-dashboard` (browser code). `AGENTS.md` routes you to the right one.

For the product overview, supported clients, and Cartethyia's main benefits, see
[`README.md`](../README.md).

For contribution rules and pull requests, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
