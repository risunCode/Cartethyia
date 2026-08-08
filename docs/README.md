# Cartethyia Documentation

Cartethyia is a self-hosted Bun + Elysia AI proxy. It accepts OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages traffic, routes requests across provider adapters, translates protocols, and exposes account, quota, usage, and health controls.

## Start here

1. [Getting Started](./GETTING_STARTED.md)
2. [API](./API.md)
3. [Concepts](./CONCEPTS.md)
4. [Translation](./TRANSLATION.md)
5. [Providers](./PROVIDERS.md)
6. [Operations](./OPERATIONS.md)
7. [Development](./DEVELOPMENT.md)

## Section guide

| Document | Audience | Covers |
| --- | --- | --- |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | New users/operators | Install, configure, first request, Docker, Railway |
| [API.md](./API.md) | API clients | Routes, authentication, streaming, tools, errors, health |
| [CONCEPTS.md](./CONCEPTS.md) | Operators/developers | Architecture, routing, accounts, OAuth, quota, persistence |
| [TRANSLATION.md](./TRANSLATION.md) | Integrators/developers | Canonical requests, responses, streams, reasoning, tools, images |
| [PROVIDERS.md](./PROVIDERS.md) | Operators/developers | Capabilities, auth, headers, quota, custom providers, adapters |
| [OPERATIONS.md](./OPERATIONS.md) | Operators | Docker, Railway, health, security, backups, troubleshooting, performance |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Contributors | Source ownership, translators, providers, tests, releases |

## Source of truth

- Unified middleware boundary and public routes: `src/middleware/`
- Protocol translation: `src/open-sse/`
- Provider adapters: `src/providers/`
- Authentication and account lifecycle: `src/auth/`
- Console and control plane: `src/console/`
- Persistence: `src/storage/`
