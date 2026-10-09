# Cartethyia documentation

Start here if you are installing or running Cartethyia:

- [Installation](installation.md) — local / VPS / Docker, Lite and Full modes,
  one-shot install script, systemd, auto-deploy.
- [Getting started](getting-started.md) — requirements, setup, OS guidance, Docker,
  commands, migrations, and verification.

How the system is built:

- [Architecture](architecture.md) — process, request path, routing snapshot, data.
- [Backend](backend.md) — boot, public routes, dispatch, protocol, persistence.
- [Protocol and translation](protocol-and-translation.md) — wire families, the
  canonical model, and where a provider's dialect is applied.
- [Providers](providers.md) — the provider layers, credentials, discovery, and
  what makes each family non-standard.
- [Console API](console-api.md) — the admin/operator surface: domains, feature
  inventory, and the browser mirror.
- [Dashboard](dashboard.md) — pages, data flow, layout, mutations.
- [Configuration](configuration.md) — every environment variable. Generated
  from `src/config/spec.ts`; do not edit by hand.
- [SQLite parity](sqlite-parity.md) — measured dialect differences between Lite
  and Full.

One page per feature — what it is, the data behind it, who owns it:

- [Features](features/README.md) — the index. CLI model mapping, share keys,
  network pools, routing aliases and combos.

The reference pages above hold the indexes (routes, domains, pages) and point
into `features/` for the detail behind a row.

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
