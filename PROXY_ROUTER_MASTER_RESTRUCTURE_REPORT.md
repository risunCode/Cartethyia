# Cartethyia Proxy Router
## Master Restructure Report: Cleanup, Cutoff, Translation, Batch, dan Dashboard Wiring

**Document class:** architecture report for review

**Decision status:** historical architecture note; the current cutover state is recorded in `PROXY_ROUTER_CLEANUP_CUTOFF_WIRING_ROADMAP.md`

**Superseded by:** `PROXY_ROUTER_CLEANUP_CUTOFF_WIRING_ROADMAP.md`. Keep this file only as an older target-architecture reference.

**Sources inspected:**

| Source | Role in this report |
|---|---|
| Current Cartethyia repository | authoritative implementation baseline |
| `Public/Cartethyia-107` | legacy behavioral parity reference |
| `Public/etteum-pool` | routing pool, provider, warmup, compression, and egress capability reference |

---

# 1. Final Recommendation

Refactor besar ini layak. Struktur sekarang menunjukkan domain yang benar, tetapi ownership tersebar dan beberapa package sudah terlalu berat.

Rekomendasi final:

1. Rename root `daemon/` menjadi `router/`.
2. Pertahankan `dashboard/` sebagai pure operator SPA.
3. Hapus auxiliary Bun backend dari dashboard setelah endpoint penggantinya tersedia di Go router.
4. Tambahkan hanya empat root ownership folders yang jelas: `contracts/`, `tests/`, `deploy/`, dan `tools/`.
5. Jangan membuat root `shared/`, `common/`, `utils/`, `helpers/`, `core/`, atau `services/`.
6. Satukan request processing ke tiga mode saja: `PASS`, `PATCH`, dan `TRANSLATE`.
7. Same-surface request/response menggunakan byte passthrough secara default.
8. Translation penuh hanya berjalan saat source surface dan target surface berbeda, atau ketika policy eksplisit membutuhkan semantic rewrite.
9. Batch menjadi sub-owner router, bukan service terpisah dan bukan dashboard feature.
10. Automatic batching hanya dilakukan ketika aman berdasarkan provider capability dan compatibility key. Interactive streaming tidak ditahan untuk menunggu batch.
11. Satu router authority, satu catalog, satu account authority, satu compatibility planner, satu telemetry pipeline, dan satu dashboard API.

```text
CLIENT TRAFFIC
      |
      v
+-------------------+
| router/gateway    |
| auth + limits     |
+-------------------+
      |
      v
+-------------------+       +-------------------+
| protocol decision |------>| PASS / PATCH      |
| compatibility     |       | raw bytes retained|
+-------------------+       +-------------------+
      |
      | cross-surface only
      v
+-------------------+
| TRANSLATE         |
| one decode        |
| one canonical IR  |
| one encode        |
+-------------------+
      |
      v
+-------------------+
| router engine     |
| select + attempt  |
| retry + failover  |
| optional batch    |
+-------------------+
      |
      v
+-------------------+
| provider + egress |
+-------------------+
      |
      v
UPSTREAM PROVIDER
```

---

# 2. What Is Wrong Today

## 2.1 Structural concentration

Measured package concentration from the current tree:

| Area | Measured size | Finding |
|---|---:|---|
| `proxy/protocol/transforms/*.go` | 12,618 lines including tests | too many request, response, canonical, invariant, sidecar, and pipeline responsibilities in one package |
| `proxy/runtime/*.go` | 14,134 lines including tests | routing, dispatch service, pool, streaming, repair, filters, lifecycle, and projection are concentrated |
| `providers/*.go` + `providers/adapters/*.go` | 6,899 lines including tests | catalog, registry, policies, classifications, and adapters overlap conceptually |
| `dashboard/src/lib` + support server files in measured glob | 3,362 lines | frontend client utilities and backend database/server utilities live together |

Large production files observed:

| File | Approximate size | Problem class |
|---|---:|---|
| `proxy/protocol/transforms/canonical.go` | 1,201 lines | canonical data handling concentrated |
| `proxy/protocol/transforms/anthropic.go` | 960 lines | request surface codec concentrated |
| `proxy/protocol/transforms/gemini.go` | 661 lines | request surface codec concentrated |
| `proxy/runtime/router.go` | 58.9 KB | attempt coordinator and route state are too broad |
| `proxy/runtime/service.go` | 37.6 KB | dispatch lifecycle and side effects are too broad |
| `proxy/runtime/catalog/catalog.go` | 36.4 KB | catalog build, resolution, and state concentrated |
| `dashboard/src/pages/Providers/index.tsx` | 47.3 KB | page owns too much orchestration and presentation |
| `dashboard/src/lib/sqlite.ts` | 17.7 KB | dashboard owns a second persistence concern |
| `dashboard/src/lib/postgres.ts` | 15.4 KB | dashboard owns backend database lifecycle |

## 2.2 Ownership ambiguity

| Current area | Ambiguity |
|---|---|
| `internal/runtime` | composition root, admin services, cache, network, diagnostics, recovery, lifecycle |
| `internal/server` | public ingress, admin API, public share API, middleware, API contracts |
| `internal/providers` | definitions, models.dev merge, routing policy, adapters, OAuth descriptors |
| `internal/accounts/drivers` | provider-specific auth behavior overlaps `providers/oauth` |
| `proxy/protocol/transforms` | codec, canonical IR, planner consequences, healing, compaction, sidecar preservation |
| `proxy/runtime/fast_passthrough.go` | fast path is inside runtime but imports protocol healing and full JSON map parsing |
| dashboard `src/lib` | browser-only helpers mixed with Bun/Postgres/SQLite backend code |
| dashboard `src/server` | creates the impression of a second backend authority |

## 2.3 Hot-path cost risks

Direct source evidence:

- `SanitizeSameSurfaceRequest` unmarshals the complete request into `map[string]any`, mutates it, then marshals it again.
- `NormalizeRequest` can decode to canonical, run stages, then encode again.
- Native sidecar preservation may inspect and merge JSON to preserve unknown fields.
- Response translation uses canonical event decoding and encoding.
- compatibility plan cache serializes plan JSON and deserializes it on cache hits.
- telemetry metadata currently queues individual writes; repository insertion is one row per metadata event.
- no general native batch request execution layer exists today.
- existing batch behavior is limited to admin batch mutation, token recovery bounds, refresh coalescing, cache miss coalescing, and queues for observability/admission.

The target must eliminate unnecessary canonical work. It must not remove compatibility when translation is actually required.

---

# 3. Current Structure: BEFORE

The tree below is the complete **owned directory tree** relevant to source, runtime, dashboard, tests, deployment, and documentation. Generated CodeGraph database internals and third-party files inside `vendor/` are not expanded because they are not Cartethyia-owned architecture.

