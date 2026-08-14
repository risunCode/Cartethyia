# Cartethyia Architecture

## Terminology first

**Client** means the application calling Cartethyia: an OpenAI-compatible SDK, an Anthropic-compatible SDK, an IDE agent, a CLI, or a custom HTTP application.

**Provider** means the upstream service Cartethyia calls after routing: OpenAI, Anthropic, or another configured provider adapter.

OpenAI and Anthropic can therefore appear on both sides of the system, but the roles are different:

- OpenAI-compatible request = client protocol shape.
- OpenAI provider = upstream adapter/transport destination.
- Anthropic-compatible request = client protocol shape.
- Anthropic provider = upstream adapter/transport destination.

Do not call clients “native clients” in architecture diagrams. That phrase is ambiguous here.

## One request, in simple boxes

```text
+---------------------------+
| External client app       |
| OpenAI SDK / Anthropic    |
| SDK / CLI / custom HTTP   |
+-------------+-------------+
              |
              | POST /v1/*
              v
+---------------------------+
| HTTP ingress              |
| method, auth, body limit, |
| request ID, trace ID      |
+-------------+-------------+
              v
+---------------------------+
| Normalize request         |
| OpenAI / Anthropic shape  |
| -> internal request       |
+-------------+-------------+
              v
+---------------------------+
| Admission                 |
| policy, model, quota,     |
| rate, capability checks   |
+-------------+-------------+
              v
+---------------------------+
| Route request             |
| provider -> account ->   |
| network proxy             |
+-------------+-------------+
              v
+---------------------------+
| Translate for provider    |
| internal request ->       |
| upstream wire format     |
+-------------+-------------+
              v
+---------------------------+
| Upstream provider         |
| OpenAI / Anthropic /      |
| configured adapter        |
+-------------+-------------+
              v
+---------------------------+
| Translate response        |
| upstream -> client shape  |
+-------------+-------------+
              v
+---------------------------+
| External client response  |
+---------------------------+
```

## Operator dashboard is a separate plane

```text
+---------------------------+
| Operator browser          |
| /console/* SPA            |
+-------------+-------------+
              |
              | GET/POST/PATCH/DELETE
              v
+---------------------------+
| V2 admin API              |
| /v2/admin/*               |
+-------------+-------------+
              v
+---------------------------+
| Admin services            |
| auth, catalog, providers, |
| telemetry, settings, ops  |
+---------------------------+
```

The dashboard never calls `/v1/*` to implement an operator feature. `/v1/*` is external client ingress. `/v2/admin/*` is browser/admin control.

## Package ownership

```text
daemon/internal/server/api/v1/       external client handlers
daemon/internal/server/admin/        V2 dashboard handlers
daemon/internal/server/middleware/   IDs, client identity, boundaries
daemon/internal/server/api/wire/      bounded JSON/stream writing
daemon/internal/server/api/errors/    public error envelopes

daemon/internal/proxy/contracts/     normalized domain contracts
daemon/internal/proxy/router.go      account retry/fallback loop
daemon/internal/proxy/selectors.go   provider/account/network selection
daemon/internal/proxy/transforms/    protocol translation
daemon/internal/proxy/transport/     provider calls

daemon/internal/observability/       bounded lifecycle evidence
daemon/internal/runtime/             dependency composition

dashboard/src/lib/                   V2 transport and closed parsers
dashboard/src/features/              resource hooks and UI states
```

## Dependency rule

```text
HTTP handler
    |
    v
closed API contract
    |
    v
proxy service / admin service
    |
    +--> admission
    +--> selectors/router
    +--> transforms
    +--> transport
    |
    v
provider or storage dependency
```

Runtime composition injects services. A missing service returns `unavailable`, `forbidden`, or `not_configured`; it does not fabricate an empty success.

## Request lifecycle summary

```text
receive
  -> IDs and client metadata
  -> validate
  -> admission
  -> provider/account/proxy routing
  -> cache marking policy
  -> provider translation
  -> upstream call
  -> retry/refresh/fallback when allowed
  -> response translation
  -> completion/failure/cancellation evidence
  -> client response
```

Details live in the relevant sections:

- routing: [routing](routing.md)
- translation, tools, caching: [protocols](protocols.md)
- contracts, errors, operations, tests: [engineering](engineering.md)

## Non-negotiable invariants

1. One normalized request model crosses the proxy hot path.
2. Provider, account, and network proxy are separate routing decisions.
3. Credentials are represented by opaque `credentialRef` values outside late resolution.
4. Raw prompts, bodies, credentials, cookies, tool results, and provider responses never enter dashboard state or lifecycle evidence.
5. Unknown, empty, unavailable, degraded, and stale are different states.
6. Browser methods are only `GET`, `POST`, `PATCH`, and `DELETE`.
7. `QUERY` is not supported.
8. `src.old/` is historical and is not an active implementation source.
