# Reference — how Cartethyia is built

One page per layer. These are the **indexes**: route tables, console domain
inventory, dashboard page map, snapshot mechanics. Each summarises one row and
links into [`../features/`](../features/README.md) for the narrative behind it.
Keep it that way — a feature that needs prose gets a page under `features/`.

| Page | Covers |
| --- | --- |
| [Architecture](architecture.md) | Process, request path, routing snapshot and its invalidation, data, what is intentionally absent |
| [Backend](backend.md) | Boot, public `/v1` routes, dispatch, protocol, providers, routing and network, security, persistence, observability, workers |
| [Protocol and translation](protocol-and-translation.md) | Wire families, the canonical model, request and response path, error mapping |
| [Providers](providers.md) | Provider layers, boot and bundled vs BYOK, credentials and auth, discovery, quota, per-family notes |
| [Console API](console-api.md) | Anatomy of a domain, wiring, the four boundaries, feature inventory, where to change what |
| [Dashboard](dashboard.md) | Shell, pages, data flow, layout rules, mutation feedback, build and serve |
| [Configuration](configuration.md) | Every environment variable. **Generated** from `src/config/spec.ts` by `scripts/generate/config-reference.ts`; regenerate it, never edit it by hand |
| [SQLite parity](sqlite-parity.md) | Measured dialect differences between Lite and Full, and which ones are not defects |

Ownership boundaries live in
[Architecture → Ownership](architecture.md#ownership), and the four console
boundaries live in [Console API → Boundaries](console-api.md#boundaries).

Procedure is not here. `.skills/` owns it — `cartethyia-schema-telemetry` for a
schema or migration change, `cartethyia-health-routing` for cooldowns and
retries, `cartethyia-provider-catalog` for adding a provider,
`cartethyia-console-api` for a console domain, `cartethyia-dashboard` for
browser code.