```text
Cartethyia/
├── .codegraph/
├── daemon/
│   ├── cmd/
│   │   └── cartethyia/
│   ├── internal/
│   │   ├── accounts/
│   │   │   ├── drivers/
│   │   │   └── flow/
│   │   ├── config/
│   │   ├── database/
│   │   │   ├── migrations/
│   │   │   ├── models/
│   │   │   └── repositories/
│   │   ├── observability/
│   │   │   └── usage/
│   │   ├── providers/
│   │   │   ├── adapters/
│   │   │   ├── apikey/
│   │   │   ├── builtin/
│   │   │   ├── oauth/
│   │   │   └── policies/
│   │   ├── proxy/
│   │   │   ├── compression/
│   │   │   ├── control/
│   │   │   │   ├── admission/
│   │   │   │   ├── continuation/
│   │   │   │   └── tokenbudget/
│   │   │   ├── protocol/
│   │   │   │   ├── compatibility/
│   │   │   │   │   └── corpus/
│   │   │   │   ├── contracts/
│   │   │   │   ├── healing/
│   │   │   │   ├── jsonclone/
│   │   │   │   └── transforms/
│   │   │   ├── runtime/
│   │   │   │   └── catalog/
│   │   │   └── transport/
│   │   ├── runtime/
│   │   │   └── cache/
│   │   ├── security/
│   │   │   ├── capture/
│   │   │   └── outbound/
│   │   └── server/
│   │       ├── admin/
│   │       ├── api/
│   │       ├── apicontracts/
│   │       ├── apierrors/
│   │       └── middleware/
│   ├── scripts/
│   ├── test/
│   │   └── load/
│   └── testdata/
│       └── compatibility/
├── dashboard/
│   ├── data/
│   ├── migrations/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── forms/
│   │   │   ├── layout/
│   │   │   ├── patterns/
│   │   │   ├── shared/
│   │   │   └── ui/
│   │   ├── composables/
│   │   │   ├── navigation/
│   │   │   └── usage/
│   │   ├── features/
│   │   │   └── login/
│   │   ├── landing/
│   │   ├── lib/
│   │   ├── pages/
│   │   │   ├── ConsoleLog/
│   │   │   ├── Landing/
│   │   │   ├── Login/
│   │   │   ├── Overview/
│   │   │   ├── Providers/
│   │   │   ├── Proxy/
│   │   │   ├── Quota/
│   │   │   ├── Requests/
│   │   │   ├── Settings/
│   │   │   ├── Share/
│   │   │   └── Usage/
│   │   ├── server/
│   │   └── styles/
│   └── test/
│       ├── components/
│       │   ├── forms/
│       │   ├── patterns/
│       │   ├── shared/
│       │   └── ui/
│       ├── features/
│       │   └── login/
│       ├── fixtures/
│       ├── helpers/
│       ├── landing/
│       ├── lib/
│       ├── pages/
│       │   ├── ConsoleLog/
│       │   ├── Overview/
│       │   ├── Providers/
│       │   ├── Quota/
│       │   ├── Settings/
│       │   ├── Share/
│       │   └── Usage/
│       └── server/
├── docker/
│   └── postgres-init/
├── docs/
│   └── visualize/
├── scripts/
├── vendor/
├── Dockerfile
├── docker-compose.yml
├── docker-entrypoint.sh
├── railway.toml
├── Makefile
├── go.work
├── go.work.sum
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Before assessment

| Folder | Keep | Rename | Merge | Cut |
|---|---:|---:|---:|---:|
| `daemon` | no | yes: `router` | no | no |
| `dashboard` | yes | no | no | backend sub-tree only |
| `docker` | no | yes: `deploy` | root deployment files | no |
| `scripts` | no | yes: `tools` | daemon scripts | no |
| `docs/visualize` | no | yes: `docs/architecture` | no | no |
| dashboard `data` | no | no | no | yes after Go endpoint cutoff |
| dashboard `migrations` | no | no | Go storage migrations if still relevant | yes as dashboard-owned migrations |
| dashboard `src/server` | no | no | client-error endpoint into Go console API | yes |

---

# 4. Proposed Structure: AFTER

This is the complete target ownership tree. No generic utility root and no duplicate backend are proposed.

```text
Cartethyia/
├── .codegraph/
├── router/
│   ├── cmd/
│   │   └── cartethyia/
│   │       ├── main.go
│   │       ├── command.go
│   │       ├── config.go
│   │       ├── migrate.go
│   │       ├── probe.go
│   │       └── serve.go
│   ├── internal/
│   │   ├── app/
│   │   │   ├── bootstrap.go
│   │   │   ├── config.go
│   │   │   ├── lifecycle.go
│   │   │   ├── readiness.go
│   │   │   └── recovery.go
│   │   ├── gateway/
│   │   │   ├── gateway.go
│   │   │   ├── routes.go
│   │   │   ├── request.go
│   │   │   ├── response.go
│   │   │   ├── streaming.go
│   │   │   ├── errors.go
│   │   │   └── middleware/
│   │   │       ├── chain.go
│   │   │       ├── auth.go
│   │   │       ├── client.go
│   │   │       ├── limits.go
│   │   │       ├── recovery.go
│   │   │       ├── request_id.go
│   │   │       ├── security.go
│   │   │       └── response_headers.go
│   │   ├── protocol/
│   │   │   ├── contracts.go
│   │   │   ├── features.go
│   │   │   ├── compatibility.go
│   │   │   ├── passthrough.go
│   │   │   ├── repair.go
│   │   │   ├── errors.go
│   │   │   └── codec/
│   │   │       ├── registry.go
│   │   │       ├── types.go
│   │   │       ├── pipeline.go
│   │   │       ├── sidecar.go
│   │   │       ├── openai_chat.go
│   │   │       ├── openai_responses.go
│   │   │       ├── anthropic.go
│   │   │       ├── gemini.go
│   │   │       ├── compaction.go
│   │   │       └── tools.go
│   │   ├── router/
│   │   │   ├── service.go
│   │   │   ├── router.go
│   │   │   ├── request.go
│   │   │   ├── plan.go
│   │   │   ├── attempt.go
│   │   │   ├── selector.go
│   │   │   ├── pool.go
│   │   │   ├── readiness.go
│   │   │   ├── outcome.go
│   │   │   ├── retry.go
│   │   │   ├── repair.go
│   │   │   ├── stream.go
│   │   │   ├── inflight.go
│   │   │   ├── admission.go
│   │   │   ├── continuation.go
│   │   │   ├── token_budget.go
│   │   │   ├── optimizer.go
│   │   │   ├── catalog/
│   │   │   │   ├── catalog.go
│   │   │   │   ├── builder.go
│   │   │   │   ├── resolver.go
│   │   │   │   └── snapshot.go
│   │   │   ├── cache/
│   │   │   │   ├── cache.go
│   │   │   │   ├── key.go
│   │   │   │   ├── memory.go
│   │   │   │   ├── redis.go
│   │   │   │   ├── response.go
│   │   │   │   └── content.go
│   │   │   └── batch/
│   │   │       ├── service.go
│   │   │       ├── scheduler.go
│   │   │       ├── grouping.go
│   │   │       ├── worker.go
│   │   │       ├── job.go
│   │   │       └── repository.go
│   │   ├── providers/
│   │   │   ├── registry.go
│   │   │   ├── catalog.go
│   │   │   ├── models.go
│   │   │   ├── policy.go
│   │   │   ├── capability.go
│   │   │   ├── classification.go
│   │   │   ├── errors.go
│   │   │   ├── builtin/
│   │   │   │   ├── definitions.go
│   │   │   │   ├── models_dev.go
│   │   │   │   └── models.dev.json
│   │   │   └── adapters/
│   │   │       ├── adapter.go
│   │   │       ├── internal.go
│   │   │       ├── openai.go
│   │   │       ├── anthropic.go
│   │   │       ├── codex.go
│   │   │       ├── grok.go
│   │   │       ├── antigravity.go
│   │   │       ├── claudecode.go
│   │   │       ├── cline.go
│   │   │       └── custom.go
│   │   ├── accounts/
│   │   │   ├── service.go
│   │   │   ├── account.go
│   │   │   ├── credential.go
│   │   │   ├── secret.go
│   │   │   ├── refresher.go
│   │   │   ├── health.go
│   │   │   ├── quota.go
│   │   │   ├── cooldown.go
│   │   │   ├── store.go
│   │   │   ├── flow/
│   │   │   │   ├── session.go
│   │   │   │   └── callback.go
│   │   │   └── auth/
│   │   │       ├── registry.go
│   │   │       ├── driver.go
│   │   │       ├── identity.go
│   │   │       ├── codex.go
│   │   │       ├── claudecode.go
│   │   │       ├── cline.go
│   │   │       ├── grokbuild.go
│   │   │       ├── kimchi.go
│   │   │       ├── kiro.go
│   │   │       └── antigravity.go
│   │   ├── egress/
│   │   │   ├── client.go
│   │   │   ├── request.go
│   │   │   ├── response.go
│   │   │   ├── stream.go
│   │   │   ├── sse.go
│   │   │   ├── network.go
│   │   │   ├── proxy.go
│   │   │   ├── policy.go
│   │   │   ├── compression.go
│   │   │   └── errors.go
│   │   ├── console/
│   │   │   ├── api/
│   │   │   │   ├── router.go
│   │   │   │   ├── envelope.go
│   │   │   │   ├── validation.go
│   │   │   │   ├── authorization.go
│   │   │   │   ├── session.go
│   │   │   │   └── streaming.go
│   │   │   ├── services/
│   │   │   │   ├── dashboard.go
│   │   │   │   ├── accounts.go
│   │   │   │   ├── providers.go
│   │   │   │   ├── proxies.go
│   │   │   │   ├── quota.go
│   │   │   │   ├── requests.go
│   │   │   │   ├── usage.go
│   │   │   │   ├── logs.go
│   │   │   │   ├── settings.go
│   │   │   │   ├── batches.go
│   │   │   │   ├── share.go
│   │   │   │   └── client_errors.go
│   │   │   └── contracts/
│   │   │       ├── dashboard.go
│   │   │       ├── account.go
│   │   │       ├── provider.go
│   │   │       ├── proxy.go
│   │   │       ├── telemetry.go
│   │   │       ├── batch.go
│   │   │       └── settings.go
│   │   ├── storage/
│   │   │   ├── storage.go
│   │   │   ├── models/
│   │   │   │   ├── account.go
│   │   │   │   ├── api_key.go
│   │   │   │   ├── proxy.go
│   │   │   │   ├── settings.go
│   │   │   │   ├── telemetry.go
│   │   │   │   ├── batch.go
│   │   │   │   └── ban.go
│   │   │   ├── repositories/
│   │   │   │   ├── bundle.go
│   │   │   │   ├── account.go
│   │   │   │   ├── api_key.go
│   │   │   │   ├── proxy.go
│   │   │   │   ├── settings.go
│   │   │   │   ├── telemetry.go
│   │   │   │   ├── batch.go
│   │   │   │   ├── token_budget.go
│   │   │   │   └── ban.go
│   │   │   └── migrations/
│   │   │       ├── migrator.go
│   │   │       ├── registry.go
│   │   │       └── migrations.go
│   │   └── telemetry/
│   │       ├── event.go
│   │       ├── metadata.go
│   │       ├── metrics.go
│   │       ├── trace.go
│   │       ├── evidence.go
│   │       ├── taxonomy.go
│   │       ├── labels.go
│   │       ├── redaction.go
│   │       ├── capture.go
│   │       ├── writer.go
│   │       └── usage/
│   │           └── ledger.go
│   ├── scripts/
│   │   ├── generate_catalog.go
│   │   └── verify_boundaries.go
│   ├── go.mod
│   └── go.sum
├── dashboard/
│   ├── public/
│   ├── src/
│   │   ├── app/
│   │   │   ├── App.tsx
│   │   │   ├── router.tsx
│   │   │   ├── routes.ts
│   │   │   └── session.ts
│   │   ├── api/
│   │   │   ├── client.ts
│   │   │   ├── routes.ts
│   │   │   ├── contracts.ts
│   │   │   ├── errors.ts
│   │   │   └── sse.ts
│   │   ├── components/
│   │   │   ├── ui/
│   │   │   ├── layout/
│   │   │   ├── data/
│   │   │   ├── forms/
│   │   │   └── feedback/
│   │   ├── features/
│   │   │   ├── overview/
│   │   │   ├── requests/
│   │   │   ├── usage/
│   │   │   ├── providers/
│   │   │   ├── accounts/
│   │   │   ├── quota/
│   │   │   ├── proxies/
│   │   │   ├── batches/
│   │   │   ├── logs/
│   │   │   ├── settings/
│   │   │   ├── login/
│   │   │   ├── share/
│   │   │   └── landing/
│   │   ├── lib/
│   │   │   ├── format.ts
│   │   │   ├── time.ts
│   │   │   ├── classes.ts
│   │   │   └── toast.ts
│   │   ├── styles/
│   │   │   ├── base.css
│   │   │   └── landing.css
│   │   └── main.tsx
│   ├── test/
│   │   ├── api/
│   │   ├── components/
│   │   ├── features/
│   │   ├── fixtures/
│   │   └── setup.ts
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── contracts/
│   ├── openapi/
│   │   ├── public.yaml
│   │   └── console.yaml
│   ├── schemas/
│   │   ├── routing.schema.json
│   │   ├── provider.schema.json
│   │   ├── account.schema.json
│   │   ├── telemetry.schema.json
│   │   └── batch.schema.json
│   └── fixtures/
│       ├── manifest.json
│       ├── openai-chat/
│       ├── openai-responses/
│       ├── anthropic/
│       ├── gemini/
│       ├── routing/
│       ├── streaming/
│       └── errors/
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── load/
│   ├── performance/
│   ├── scenarios/
│   │   ├── passthrough/
│   │   ├── translation/
│   │   ├── failover/
│   │   ├── streaming/
│   │   ├── batch/
│   │   └── dashboard/
│   └── smoke/
├── deploy/
│   ├── docker/
│   │   ├── Dockerfile
│   │   ├── entrypoint.sh
│   │   ├── compose.yaml
│   │   ├── nginx.conf
│   │   └── postgres-init/
│   │       └── 01-create-database.sql
│   └── railway/
│       └── railway.toml
├── tools/
│   ├── dev.ts
│   ├── run-windows.ps1
│   ├── validate-fullstack.ts
│   ├── verify-imports.ts
│   └── benchmark-hotpath.ts
├── docs/
│   ├── architecture/
│   │   ├── ownership.md
│   │   ├── request-flow.md
│   │   ├── translation.md
│   │   ├── batch.md
│   │   └── workspace-map.svg
│   ├── deployment/
│   │   └── README.md
│   └── operations/
│       ├── providers.md
│       ├── accounts.md
│       ├── telemetry.md
│       └── recovery.md
├── vendor/
├── Makefile
├── go.work
├── go.work.sum
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Why this is not oversplit

