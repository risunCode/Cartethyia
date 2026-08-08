# Requirements: Native Bun Concurrency

## Scope

Cartethyia must use Bun's native asynchronous HTTP and provider-I/O concurrency. The application must not maintain a custom per-request worker pool, worker-thread protocol, or application-level process cluster.

## Requirements

1. Bun.serve SHALL accept concurrent requests on the direct asynchronous path.
2. HTTP parsing, authentication, admission, routing, provider fetch, streaming, cancellation, and persistence SHALL preserve their existing contracts.
3. Independent asynchronous provider operations MAY use native Promise composition; ordinary proxy I/O SHALL NOT cross a JavaScript worker boundary.
4. Existing payload, history, body-size, admission, rate, stream, and timeout limits SHALL remain the resource boundaries.
5. SQLite configuration and runtime repositories SHALL keep their existing WAL and busy-timeout coordination.
6. Health and console routes SHALL remain available from the single server process.
7. Deployment-level horizontal or process scaling SHALL remain outside the application runtime and SHALL NOT introduce a second concurrency abstraction here.

## Non-goals

- Creating a JavaScript worker per request.
- Maintaining a custom worker pool or worker message protocol.
- Moving provider I/O, streams, SQLite, or mutable runtime state to worker threads.
- Adding an in-process process supervisor or `reusePort` cluster.
- Raising concurrency limits without load evidence.
