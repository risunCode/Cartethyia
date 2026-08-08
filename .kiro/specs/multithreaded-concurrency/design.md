# Native Bun Concurrency Design

## Decision

Keep proxy execution on Bun's native asynchronous HTTP and provider-I/O path. Do not add a custom JavaScript worker pool, worker-thread protocol, or application-level process cluster.

Bun already multiplexes asynchronous requests, fetches, streams, timers, and SQLite calls in the runtime. Moving ordinary requests across a worker boundary would add structured-clone, message correlation, cancellation, memory, runtime duplication, and state-ownership overhead without evidence of a CPU bottleneck.

## Runtime topology

```mermaid
graph LR
  Client --> HTTP[src/middleware/server.ts]
  HTTP --> Boundary[Bounded parse + auth + admission]
  Boundary --> Route[Routing + provider selection]
  Route --> Async[Native async fetch and streaming]
  Async --> HTTP
  HTTP --> Storage[(Existing SQLite repositories)]
  HTTP --> Health[/health and console]
```

`src/middleware/server.ts` remains the only HTTP listener. `src/bootstrap/composition.ts` owns the existing runtime and maintenance schedulers. Deployment-level replicas or process managers may scale the service externally, but that coordination is outside this application.

## Direct request path

```text
HTTP -> bounded body parse -> authentication -> admission/rate limits
     -> route/provider selection -> async fetch/stream -> accounting/logging
```

No request queue, structured-clone envelope, worker message protocol, or thread handoff is introduced. Existing abort, stream, response, persistence, and provider contracts remain the source of truth.

## State ownership

| State | Owner |
| --- | --- |
| HTTP requests and streams | Single Bun server process |
| OAuth refresh scheduling | Existing runtime coordinator |
| Quota refresh scheduling | Existing runtime coordinator |
| Recovery, retention, and GC | Existing runtime maintenance |
| Configuration and runtime SQLite | Existing repositories with WAL/busy timeout |
| Admission and rate-limit counters | Existing process runtime |

## Capacity and backpressure

Concurrency limits remain separate controls rather than targets. The application must continue bounding request bodies, history, in-flight work, per-IP flights, API-key admission, console work, stream idle time, and database writes. Open connections, active upstream requests, and sustainable requests per second remain distinct capacity metrics.

## Verification

- Backend tests cover request, routing, persistence, streaming, admission, and cancellation contracts.
- Dashboard tests/build remain independent because the dashboard is a separate package.
- Runtime smoke confirms `/health` and the normal single-process startup path.
- Deployment-level replication, if needed, is verified by the deployment platform rather than by an application cluster abstraction.