At Go runtime level there are ten owners:

1. `app`
2. `gateway`
3. `protocol`
4. `router`
5. `providers`
6. `accounts`
7. `egress`
8. `console`
9. `storage`
10. `telemetry`

These are product boundaries, not arbitrary technical layers. Each owner has one sentence responsibility and one dependency direction.

Subfolders are only allowed for independently testable sub-ownership:

- route catalog
- router cache
- batch execution
- protocol codec
- account auth flows
- dashboard API/services/contracts
- storage model/repository/migration
- telemetry usage

No package is split merely because a file is large. A file is split when responsibilities, invariants, or change frequency differ.

---

# 5. Root Rename and Movement Matrix

## 5.1 Root

| Before | After | Action | Reason |
|---|---|---|---|
| `daemon/` | `router/` | rename | product identity is Proxy Router |
| `scripts/` | `tools/` | rename + merge `daemon/scripts` | one developer tooling owner |
| `docker/` + root deployment files | `deploy/docker/` | move | deployment ownership explicit |
| `railway.toml` | `deploy/railway/railway.toml` | move | deployment ownership explicit |
| `docs/visualize/` | `docs/architecture/` | rename | directory describes architecture, not a generic visualization |
| daemon `testdata/compatibility` | `contracts/fixtures` | move | cross-boundary behavior corpus |
| daemon `test/load` | root `tests/load` | move | black-box load ownership |
| new | `contracts/` | create | shared API/schema/fixture authority |
| new | `tests/` | create | cross-process verification only |

## 5.2 Go internal packages

| Before | After | Action |
|---|---|---|
| `internal/runtime/bootstrap.go` | `internal/app/bootstrap.go` | move |
| `internal/runtime/runtime.go` | `internal/app/lifecycle.go` plus `internal/router/service.go` | split by owner |
| `internal/runtime/recovery.go` | `internal/app/recovery.go` | move |
| `internal/runtime/diagnostics.go` | `internal/app/readiness.go` plus telemetry/console projections | split by owner |
| `internal/runtime/admin_*.go` | `internal/console/services/*.go` | move and rename |
| `internal/runtime/cache` | `internal/router/cache` | move |
| `internal/runtime/network.go` | `internal/egress/network.go` | move |
| `internal/server/api` | `internal/gateway` | move and flatten |
| `internal/server/middleware` | `internal/gateway/middleware` | move |
| `internal/server/admin` | `internal/console/api` | move |
| `internal/server/share.go` | `internal/console/services/share.go` plus API route | move |
| `internal/server/apicontracts` | root contracts schema + local protocol contracts | merge |
| `internal/server/apierrors` | `internal/gateway/errors.go` | merge |
| `internal/proxy/runtime` | `internal/router` | rename |
| `internal/proxy/runtime/catalog` | `internal/router/catalog` | move |
| `internal/proxy/control/admission` | `internal/router/admission.go` | flatten |
| `internal/proxy/control/continuation` | `internal/router/continuation.go` | flatten |
| `internal/proxy/control/tokenbudget` | `internal/router/token_budget.go` interface + storage implementation | split by owner |
| `internal/proxy/compression` | `internal/router/optimizer.go` plus protocol codec compaction | merge by semantic owner |
| `internal/proxy/transport` | `internal/egress` | move |
| `internal/proxy/protocol/contracts` | `internal/protocol` | move |
| `internal/proxy/protocol/compatibility` | `internal/protocol/compatibility.go` | flatten |
| `internal/proxy/protocol/transforms` | `internal/protocol/codec` | rename and clean |
| `internal/proxy/protocol/healing` | `internal/protocol/repair.go` plus provider adapter deviations | merge by rule ownership |
| `internal/proxy/protocol/jsonclone` | removed | cut generic deep clone path |
| `internal/providers/apikey` | `internal/providers/builtin` | merge static definitions |
| `internal/providers/oauth` | `internal/accounts/auth` | move auth behavior |
| `internal/providers/policies` | `internal/providers/policy.go` | flatten |
| `internal/accounts/drivers` | `internal/accounts/auth` | rename and merge |
| `internal/storage` | `internal/storage` | rename |
| `internal/observability` | `internal/telemetry` | rename |
| `internal/security/outbound` | `internal/egress/policy.go` | move |
| `internal/security/capture` | `internal/telemetry/capture.go` | move |
| `internal/config` | `internal/app/config.go` | merge |

## 5.3 Dashboard

| Before | After | Action |
|---|---|---|
| `src/router.tsx` | `src/app/router.tsx` | move |
| `src/App.tsx` | `src/app/App.tsx` | move |
| `src/lib/console-api.ts` | `src/api/client.ts` | rename |
| `src/lib/console-routes.ts` | `src/api/routes.ts` | rename |
| `src/lib/sse.ts` | `src/api/sse.ts` | move |
| wire-contract files in `components/shared` and `lib` | `src/api/contracts.ts` | merge generated or checked contracts |
| `src/pages/*` | `src/features/*` | move page, state, fetch, and feature-local components together |
| generic display tables | `src/components/data` | move |
| loading/error/toast views | `src/components/feedback` | move |
| `src/server` | removed | Go console API replaces it |
| `src/lib/postgres.ts` | removed | dashboard no longer owns PostgreSQL |
| `src/lib/sqlite.ts` | removed | dashboard no longer owns SQLite |
| `src/lib/migrations.ts` | removed | migrations belong to Go storage |
| `dashboard/migrations` | removed after data migration | no second schema authority |
| `dashboard/data` | removed | no runtime database inside frontend tree |
| `src/lib/store.ts` | feature-local state or app session | remove generic store |
| duplicate `quota-contracts.ts` | `src/api/contracts.ts` | merge |
| duplicate `log-types.ts` | `src/api/contracts.ts` | merge |

---

# 6. Ownership and Dependency Rules

## 6.1 Owner contracts

| Owner | Owns | Must not own |
|---|---|---|
| `app` | composition, startup, shutdown, readiness | routing decisions, SQL queries, protocol translation |
| `gateway` | inbound HTTP, auth context, request limits, public surface status mapping | provider selection, token refresh, database models |
| `protocol` | surface types, compatibility decision, codecs, explicit repair rules | account health, retry budget, HTTP sockets |
| `router` | target plan, attempt budget, selection, failover, stream lifecycle, automatic batch dispatch | secret storage, UI DTOs, provider-specific OAuth |
| `providers` | provider identity, model capabilities, adapter deviations, upstream classification | account persistence, global retry loops |
| `accounts` | credentials, refresh, OAuth flow, health, quota, cooldown state | route member selection, dashboard presentation |
| `egress` | outbound HTTP, SSE framing, network proxy, SSRF policy, connection reuse | compatibility planning, account selection |
| `console` | authenticated operator API, wire contracts, read projections, mutations | direct UI rendering, proxy hot-path decisions |
| `storage` | durable models, repositories, transactions, migrations | routing policy, HTTP contracts |
| `telemetry` | events, metrics, metadata, evidence, usage, capture/redaction | request retry decisions, dashboard state |
| `dashboard` | operator UX, API client, feature state, rendering | credentials, SQL, router algorithms |

## 6.2 Allowed dependency direction

```text
cmd
 |
 v
app
 |-------------------------------|
 v               v               v
console        gateway         background workers
 |               |
 |               v
 |             router
 |          /    |    \
 |         v     v     v
 |     protocol providers accounts
 |          \    |    /
 |               v
 |             egress
 |
 v
storage <---------------- telemetry

Dashboard --HTTP/SSE--> console
Clients   --HTTP/SSE--> gateway
```

Hard rules:

- `protocol` imports no router, provider, storage, telemetry, gateway, or console package.
- `providers` may import protocol contracts, not router runtime.
- `accounts` does not import router runtime.
- `router` consumes interfaces from accounts, providers, egress, and telemetry.
- `storage` implements interfaces; domain packages do not expose Bun models.
- `console` calls services; it does not issue SQL directly.
- dashboard only uses HTTP/SSE contracts.

## 6.3 Unified helper rule

There will be no global utility package.

The unifying primitives are domain contracts:

| Primitive | Owner | Purpose |
|---|---|---|
| `RequestEnvelope` | protocol | one normalized request identity and source surface |
| `CompatibilityDecision` | protocol | `PASS`, `PATCH`, or `TRANSLATE` |
| `RoutePlan` | router | immutable target members and strategy |
| `PreparedAttempt` | router/provider boundary | selected account, provider, network, request bytes |
| `AttemptOutcome` | router | one classified result driving retry/failover |
| `StreamEvent` | protocol | only used when stream translation is necessary |
| `BatchKey` | router/batch | proves requests are safe to group |
| `OperatorView` | console/contracts | bounded dashboard representation |

Helper placement:

- used by one file: same file;
- used by one package: package-private file;
- used by one sub-owner: sub-owner package;
- used across domains: promote only if it represents a real domain contract;
- generic string/slice/map wrappers are not promoted.

---

# 7. Request Processing: PASS, PATCH, TRANSLATE

## 7.1 Decision matrix

| Condition | Mode | Request work | Response work |
|---|---|---|---|
| same surface, model unchanged, no repair, no optimizer | `PASS` | forward original bytes | forward raw bytes or raw SSE frames |
| same surface, only bounded known fields change | `PATCH` | targeted raw JSON patch | raw response passthrough |
| source and target differ | `TRANSLATE` | one decode, one canonical IR, one encode | one decode and one encode |
| same surface but provider requires semantic conversion | `TRANSLATE` | explicit provider policy only | explicit provider policy only |
| unsupported feature | `REJECT` | fail before account/network acquisition | no upstream call |

## 7.2 PASS path

Required invariants:

- original request byte slice is retained;
- no `map[string]any` conversion;
- no canonical request allocation;
- no native sidecar extraction;
- model is found with a bounded JSON scanner;
- request validation reads only fields required for routing/security;
- response body is not decoded when client and provider surfaces match and no telemetry extraction needs the body;
- streaming frames pass through without canonical event allocation;
- terminal usage extraction is a side tap, not a full event reconstruction.

```text
body []byte
   |
   +--> bounded envelope scan: model, stream, feature flags
   |
   +--> compatibility says PASS
   |
   +--> provider request headers and endpoint
   |
   +--> outbound body uses original []byte
```

## 7.3 PATCH path

PATCH exists because many same-surface requests only need small changes:

- model alias replacement;
- model suffix removal;
- stream flag correction;
- provider-required top-level option;
- explicit tool ID repair;
- explicit role repair.

Required behavior:

- patch only exact known JSON paths;
- preserve unknown provider-native fields;
- avoid full canonical IR;
- avoid `map[string]any` for the complete payload;
- no second marshal after the patched bytes are produced;
- no repair runs unless compatibility/provider policy requests it.

Implementation choice must be selected by benchmark:

| Option | Benefit | Risk | Recommendation |
|---|---|---|---|
| typed envelope + `json.RawMessage` | standard library, explicit | top-level reserialization | safe baseline |
| bounded structural scanner + byte splice | minimal allocations | more parser responsibility | preferred after fuzz proof |
| third-party targeted JSON patcher | mature fast path | dependency and behavior audit | acceptable only if benchmarks justify it |

## 7.4 TRANSLATE path

Required invariants:

- exactly one inbound decode;
- exactly one canonical representation;
- exactly one target encode;
- response translation mirrors source/target once;
- canonical types are typed structs and discriminated enums, not arbitrary maps;
- provider-native fields are preserved only by explicit same-surface sidecar or explicit pointer mapping;
- unsupported semantic fields fail with a capability error;
- lossy transformation requires policy opt-in;
- translation plan is immutable for the attempt set.

## 7.5 Streaming

| Path | Target behavior |
|---|---|
| same-surface SSE | raw frame forwarding, heartbeat managed by egress/gateway, terminal accounting tapped |
| cross-surface SSE | incremental frame decode and encode; never buffer full response |
| provider-specific event stream | adapter translates provider events to canonical only once |
| client disconnect | cancel egress, release account/network lease, emit one terminal outcome |
| retry before first byte | allowed by router policy |
| retry after visible client bytes | forbidden unless protocol continuation contract explicitly supports it |

---

# 8. Behavior Cleanup and Cutoff

## 8.1 Cut matrix

| Behavior | Decision | Replacement |
|---|---|---|
| full canonical decode for every request | cut | PASS/PATCH decision first |
| full `map[string]any` unmarshal on ordinary same-surface traffic | cut | bounded scan or targeted patch |
| unconditional healing | cut | policy-driven repair |
| duplicate request and response registries with repeated constructor loops | simplify | immutable codec table built once |
| JSON serialization of compatibility plan on local hot-cache hits | cut | compiled in-memory plan keyed by generations |
| Redis as mandatory plan hot path | cut | Redis carries generation/invalidation, local immutable plan cache serves hot path |
| generic JSON deep clone | cut | immutable data or owner-specific copy |
| provider adapter performing global retry | cut | adapter returns classified outcome; router retries |
| dashboard database access | cut | Go console API |
| dashboard SQLite log database | cut | bounded Go telemetry/client-error endpoint |
| duplicate dashboard contracts | cut | one generated/checked `api/contracts.ts` |
| broad generic dashboard `shared` components | reduce | `ui`, `data`, `feedback`, feature-local components |
| one telemetry insert per request forever | replace | bounded automatic bulk writer |
| arbitrary automatic batching of interactive streams | reject | no-delay interactive dispatch |
| new provider-specific router fork | reject | provider adapter + capability policy |

## 8.2 Keep matrix

| Behavior | Decision | Reason |
|---|---|---|
| bounded route attempt budget | keep | prevents retry explosion |
| per-member budget | keep | preserves combo/fallback semantics |
| account exclusion | keep | avoids repeatedly selecting failed account |
| explicit same-account refresh retry | keep | credential lifecycle requirement |
| deterministic catalog generation | keep | stable route plans and cache keys |
| cooldown/readiness/model locks | keep | routing correctness |
| stream preflight | keep | prevents invalid downstream headers |
| terminal event exactly once | keep | lifecycle correctness |
| metadata fail-open queue | keep, batch writer behind it | request path must not block on telemetry |
| cache miss coalescing | keep | prevents duplicate work |
| OAuth refresh coalescing | keep | prevents token races |
| bounded admission queue | keep | overload protection |
| response/content caching policy | keep | performance and cost control |

## 8.3 Move to provider policy

These behaviors must not run globally:

- developer role rewrite;
- thinking/reasoning option mapping;
- tool call ID sanitation required by one upstream;
- missing tool result repair;
- provider-specific system prompt insertion;
- provider-specific compaction markers;
- model alias/suffix quirks;
- unusual stream terminal repair.

Generic protocol invariants remain in protocol. Provider deviations move to adapter capability/policy.

---

# 9. CPU, Allocation, and Copy Reduction

## 9.1 Hot-path budgets

| Mode | Decode budget | Encode budget | Full body copies | Canonical allocations |
|---|---:|---:|---:|---:|
| PASS request | 0 | 0 | 0 required | 0 |
| PATCH request | bounded scan | 1 patched output | 1 maximum | 0 |
| TRANSLATE request | 1 | 1 | 1 encoded output | 1 canonical graph |
| PASS response | 0 | 0 | 0 required | 0 |
| TRANSLATE response | 1 | 1 | 1 encoded output/frame | 1 bounded response/event |
| same-surface stream frame | 0 | 0 | 0 required | 0 |
| translated stream frame | 1 incremental | 1 incremental | one bounded output frame | one bounded event reused where safe |

## 9.2 Required optimizations

1. Build immutable codec, provider, and route tables once per generation.
2. Compile compatibility decisions once per source/target/provider/model capability key.
3. Keep byte slices through gateway, router, provider, and egress.
4. Use `io.Reader`/`io.Writer` streaming where raw body forwarding allows it.
5. Avoid `string(body)` conversions for scans and logging.
6. Replace general maps in hot protocol paths with typed structs or raw messages.
7. Pre-size slices from bounded known counts.
8. Reuse scratch buffers only with strict lease/lifetime ownership.
9. Do not pool large canonical object graphs; pooling them risks retention and data leakage.
10. Parse usage only from terminal/non-stream bodies when provider protocol permits.
11. Keep telemetry metadata content-free and write it asynchronously in batches.
12. Cache provider endpoint/header plans that contain no secret material.
13. Keep credentials request-scoped and never cache plaintext in shared plans.
14. Run compression once at a configured threshold, never repeatedly on each attempt.
15. Reuse translated request bytes across retry attempts when provider surface and semantic request are unchanged.

## 9.3 Target improvements

These are performance targets, not current measured results:

| Scenario | CPU target | Allocation target | Latency target |
|---|---:|---:|---:|
| same-surface non-stream | 25–45% reduction | 50–80% reduction | lower p50 and p95 router overhead |
| same-surface stream | 20–40% reduction | 60–90% frame allocation reduction | stable time-to-first-byte |
| cross-surface non-stream | 10–25% reduction | 20–40% reduction | no regression in semantic parity |
| cross-surface stream | 10–20% reduction | 20–40% reduction | no full-body buffering |
| telemetry persistence | 30–60% fewer DB round trips | bounded queue memory | request path unchanged |
| batch-native provider work | provider-dependent | shared plan/header work | higher throughput, bounded wait |

Acceptance requires benchmark comparison against a recorded baseline. Percentages are not release claims until measured.

---

# 10. Automatic Batch Processing

## 10.1 Current state

Current code has:

- native model batch contracts, storage, scheduler, worker, and public/console batch APIs;
- admin `DeleteBatch` and `SetActiveBatch` account mutations;
- bounded token reservation recovery batches;
- OAuth refresh coalescing;
- compatibility/cache miss coalescing;
- telemetry and observability queues;
- admission waiter queue.

Current code now exposes a unified native model batch lifecycle under `router/internal/router/batch` plus public `/v1/batches` and console `/console/batches` routes.

`etteum-pool` contains login and warmup queues/schedulers. Those are useful references for bounded background work, but they are not a native model request batching implementation.

## 10.2 Batch modes

| Mode | Trigger | Wait policy | Persistence | Execution |
|---|---|---|---|---|
| interactive | normal chat/messages/responses request | zero intentional batching delay | request telemetry only | immediate router dispatch |
| explicit async batch | batch API or dashboard operation | caller accepts async completion | durable job/items | provider native batch or bounded parallel fallback |
| automatic maintenance batch | telemetry writes, quota refresh, health probes, retention | short bounded window | owner-specific | bulk DB/provider operations |
| native provider micro-batch | capability explicitly supports compatible grouping | bounded sub-millisecond/millisecond window | optional | one provider batch request |

## 10.3 Automatic grouping key

Requests can share a provider batch only when every key component matches:

```text
BatchKey
├── provider ID
├── provider batch capability version
├── target model
├── target surface
├── upstream endpoint
├── account ID or provider-approved credential scope
├── outbound proxy/network identity
├── response mode
├── tool/schema compatibility digest
├── safety/policy digest
├── catalog generation
└── translation-plan digest
```

If one component differs, create a different group.

## 10.4 Scheduler limits

Every batch policy requires:

- maximum items;
- maximum total bytes;
- maximum estimated tokens;
- maximum wait time;
- maximum concurrent groups per provider;
- maximum concurrent workers;
- per-account concurrency limit;
- request deadline check before enqueue and before dispatch;
- cancellation removal before dispatch;
- partial result mapping by stable item ID;
- independent item failure classification;
- no credential mixing;
- no cross-tenant content mixing unless explicitly isolated by provider contract.

## 10.5 Fallback behavior

```text
batch submitted
      |
      v
provider supports native batch?
      |
  yes | no
      |  +--> bounded parallel individual dispatch
      v
build native batch
      |
      v
submit upstream job
      |
      v
poll/webhook completion
      |
      v
map each result to item ID
      |
      v
classify each item independently
```

A failed item must not poison successful items. Provider-wide transport failure may fail or retry the group according to one bounded group budget.

## 10.6 Automatic telemetry batching

The first batch optimization to implement should be telemetry persistence because it is safe and does not alter model semantics.

Target writer:

- bounded channel remains fail-open;
- flush at item count threshold or time threshold;
- use bulk insert transaction;
- retry one bounded batch;
- split batch on a row-specific constraint failure only when needed;
- expose queue depth, batch size, flush latency, drops, and persistence failures;
- graceful shutdown drains within a deadline.

---

# 11. Dashboard Cutoff and Wiring

## 11.1 Dashboard becomes a pure SPA

After cutoff, dashboard contains no:

- PostgreSQL pool;
- SQL migration runner;
- SQLite database;
- Bun HTTP server;
- credential extraction logic;
- runtime router state;
- provider selection policy.

The Go console API gains the browser client-error endpoint and bounded log sink. This removes a second service and a second schema owner.

## 11.2 Dashboard feature ownership

Each feature folder owns:

```text
feature/
├── page.tsx
├── resource.ts
├── contracts.ts only when feature-local UI state differs from API contract
├── components.tsx only when not reusable elsewhere
└── state.ts only when persistent feature state exists
```

Do not create all four files by default. Create only files needed by the feature.

## 11.3 API wiring matrix

| Feature | Read API | Mutation/API stream | Go owner |
|---|---|---|---|
| overview | `/console/dashboard` | overview stream or bounded poll | console dashboard service |
| requests | `/console/telemetry/requests` | in-flight SSE | telemetry request projection |
| usage | `/console/telemetry/usage` | usage/in-flight SSE | telemetry usage service |
| providers | `/console/providers`, `/console/catalog` | provider refresh/update | provider control service |
| accounts | `/console/accounts` | create/update/delete/batch state | account control service |
| quota | `/console/accounts/quota` | quota refresh | account quota service |
| proxies | `/console/proxies` | CRUD/test | egress proxy control service |
| batches | `/console/batches` | submit/cancel/stream progress | router batch service |
| logs | `/console/logs` | log SSE/clear | telemetry logs service |
| settings | `/console/settings` | patch settings | app settings service |
| login | `/auth/session` | login/logout | session service |
| share | `/share/:id` | public SSE if configured | share service |
| browser errors | no page | `POST /console/client-errors` | telemetry client-error service |

## 11.4 Contract generation

`contracts/openapi/console.yaml` is the authority for dashboard API shapes.

Preferred flow:

```text
Go contract review
    |
    v
OpenAPI contract
    |
    +--> generated TypeScript API types
    |
    +--> contract verification tests
    |
    v
Dashboard client
```

Do not generate UI view models. Generate wire contracts only.

---

# 12. Reference Repository Disposition

## 12.1 Cartethyia-107

| Reference area | Use | Target owner | Disposition |
|---|---|---|---|
| `src/routing/resolve.ts` | alias/combo/qualification parity | router/catalog | behavior tests, no source import |
| `src/routing/strategy.ts` | rotation strategy semantics | router/selector | behavior tests |
| `src/translate/concerns` | tools, images, cache, finish reason cases | protocol/codec | fixture extraction |
| `src/translate/openai-anthropic.ts` | cross-surface parity | protocol/codec | fixture extraction |
| `src/translate/openai-responses.ts` | Responses parity | protocol/codec | fixture extraction |
| `src/translate/google-gemini.ts` | Gemini parity | protocol/codec | fixture extraction |
| `src/upstream/dispatch.ts` | dispatch behavior reference | router/service | compare behavior, do not port control flow |
| `src/upstream/retry.ts` | failure taxonomy cases | router/outcome + providers/classification | test cases |
| `src/upstream/bridge.ts` | stream edge cases | gateway/egress/protocol | fixture extraction |
| `src/tokenkeeper` | auth/quota quirks | accounts | test and driver parity |
| `src/console` | operator workflows | console/dashboard | contract behavior only |

## 12.2 etteum-pool

| Reference area | Use | Target owner | Disposition |
|---|---|---|---|
| `src/proxy/router.ts` | pool selection cases | router | behavior reference |
| `src/proxy/pool.ts` | readiness and least-inflight cases | router/accounts | behavior reference |
| `src/proxy/model-mapping.ts` | model alias cases | router/catalog | fixture extraction |
| `src/proxy/transforms` | provider translation deviations | providers/adapters | evaluate per provider |
| `src/proxy/compression` | compression rules and thresholds | router/optimizer | port only measured useful filters |
| `src/proxy/providers` | provider capability quirks | providers/adapters | port per declared release provider |
| `src/auth/queue.ts` | bounded worker behavior | accounts/background or router/batch | pattern reference |
| `src/auth/warmup-queue.ts` | progress and cancellation | account quota/health worker | pattern reference |
| `src/auth/warmup-scheduler.ts` | automatic background scheduling | account service | pattern reference |
| `src/services/proxy-pool.ts` | outbound proxy pool | egress | capability reference |
| WebSocket implementation | live state ideas | console SSE | do not introduce second live transport without requirement |
| Python helper workers | provider-specific workflow | providers/adapters | reject by default; require explicit capability decision |

---

# 13. Refactor Order and Cutover Gates

This section defines dependency order, not the final task-by-task implementation plan.

## Stage A: Baseline contracts

- record current route and translation fixtures;
- move compatibility corpus to root contracts;
- establish benchmark inputs;
- freeze new cross-package helpers;
- define import boundary checks.

Gate:

- every current ingress surface has fixtures;
- same-surface and cross-surface behavior baselines exist;
- route/failover baseline scenarios exist.

## Stage B: Root naming without behavior change

- rename `daemon` to `router`;
- move deployment files;
- merge scripts into tools;
- move load and compatibility fixtures;
- update workspace/build/import paths in one cutoff.

Gate:

- old folder names no longer referenced;
- build and existing tests pass;
- no compatibility shim or alias remains.

## Stage C: Package ownership moves

- create target Go owners;
- move app, gateway, console, storage, telemetry, and egress boundaries;
- keep runtime behavior unchanged;
- remove old packages after each complete owner migration.

Gate:

- import graph follows allowed direction;
- no old package remains as wrapper;
- bootstrap starts one router.

## Stage D: Protocol fast-path cleanup

- implement compatibility decision before canonical decoding;
- implement PASS;
- implement PATCH;
- preserve TRANSLATE parity;
- optimize same-surface stream passthrough;
- move provider-specific repair rules.

Gate:

- same-surface outputs preserve bytes when no patch is required;
- cross-surface fixtures remain semantically equivalent;
- benchmarks meet agreed regression limits;
- no unsupported semantic field is silently stripped.

## Stage E: Router decomposition

- split attempt state, selection, outcome, and stream lifecycle inside router owner;
- keep one coordinator;
- reuse prepared bytes across eligible retries;
- make plan immutable;
- preserve route budgets.

Gate:

- one route coordinator;
- attempt terminal closure exactly once;
- deterministic retry/failover classification;
- no provider adapter retry loop.

## Stage F: Automatic background batching

- batch telemetry writes;
- batch quota/health background scans;
- expose batch metrics;
- verify graceful drain.

Gate:

- request path remains non-blocking;
- bounded memory and worker counts;
- no secret/content leakage across batch items.

## Stage G: Native model batches

- add batch contracts, storage, scheduler, and API only for declared providers;
- support provider native batch and bounded parallel fallback;
- add dashboard batch feature.

Gate:

- item mapping and partial failures proven;
- cancellation and expiry proven;
- no interactive stream batching delay.

## Stage H: Dashboard backend cutoff

- add Go client-error endpoint;
- migrate required dashboard data;
- delete dashboard Bun server, migrations, SQLite/Postgres helpers, and data directory;
- reorganize UI by feature;
- generate TypeScript wire contracts.

Gate:

- dashboard starts as static SPA;
- every page uses Go console API;
- no dashboard SQL connection;
- no second log database.

## Stage I: Legacy quarantine

- finish parity disposition table;
- remove obsolete behavior branches;
- document references as read-only;
- update root architecture documents.

Gate:

- zero runtime references to legacy repositories;
- zero duplicate authorities;
- full smoke scenarios pass.

---

# 14. Progress and Percentage Model

## 14.1 Current architecture debt estimate

These are source-scan estimates for planning:

| Area | Current structural clarity | Required cleanup remaining |
|---|---:|---:|
| root product naming | 45% | 55% |
| Go ownership boundaries | 60% | 40% |
| router state machine | 75% | 25% |
| passthrough optimization | 45% | 55% |
| cross-surface translation | 75% | 25% |
| provider/account ownership | 60% | 40% |
| batch infrastructure | 25% | 75% |
| dashboard pure operator boundary | 45% | 55% |
| deployment/test organization | 40% | 60% |
| reference parity disposition | 35% | 65% |

## 14.2 Target composition of the refactor

| Workstream | Weight |
|---|---:|
| root/package restructure | 15% |
| protocol PASS/PATCH/TRANSLATE | 20% |
| router decomposition and cutoff | 20% |
| provider/account/egress ownership | 15% |
| automatic batch processing | 10% |
| dashboard Go wiring and backend removal | 15% |
| documentation, performance, and final cutoff | 5% |
| **Total** | **100%** |

## 14.3 Completion definition

A workstream is not counted complete when files are merely moved. It is complete only when:

- all callers migrated;
- old package removed;
- no alias/shim remains;
- behavior verification passes;
- owner documentation matches source;
- performance does not regress outside accepted bound.

---

# 15. Risks and Controls

| Risk | Severity | Control |
|---|---|---|
| large rename breaks imports/build tooling | high | one clean root cutoff with LSP-aware rename and immediate build |
| PASS bypasses required semantic repair | high | compatibility/provider policy decides path before dispatch |
| PATCH corrupts JSON or unknown fields | high | fuzz, differential fixtures, byte-preservation tests |
| cross-surface parity regresses | high | legacy-derived corpus and semantic comparison |
| stream retry duplicates client-visible output | critical | retry allowed only before first committed byte |
| batch mixes credentials or tenants | critical | BatchKey includes account/tenant/security scope |
| async batch grows unbounded | high | durable limits, queue limits, expiry, admission |
| dashboard loses logs during backend cutoff | medium | Go endpoint before deleting Bun server, explicit data migration decision |
| package move creates wrapper packages | medium | clean cutover; wrappers forbidden |
| generic helper package returns | medium | boundary linter rejects `utils`, `helpers`, `common`, `shared` Go packages |
| pooling retains secrets or large bodies | critical | never pool credential-bearing or large canonical objects |
| telemetry batch loses metadata on shutdown | medium | bounded drain and explicit drop metrics |
| provider-specific behavior leaks into generic protocol | high | policy ownership review per adapter |

---

# 16. Review Decisions Needed Before the Big Implementation Plan

This report recommends defaults so implementation planning can proceed without architectural ambiguity.

| Decision | Recommended answer |
|---|---|
| Rename `daemon`? | yes, to `router` |
| Rename `dashboard`? | no; keep the familiar operator-product name |
| Keep dashboard Bun backend? | no; remove after Go endpoint cutoff |
| Add root `shared`? | no |
| Add root `contracts`? | yes |
| Add root `tests`? | yes, only cross-process tests |
| Add root `deploy`? | yes |
| Rename root `scripts` to `tools`? | yes |
| Full canonical normalization for same surface? | no |
| Same-surface byte passthrough? | yes by default |
| Targeted patch path? | yes |
| Cross-surface translation? | keep and optimize |
| Generic automatic batching for all interactive requests? | no |
| Automatic maintenance and telemetry batching? | yes |
| Native model batching? | yes only per explicit provider capability |
| Import old TypeScript router source? | no |
| Use old repositories as behavioral references? | yes |

---

# 17. Final Target

```text
ONE PRODUCT
Cartethyia Proxy Router

ONE DATA PLANE
router/gateway -> protocol -> router -> providers/accounts -> egress

ONE OPERATOR INTERFACE
Go console API -> SolidJS dashboard

ONE STORAGE AUTHORITY
Go storage package -> PostgreSQL

ONE REQUEST DECISION
PASS | PATCH | TRANSLATE

ONE RETRY AUTHORITY
router

ONE BATCH AUTHORITY
router/batch

ZERO DUPLICATE BACKENDS
ZERO GENERIC UTILITY DUMPING GROUNDS
ZERO LEGACY RUNTIME DEPENDENCIES
```

The next document should be the executable master plan: ordered rename batches, symbol migration sets, dependency gates, verification commands, rollback points, and per-stage acceptance criteria. That plan should be generated only after this target structure is accepted or amended.
