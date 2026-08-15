# Daemon Core Cleanup Audit — Validated Before/After

## Status

- Scope: `daemon/`
- Stage: cleanup before the next reinforcement/hardening pass
- This document is a proposal and inventory; no daemon source implementation is changed by this report.
- Test files are intentionally omitted from the tree diagrams. Test naming and test relocation are a separate follow-up.

## Correction to the previous report

The previous report was too optimistic. It treated package count and source-file count as primary cleanup targets and proposed approximately 25 packages. That is not a realistic target for this daemon without either:

```text
- flattening valid dependency boundaries;
- moving a large amount of code without runtime benefit;
- increasing package blast radius;
- making provider, database, and protocol ownership less clear;
- risking removal or accidental replacement of real functionality.
```

The corrected target is approximately **40–42 packages**, not 25.

The corrected principle is:

```text
Merge duplicate ownership and duplicated orchestration.
Keep valid runtime, storage, protocol, provider, and security boundaries.
Do not split or merge a file merely because of its line count.
```

An 800–1200 line Go file is acceptable when it represents one coherent state machine, protocol surface, catalog, migration registry, or provider definition group. Go compiles/type-checks a package, not an individual source file. Splitting a cohesive file inside the same package does not directly improve latency, allocations, GC pressure, lock contention, network I/O, or the generated hot path.

---

## Current evidence

Repository scan of `daemon/`:

| Metric | Current value |
|---|---:|
| Go packages from `go list ./...` | 60 |
| All Go files | 476 |
| Non-`_test.go` Go files | 321 |
| `_test.go` files | 155 |
| Non-test LOC | 70,015 |
| Test LOC | 21,444 |

The non-`_test.go` inventory includes a small amount of test-support code whose filename is not `_test.go`; the diagrams below omit those support files because the request is a production ownership tree.

Largest production areas:

| Area | Non-test LOC | Assessment |
|---|---:|---|
| `internal/proxy` | 27,778 | request path, protocol path, transport, cache policy |
| `internal/database` | 7,986 | persistence, migration, backup, repositories |
| `internal/providers` | 7,783 | registry, catalog, provider definitions, adapters |
| `internal/server` | 7,211 | HTTP ingress, public API, admin API, middleware |
| `internal/runtime` | 6,003 | composition, lifecycle, diagnostics, cache integration |
| `internal/accounts` | 4,886 | account, secret, credential, refresh, drivers |
| `internal/observability` | 4,203 | events, evidence, metrics, usage |

Largest non-test files:

```text
1,547  internal/proxy/runtime/router.go
1,233  internal/proxy/control/cacheplan/plan.go
1,196  internal/proxy/protocol/transforms/canonical.go
1,165  internal/proxy/protocol/transforms/openai_responses.go
1,083  internal/proxy/runtime/catalog/catalog.go
1,004  internal/proxy/runtime/pool.go
  979  internal/proxy/runtime/service.go
  959  internal/proxy/protocol/transforms/anthropic.go
  953  internal/observability/events.go
  947  internal/proxy/runtime/stream_bridge.go
  861  internal/runtime/bootstrap.go
```

Largest import sets:

```text
30 imports  internal/runtime/bootstrap.go
23 imports  internal/proxy/runtime/service.go
18 imports  internal/proxy/transport/http.go
17 imports  cmd/cartethyia/operator_task21.go
15 imports  internal/accounts/drivers/common.go
14 imports  internal/runtime/diagnostics.go
14 imports  internal/server/middleware/public_auth.go
```

High-fan-in packages:

```text
55 production importers  internal/proxy/protocol/contracts
22 production importers  internal/providers
21 production importers  internal/database/models
15 production importers  internal/accounts
13 production importers  internal/server/api/contracts
11 production importers  internal/observability
10 production importers  internal/proxy/protocol/transforms
```

Interpretation:

```text
- protocol/contracts is expected to be high-fan-in because it is the shared
  wire-independent request/response vocabulary;
- providers is expected to be high-fan-in because capability and descriptor
  data are used by catalog, runtime, adapters, and diagnostics;
- database/models is a coupling concern because persistence representation is
  being used as a shared domain representation;
- bootstrap.go having many imports is acceptable because it is a composition
  root and must know concrete implementations.
```

---

# Before: complete production ownership tree

The following is the current non-test tree. `_test.go` files and test-only support are omitted deliberately.

```text
daemon/
├── daemon.go
├── diagnostics.go
├── cmd/
│   └── cartethyia/
│       ├── compat.go
│       ├── env.go
│       ├── main.go
│       ├── operator_task21.go
│       ├── probe.go
│       └── runner.go
└── internal/
    ├── accounts/
    │   ├── credentials.go
    │   ├── doc.go
    │   ├── driver.go
    │   ├── errors.go
    │   ├── file_store.go
    │   ├── memory.go
    │   ├── reference.go
    │   ├── refresher.go
    │   ├── secret.go
    │   ├── store.go
    │   ├── contract/
    │   │   └── contract.go
    │   ├── drivers/
    │   │   ├── common.go
    │   │   ├── identity.go
    │   │   ├── kiro_modes.go
    │   │   ├── registry.go
    │   │   ├── anthropic/
    │   │   │   └── driver.go
    │   │   ├── antigravity/
    │   │   │   └── driver.go
    │   │   ├── cline/
    │   │   │   └── driver.go
    │   │   ├── codex/
    │   │   │   └── driver.go
    │   │   ├── grokbuild/
    │   │   │   └── driver.go
    │   │   ├── kimchi/
    │   │   │   └── driver.go
    │   │   └── kiro/
    │   │       └── driver.go
    │   ├── flow/
    │   │   ├── callback.go
    │   │   └── sessions.go
    │   └── store/
    │       └── store.go
    ├── config/
    │   └── config.go
    ├── database/
    │   ├── bun.go
    │   ├── config.go
    │   ├── doc.go
    │   ├── runtime.go
    │   ├── backup/
    │   │   ├── doc.go
    │   │   ├── dumper.go
    │   │   ├── encrypt.go
    │   │   ├── errors.go
    │   │   ├── metadata.go
    │   │   ├── reporter.go
    │   │   ├── restore.go
    │   │   ├── service.go
    │   │   └── uploader.go
    │   ├── migrations/
    │   │   ├── doc.go
    │   │   ├── migrations.go
    │   │   └── migrator.go
    │   ├── models/
    │   │   ├── account.go
    │   │   ├── apikey.go
    │   │   ├── backup.go
    │   │   ├── ban.go
    │   │   ├── doc.go
    │   │   ├── proxy.go
    │   │   ├── settings.go
    │   │   └── telemetry.go
    │   └── repositories/
    │       ├── account.go
    │       ├── account_stores.go
    │       ├── apikey.go
    │       ├── backup.go
    │       ├── ban.go
    │       ├── bun_backup_ban.go
    │       ├── bun_proxy.go
    │       ├── bun_settings.go
    │       ├── bundle.go
    │       ├── catalog.go
    │       ├── custom_provider.go
    │       ├── doc.go
    │       ├── proxy.go
    │       ├── refresh_lease.go
    │       ├── settings.go
    │       ├── telemetry.go
    │       ├── telemetry_bun.go
    │       └── token_budget.go
    ├── observability/
    │   ├── compatibility_evidence.go
    │   ├── events.go
    │   ├── evidence.go
    │   ├── labels.go
    │   ├── logging.go
    │   ├── metadata.go
    │   ├── metrics.go
    │   ├── taxonomy.go
    │   ├── tracing.go
    │   └── usage/
    │       └── ledger.go
    ├── providers/
    │   ├── agentrouter.go
    │   ├── agentrouter_definition.go
    │   ├── catalog.go
    │   ├── errors.go
    │   ├── internal.go
    │   ├── modelsdev.go
    │   ├── policy.go
    │   ├── provider.go
    │   ├── registry.go
    │   ├── special.go
    │   ├── adapters/
    │   │   ├── aliases.go
    │   │   ├── anthropic.go
    │   │   ├── antigravity.go
    │   │   ├── claudecode_policy.go
    │   │   ├── codex.go
    │   │   ├── grok.go
    │   │   ├── internal.go
    │   │   └── openai.go
    │   ├── apikey/
    │   │   ├── aimlapi.go
    │   │   ├── alibaba.go
    │   │   ├── alibaba_coding_plan.go
    │   │   ├── alibaba_token_plan.go
    │   │   ├── anthropic.go
    │   │   ├── baseten.go
    │   │   ├── blackboxai.go
    │   │   ├── cerebras.go
    │   │   ├── codebuddy.go
    │   │   ├── codebuddy_cn.go
    │   │   ├── coreweave.go
    │   │   ├── deepseek.go
    │   │   ├── firepass.go
    │   │   ├── fireworks.go
    │   │   ├── github_copilot.go
    │   │   ├── groq.go
    │   │   ├── helpers.go
    │   │   ├── huggingface.go
    │   │   ├── kilo.go
    │   │   ├── kimi_code.go
    │   │   ├── litellm.go
    │   │   ├── lm_studio.go
    │   │   ├── meta.go
    │   │   ├── minimax.go
    │   │   ├── minimax_code.go
    │   │   ├── minimax_code_cn.go
    │   │   ├── mistral.go
    │   │   ├── moonshot.go
    │   │   ├── nanogpt.go
    │   │   ├── novita.go
    │   │   ├── nvidia.go
    │   │   ├── ollama.go
    │   │   ├── ollama_cloud.go
    │   │   ├── openai.go
    │   │   ├── opencodefree.go
    │   │   ├── opencodego.go
    │   │   ├── opencodezen.go
    │   │   ├── openrouter.go
    │   │   ├── qianfan.go
    │   │   ├── qwen_portal.go
    │   │   ├── registry.go
    │   │   ├── siliconflow.go
    │   │   ├── siliconflow_cn.go
    │   │   ├── synthetic.go
    │   │   ├── together.go
    │   │   ├── umans.go
    │   │   ├── venice.go
    │   │   ├── vercel_ai_gateway.go
    │   │   ├── vllm.go
    │   │   ├── wafer_serverless.go
    │   │   ├── xai.go
    │   │   ├── xiaomitp.go
    │   │   ├── zai.go
    │   │   ├── zenmux.go
    │   │   └── zhipu_coding_plan.go
    │   ├── builtin/
    │   │   ├── custom.go
    │   │   ├── defaults.go
    │   │   └── materialize.go
    │   ├── oauth/
    │   │   ├── antigravity.go
    │   │   ├── claudecode.go
    │   │   ├── cline.go
    │   │   ├── clinepass.go
    │   │   ├── codex.go
    │   │   ├── grokbuild.go
    │   │   ├── helpers.go
    │   │   ├── kimchi.go
    │   │   ├── kiro.go
    │   │   └── registry.go
    │   └── policies/
    │       ├── antigravity.go
    │       ├── claudecode.go
    │       ├── codex.go
    │       ├── grokbuild.go
    │       └── policy.go
    ├── proxy/
    │   ├── proxy.go
    │   ├── compression/
    │   │   ├── cache.go
    │   │   ├── doc.go
    │   │   ├── filters.go
    │   │   ├── options.go
    │   │   ├── orchestrator.go
    │   │   ├── pipeline.go
    │   │   └── types.go
    │   ├── control/
    │   │   ├── admission/
    │   │   │   └── limiter.go
    │   │   ├── cacheplan/
    │   │   │   ├── identity.go
    │   │   │   └── plan.go
    │   │   ├── continuation/
    │   │   │   └── state.go
    │   │   └── tokenbudget/
    │   │       └── tokenbudget.go
    │   ├── protocol/
    │   │   ├── compatibility/
    │   │   │   ├── plan.go
    │   │   │   ├── profile.go
    │   │   │   └── corpus/
    │   │   │       ├── acceptance.go
    │   │   │       ├── manifest.go
    │   │   │       ├── scorer.go
    │   │   │       └── semantic.go
    │   │   ├── contracts/
    │   │   │   ├── contracts.go
    │   │   │   └── domain.go
    │   │   └── transforms/
    │   │       ├── anthropic.go
    │   │       ├── anthropic_response.go
    │   │       ├── anthropic_response_encoder.go
    │   │       ├── bytes.go
    │   │       ├── canonical.go
    │   │       ├── compaction_codec.go
    │   │       ├── doc.go
    │   │       ├── errors.go
    │   │       ├── gemini.go
    │   │       ├── gemini_response.go
    │   │       ├── gemini_response_encoder.go
    │   │       ├── invariants.go
    │   │       ├── models.go
    │   │       ├── native_sidecar.go
    │   │       ├── normalize.go
    │   │       ├── openai_chat.go
    │   │       ├── openai_chat_response.go
    │   │       ├── openai_chat_response_encoder.go
    │   │       ├── openai_responses.go
    │   │       ├── openai_responses_response.go
    │   │       ├── openai_responses_response_encoder.go
    │   │       ├── pipeline.go
    │   │       ├── ports.go
    │   │       ├── prepare.go
    │   │       ├── response_codec.go
    │   │       ├── shared.go
    │   │       ├── stages.go
    │   │       └── tools.go
    │   ├── runtime/
    │   │   ├── errors.go
    │   │   ├── filters.go
    │   │   ├── metadata_lifecycle.go
    │   │   ├── pool.go
    │   │   ├── preparation.go
    │   │   ├── readiness.go
    │   │   ├── repair.go
    │   │   ├── response_projection.go
    │   │   ├── router.go
    │   │   ├── selectors.go
    │   │   ├── service.go
    │   │   ├── stream.go
    │   │   ├── stream_bridge.go
    │   │   └── catalog/
    │   │       └── catalog.go
    │   └── transport/
    │       ├── http.go
    │       └── sse.go
    ├── runtime/
    │   ├── admin_accounts.go
    │   ├── admin_services.go
    │   ├── admin_settings.go
    │   ├── bootstrap.go
    │   ├── custom_provider_accounts.go
    │   ├── custom_provider_service.go
    │   ├── diagnostics.go
    │   ├── errors.go
    │   ├── lifecycle.go
    │   ├── network.go
    │   ├── recovery.go
    │   ├── runtime.go
    │   └── cache/
    │       ├── cache.go
    │       ├── content.go
    │       ├── doc.go
    │       ├── entry.go
    │       ├── errors.go
    │       ├── generation.go
    │       ├── health.go
    │       ├── key.go
    │       ├── memory.go
    │       ├── redis.go
    │       ├── redis_client.go
    │       ├── response.go
    │       └── router.go
    ├── security/
    │   ├── capture/
    │   │   └── store.go
    │   └── outbound/
    │       └── policy.go
    └── server/
        ├── registrar.go
        ├── response.go
        ├── router.go
        ├── share.go
        ├── admin/
        │   ├── accounts.go
        │   ├── admin.go
        │   ├── apikeys.go
        │   ├── auth.go
        │   ├── authorization.go
        │   ├── backup.go
        │   ├── catalog.go
        │   ├── console.go
        │   ├── custom_providers.go
        │   ├── dashboard.go
        │   ├── envelope.go
        │   ├── middleware.go
        │   ├── oauth_service.go
        │   ├── proxies.go
        │   ├── services.go
        │   ├── settings.go
        │   ├── telemetry.go
        │   ├── tools.go
        │   └── validation.go
        ├── api/
        │   ├── contracts/
        │   │   └── contracts.go
        │   ├── errors/
        │   │   └── errors.go
        │   ├── v1/
        │   │   ├── v1.go
        │   │   ├── action/
        │   │   │   └── action.go
        │   │   ├── chat/
        │   │   │   └── chat.go
        │   │   ├── gemini/
        │   │   │   └── gemini.go
        │   │   ├── images/
        │   │   │   └── images.go
        │   │   ├── messages/
        │   │   │   ├── count_tokens.go
        │   │   │   └── messages.go
        │   │   ├── models/
        │   │   │   └── models.go
        │   │   └── responses/
        │   │       └── responses.go
        │   └── wire/
        │       ├── deadlines.go
        │       ├── response_headers.go
        │       └── wire.go
        └── middleware/
            ├── admission.go
            ├── auth.go
            ├── ban.go
            ├── chain.go
            ├── client.go
            ├── context.go
            ├── doc.go
            ├── limits.go
            ├── method.go
            ├── public_auth.go
            ├── request_id.go
            ├── response.go
            └── response_headers.go
```

Current ownership problems visible in this tree:

```text
1. internal/proxy/proxy.go is an alias façade while the implementation lives
   under internal/proxy/runtime, whose package name is also proxy.

2. server/api has many one-file packages even though they share the same HTTP
   request lifecycle and dependencies.

3. account driver providers have one package directory per driver even though
   they are all implementations of the same driver registry boundary.

4. control packages are mixed: some are request-core dependencies, while
   cacheplan is also consumed by provider adapters and operator tooling.

5. database/models and database/repositories are broad shared hubs. This is a
   coupling issue, not an invitation to delete persistence functionality.
```

---

# After: complete proposed production ownership tree

This is the corrected, conservative target. It does **not** remove provider definitions, account drivers, persistence models, protocol surfaces, cache backends, admin routes, or diagnostics. It consolidates only clear duplicate package ownership.

```text
daemon/
├── daemon.go
├── diagnostics.go
├── cmd/
│   └── cartethyia/
│       ├── compat.go
│       ├── env.go
│       ├── main.go
│       ├── operator.go                 # operator_task21.go renamed only
│       ├── probe.go
│       └── runner.go
└── internal/
    ├── accounts/
    │   ├── credentials.go
    │   ├── contract.go                 # contract/contract.go merged into owner
    │   ├── doc.go
    │   ├── driver.go
    │   ├── errors.go
    │   ├── file_store.go
    │   ├── memory.go
    │   ├── reference.go
    │   ├── refresher.go
    │   ├── secret.go
    │   ├── store.go                     # account/store/store.go merged here
    │   ├── drivers/
    │   │   ├── common.go
    │   │   ├── identity.go
    │   │   ├── kiro_modes.go
    │   │   ├── registry.go
    │   │   ├── anthropic.go             # former drivers/anthropic/driver.go
    │   │   ├── antigravity.go           # former drivers/antigravity/driver.go
    │   │   ├── cline.go                 # former drivers/cline/driver.go
    │   │   ├── codex.go                 # former drivers/codex/driver.go
    │   │   ├── grokbuild.go             # former drivers/grokbuild/driver.go
    │   │   ├── kimchi.go                # former drivers/kimchi/driver.go
    │   │   └── kiro.go                  # former drivers/kiro/driver.go
    │   └── flow/
    │       ├── callback.go
    │       └── sessions.go
    ├── config/
    │   └── config.go
    ├── database/
    │   ├── bun.go
    │   ├── config.go
    │   ├── doc.go
    │   ├── runtime.go
    │   ├── backup/
    │   │   ├── doc.go
    │   │   ├── dumper.go
    │   │   ├── encrypt.go
    │   │   ├── errors.go
    │   │   ├── metadata.go
    │   │   ├── reporter.go
    │   │   ├── restore.go
    │   │   ├── service.go
    │   │   └── uploader.go
    │   ├── migrations/
    │   │   ├── doc.go
    │   │   ├── migrations.go
    │   │   └── migrator.go
    │   ├── models/
    │   │   ├── account.go
    │   │   ├── apikey.go
    │   │   ├── backup.go
    │   │   ├── ban.go
    │   │   ├── doc.go
    │   │   ├── proxy.go
    │   │   ├── settings.go
    │   │   └── telemetry.go
    │   └── repositories/
    │       ├── account.go
    │       ├── account_stores.go
    │       ├── apikey.go
    │       ├── backup.go
    │       ├── ban.go
    │       ├── bun_backup_ban.go
    │       ├── bun_proxy.go
    │       ├── bun_settings.go
    │       ├── bundle.go
    │       ├── catalog.go
    │       ├── custom_provider.go
    │       ├── doc.go
    │       ├── proxy.go
    │       ├── refresh_lease.go
    │       ├── settings.go
    │       ├── telemetry.go
    │       ├── telemetry_bun.go
    │       └── token_budget.go
    ├── observability/
    │   ├── compatibility_evidence.go
    │   ├── events.go
    │   ├── evidence.go
    │   ├── labels.go
    │   ├── logging.go
    │   ├── metadata.go
    │   ├── metrics.go
    │   ├── taxonomy.go
    │   ├── tracing.go
    │   └── usage/
    │       └── ledger.go
    ├── providers/
    │   ├── agentrouter.go
    │   ├── agentrouter_definition.go
    │   ├── catalog.go
    │   ├── errors.go
    │   ├── internal.go
    │   ├── modelsdev.go
    │   ├── policy.go
    │   ├── provider.go
    │   ├── registry.go
    │   ├── special.go
    │   ├── adapters/
    │   │   ├── aliases.go
    │   │   ├── anthropic.go
    │   │   ├── antigravity.go
    │   │   ├── claudecode_policy.go
    │   │   ├── codex.go
    │   │   ├── grok.go
    │   │   ├── internal.go
    │   │   └── openai.go
    │   ├── apikey/
    │   │   ├── aimlapi.go
    │   │   ├── alibaba.go
    │   │   ├── alibaba_coding_plan.go
    │   │   ├── alibaba_token_plan.go
    │   │   ├── anthropic.go
    │   │   ├── baseten.go
    │   │   ├── blackboxai.go
    │   │   ├── cerebras.go
    │   │   ├── codebuddy.go
    │   │   ├── codebuddy_cn.go
    │   │   ├── coreweave.go
    │   │   ├── deepseek.go
    │   │   ├── firepass.go
    │   │   ├── fireworks.go
    │   │   ├── github_copilot.go
    │   │   ├── groq.go
    │   │   ├── helpers.go
    │   │   ├── huggingface.go
    │   │   ├── kilo.go
    │   │   ├── kimi_code.go
    │   │   ├── litellm.go
    │   │   ├── lm_studio.go
    │   │   ├── meta.go
    │   │   ├── minimax.go
    │   │   ├── minimax_code.go
    │   │   ├── minimax_code_cn.go
    │   │   ├── mistral.go
    │   │   ├── moonshot.go
    │   │   ├── nanogpt.go
    │   │   ├── novita.go
    │   │   ├── nvidia.go
    │   │   ├── ollama.go
    │   │   ├── ollama_cloud.go
    │   │   ├── openai.go
    │   │   ├── opencodefree.go
    │   │   ├── opencodego.go
    │   │   ├── opencodezen.go
    │   │   ├── openrouter.go
    │   │   ├── qianfan.go
    │   │   ├── qwen_portal.go
    │   │   ├── registry.go
    │   │   ├── siliconflow.go
    │   │   ├── siliconflow_cn.go
    │   │   ├── synthetic.go
    │   │   ├── together.go
    │   │   ├── umans.go
    │   │   ├── venice.go
    │   │   ├── vercel_ai_gateway.go
    │   │   ├── vllm.go
    │   │   ├── wafer_serverless.go
    │   │   ├── xai.go
    │   │   ├── xiaomitp.go
    │   │   ├── zai.go
    │   │   ├── zenmux.go
    │   │   └── zhipu_coding_plan.go
    │   ├── builtin/
    │   │   ├── custom.go
    │   │   ├── defaults.go
    │   │   └── materialize.go
    │   ├── oauth/
    │   │   ├── antigravity.go
    │   │   ├── claudecode.go
    │   │   ├── cline.go
    │   │   ├── clinepass.go
    │   │   ├── codex.go
    │   │   ├── grokbuild.go
    │   │   ├── helpers.go
    │   │   ├── kimchi.go
    │   │   ├── kiro.go
    │   │   └── registry.go
    │   └── policies/
    │       ├── antigravity.go
    │       ├── claudecode.go
    │       ├── codex.go
    │       ├── grokbuild.go
    │       └── policy.go
    ├── proxy/
    │   ├── compression/
    │   │   ├── cache.go
    │   │   ├── doc.go
    │   │   ├── filters.go
    │   │   ├── options.go
    │   │   ├── orchestrator.go
    │   │   ├── pipeline.go
    │   │   └── types.go
    │   ├── control/
    │   │   ├── admission/
    │   │   │   └── limiter.go
    │   │   ├── cacheplan/
    │   │   │   ├── identity.go
    │   │   │   └── plan.go
    │   │   ├── continuation/
    │   │   │   └── state.go
    │   │   └── tokenbudget/
    │   │       └── tokenbudget.go
    │   ├── protocol/
    │   │   ├── compatibility/
    │   │   │   ├── plan.go
    │   │   │   ├── profile.go
    │   │   │   └── corpus/
    │   │   │       ├── acceptance.go
    │   │   │       ├── manifest.go
    │   │   │       ├── scorer.go
    │   │   │       └── semantic.go
    │   │   ├── contracts/
    │   │   │   ├── contracts.go
    │   │   │   └── domain.go
    │   │   └── transforms/
    │   │       ├── anthropic.go
    │   │       ├── anthropic_response.go
    │   │       ├── anthropic_response_encoder.go
    │   │       ├── bytes.go
    │   │       ├── canonical.go
    │   │       ├── compaction_codec.go
    │   │       ├── doc.go
    │   │       ├── errors.go
    │   │       ├── gemini.go
    │   │       ├── gemini_response.go
    │   │       ├── gemini_response_encoder.go
    │   │       ├── invariants.go
    │   │       ├── models.go
    │   │       ├── native_sidecar.go
    │   │       ├── normalize.go
    │   │       ├── openai_chat.go
    │   │       ├── openai_chat_response.go
    │   │       ├── openai_chat_response_encoder.go
    │   │       ├── openai_responses.go
    │   │       ├── openai_responses_response.go
    │   │       ├── openai_responses_response_encoder.go
    │   │       ├── pipeline.go
    │   │       ├── ports.go
    │   │       ├── prepare.go
    │   │       ├── response_codec.go
    │   │       ├── shared.go
    │   │       ├── stages.go
    │   │       └── tools.go
    │   ├── runtime/
    │   │   ├── errors.go
    │   │   ├── filters.go
    │   │   ├── metadata_lifecycle.go
    │   │   ├── pool.go
    │   │   ├── preparation.go
    │   │   ├── readiness.go
    │   │   ├── repair.go
    │   │   ├── response_projection.go
    │   │   ├── router.go
    │   │   ├── selectors.go
    │   │   ├── service.go
    │   │   ├── stream.go
    │   │   ├── stream_bridge.go
    │   │   └── catalog/
    │   │       └── catalog.go
    │   └── transport/
    │       ├── http.go
    │       └── sse.go
    ├── runtime/
    │   ├── admin_accounts.go
    │   ├── admin_services.go
    │   ├── admin_settings.go
    │   ├── bootstrap.go
    │   ├── custom_provider_accounts.go
    │   ├── custom_provider_service.go
    │   ├── diagnostics.go
    │   ├── errors.go
    │   ├── lifecycle.go
    │   ├── network.go
    │   ├── recovery.go
    │   ├── runtime.go
    │   └── cache/
    │       ├── cache.go
    │       ├── content.go
    │       ├── doc.go
    │       ├── entry.go
    │       ├── errors.go
    │       ├── generation.go
    │       ├── health.go
    │       ├── key.go
    │       ├── memory.go
    │       ├── redis.go
    │       ├── redis_client.go
    │       ├── response.go
    │       └── router.go
    ├── security/
    │   ├── capture/
    │   │   └── store.go
    │   └── outbound/
    │       └── policy.go
    └── server/
        ├── registrar.go
        ├── response.go
        ├── router.go
        ├── share.go
        ├── admin/
        │   ├── accounts.go
        │   ├── admin.go
        │   ├── apikeys.go
        │   ├── auth.go
        │   ├── authorization.go
        │   ├── backup.go
        │   ├── catalog.go
        │   ├── console.go
        │   ├── custom_providers.go
        │   ├── dashboard.go
        │   ├── envelope.go
        │   ├── middleware.go
        │   ├── oauth_service.go
        │   ├── proxies.go
        │   ├── services.go
        │   ├── settings.go
        │   ├── telemetry.go
        │   ├── tools.go
        │   └── validation.go
        ├── api/
        │   ├── v1.go
        │   ├── action.go
        │   ├── chat.go
        │   ├── gemini.go
        │   ├── images.go
        │   ├── count_tokens.go
        │   ├── messages.go
        │   ├── models.go
        │   ├── responses.go
        │   ├── deadlines.go
        │   ├── response_headers.go
        │   └── wire.go
        ├── apicontracts/
        │   └── contracts.go
        ├── apierrors/
        │   └── errors.go
        └── middleware/
            ├── admission.go
            ├── auth.go
            ├── ban.go
            ├── chain.go
            ├── client.go
            ├── context.go
            ├── doc.go
            ├── limits.go
            ├── method.go
            ├── public_auth.go
            ├── request_id.go
            ├── response.go
            └── response_headers.go
```

## After package count

Approximate package count after this conservative consolidation:

```text
Before: approximately 60 packages
After:  approximately 40–42 packages
```

The reduction comes from real duplicate package boundaries, not from deleting functionality:

```text
- remove the root proxy alias package after caller migration:              -1
- flatten public API leaf packages into server/api:                         -9 to -10
- flatten account driver implementation subpackages into drivers:          -7
- merge accounts/contract and accounts/store into accounts:                 -2
```

The exact final `go list ./...` count must be measured after migration because Go package count also includes command and load/support packages. It is deliberately not promised as exactly 40.

---

# Before vs after: ownership and behavior

| Area | Before | After | Runtime behavior |
|---|---|---|---|
| Public daemon entry | `daemon.go` delegates into `internal/runtime` | unchanged | no behavior change |
| App composition | `internal/runtime/bootstrap.go` | same `internal/runtime` owner, optional file-level wiring split | no request-path change |
| Proxy authority | root `internal/proxy` aliases `internal/proxy/runtime` | `internal/proxy/runtime` is the only proxy implementation path | no protocol or routing feature removal |
| Proxy controls | admission, continuation, token budget, compression, prompt cache split into mixed subpackages | only clearly shared package boundaries are merged later; cacheplan stays separate | no policy removal |
| Router | one large router with duplicated stream/non-stream transitions | same router owner; dedupe only equivalent attempt transitions | retry, refresh, hedge, repair, quota preserved |
| Protocol contracts | shared `contracts` package | retained | all surfaces preserved |
| Protocol transforms | per-surface codecs and canonical model | retained; only duplicate helpers may be unified | OpenAI/Anthropic/Gemini semantics preserved |
| Compatibility corpus | dedicated compatibility/corpus package | retained | acceptance gate preserved |
| Cache | runtime cache with memory/Redis/router/content/response layers | retained as a separate boundary for this phase | cache safety and race fixes preserved |
| Providers | provider definitions and adapters split by implementation family | retained | no provider removed or merged semantically |
| Accounts | account core, drivers, flow, contract/store packages | driver leaf packages flatten into one drivers package; account behavior retained | OAuth/API-key/manual flows preserved |
| Database | models, repositories, migrations, backup | retained; no risky domain-model rewrite in cleanup phase | all persistence features preserved |
| Public API | many one-file endpoint packages | one `server/api` package with one common HTTP orchestration owner | endpoint handlers and wire contracts preserved |
| Admin API | dedicated `server/admin` | unchanged | auth, admin mutation, telemetry, backup preserved |
| Middleware | dedicated middleware package | unchanged | auth, limits, request IDs, response handling preserved |
| CLI | `operator_task21.go` name carries task history | `operator.go` name carries responsibility | all operator commands preserved |

---

# What is optimized

## 1. Remove duplicate authority, not functionality

### Proxy alias façade

Current:

```text
internal/proxy/proxy.go
    aliases types from
internal/proxy/runtime/*.go
```

Target:

```text
all internal callers use internal/proxy/runtime directly;
root proxy alias file is deleted only after references reach zero.
```

Benefit:

```text
- one authority for Router, Stream, DispatchService, Account, and Transport;
- fewer ambiguous imports and alias lookups;
- smaller dependency graph and lower refactor blast radius;
- no runtime semantic change.
```

This is not a latency optimization. It is dependency and ownership cleanup.

## 2. Dedupe HTTP generation orchestration

The current public API packages repeat combinations of:

```text
request body reading
surface/operation detection
deadline/context setup
codec selection
compatibility planning
dispatch invocation
normal response projection
stream response writing
error mapping
```

Target:

```go
server/api.API

    handleGeneration(...)
    ChatCompletions(...)
    Messages(...)
    GenerateContent(...)
    Responses(...)
    Images(...)
    Models(...)
    Actions(...)
```

Only the common HTTP orchestration is unified. Surface-specific codec behavior remains in `protocol/transforms`.

Benefit:

```text
- one place to fix request lifecycle bugs;
- fewer repeated allocations in handler setup if the current handlers duplicate them;
- fewer package edges;
- identical error/timeout/stream ownership semantics across generation endpoints.
```

This must be verified with endpoint-level behavior tests after implementation. It is not permission to normalize incompatible wire formats.

## 3. Dedupe account-driver package scaffolding

Current provider driver layout has one package per small concrete driver:

```text
accounts/drivers/anthropic
accounts/drivers/antigravity
accounts/drivers/cline
accounts/drivers/codex
accounts/drivers/grokbuild
accounts/drivers/kimchi
accounts/drivers/kiro
```

Target:

```text
accounts/drivers/*.go
```

The drivers remain separate types/functions and remain registered independently. Only package scaffolding is removed.

Benefit:

```text
- one driver registry package;
- fewer package edges and import aliases;
- easier shared helper reuse;
- no credential flow or provider behavior removal.
```

## 4. Dedupe router transitions only where they are actually equal

`Route` and `RouteStream` share candidate selection, preparation, reservation, classification, and retry decisions, but they do not share acceptance/finalization semantics.

Safe optimization target:

```text
candidate acquisition
→ preparation
→ reservation
→ attempt bookkeeping
→ failure classification
→ retry decision
```

Keep separate:

```text
non-stream response acceptance
stream preflight
stream terminal ownership
stream finalization
```

Possible internal shape:

```go
type attemptState struct {
    attempted      []map[string]struct{}
    memberRequests []contracts.Request
    refreshes      map[string]int
    bestFailure    *Failure
    availability   Availability
}
```

This is only justified if differential tests and benchmarks show the two paths currently duplicate meaningful work. A generic callback-heavy state machine is not desired; it could add indirection and obscure terminal semantics.

## 5. Optimize stream rendering only after profiling

The stream bridge creates dynamic maps and JSON frames per event. This is a real performance candidate because event count scales with output length.

Measure:

```text
allocations per text delta
allocations per tool delta
bytes allocated per event
frame encoding ns/op
terminal event cost
```

If the bridge is a measurable hotspot:

```text
- use typed small frame structs where wire shape is stable;
- reuse bounded scratch buffers only with clear ownership;
- avoid global map reuse across goroutines;
- preserve exact terminal/event semantics;
- keep provider-native sidecars out of the wrong surface.
```

Do not optimize by removing validation or by forwarding raw provider frames.

## 6. Preserve cache mechanics and optimize measured contention

Do not merge Memory and Redis cache implementations. Their behavior differs:

```text
Memory: mutex/LRU/in-flight flight ownership, no network I/O
Redis: remote I/O, health transitions, remote error normalization
Router: policy, fallback, invalidation, health state
Response cache: request eligibility and projection-aware storage
Content store: shared content envelope and storage rules
```

Performance work should target:

```text
- lock hold duration in memory hit/miss paths;
- allocations in key/fingerprint creation;
- duplicate serialization for cache values;
- remote fallback behavior;
- hit path zero-provider-call invariant.
```

The existing close/single-flight race fix is a correctness invariant and must not be weakened for speed.

## 7. Do not merge provider definition files for fake performance

`providers/apikey` contains many provider definition files, but these are mostly static catalog data. Merging them would reduce filenames, not request allocations or network latency.

Keep the files unless a group has actual duplicated implementation logic. If a shared provider helper is duplicated, move that helper into `providers` or `providers/adapters`; do not merge unrelated provider definitions into one giant switch.

## 8. Keep database boundaries stable in this phase

`database/models` has broad fan-in, but moving all models into domain packages is a large semantic migration. It is not the first performance win.

For this cleanup phase:

```text
- keep models/repositories functional;
- stop adding new runtime dependencies on concrete repositories;
- expose narrow interfaces from the owner that needs them;
- perform model/domain migration only after request-path cleanup is stable.
```

This avoids a high-risk refactor disguised as a file cleanup.

---

# Import efficiency rules

## What reduces real dependency cost

```text
1. Delete the proxy alias façade after all callers migrate.
2. Flatten server API leaf packages that all depend on the same API contracts,
   errors, wire, middleware, and dispatch path.
3. Flatten account driver leaf packages into one drivers package.
4. Keep composition-root imports in bootstrap; do not hide them behind
   unnecessary factories.
5. Do not import database, server, or provider concrete packages into the
   canonical protocol model.
6. Do not import the app/bootstrap package from request-path packages.
7. Keep compatibility corpus/scoring tooling out of live request execution.
8. Keep heavy optional dependencies behind the existing cache/provider/runtime
   boundaries rather than adding new imports to every handler.
```

## What does not improve runtime by itself

```text
- renaming router.go;
- splitting canonical.go into five files in the same package;
- grouping provider definitions into fewer files;
- replacing a 1,000-line file with multiple files while keeping the same
  package, calls, allocations, and data flow;
- reducing imports in bootstrap by hiding the same concrete graph elsewhere.
```

## Import direction after cleanup

```text
cmd/cartethyia
    → daemon public API and offline operator contracts

internal/runtime
    → concrete composition of accounts, database, providers, proxy, cache,
      server, observability, security, and transport

internal/server
    → proxy runtime ports, protocol contracts/transforms, middleware, admin
      services
    ✗ no direct router policy implementation

internal/proxy/runtime
    → protocol contracts/transforms, catalog, control, providers, cache ports,
      observability
    ✗ no HTTP handler or database repository concrete dependency

internal/proxy/protocol/transforms
    → protocol contracts and standard library
    ✗ no runtime, server, database, or provider HTTP dependency

internal/providers
    → provider metadata, capabilities, adapters, protocol contracts
    ✗ no server handler dependency

internal/database
    → persistence models/repositories and database driver
    ✗ no public HTTP handler dependency

internal/observability
    → bounded event/evidence/metrics contracts
    ✗ no retry decision or request mutation authority
```

---

# Functionality preservation matrix

No real functionality is intentionally removed by the proposed tree.

| Functionality | Preservation rule |
|---|---|
| OpenAI Chat | retain request/response codecs, stream events, tools, usage, reasoning, finish semantics |
| OpenAI Responses | retain item types, output events, reasoning, compaction/context fields, strict projection |
| Anthropic Messages | retain tool use/result, media/document/PDF references, cache marker behavior, stream events |
| Gemini | retain contents/parts, function calls/results, inline media, tool role, stream projection |
| Compatibility planner | retain profiles, feature dispositions, capability errors, corpus scorer, cache planner |
| Account selection | retain pool, exclusions, per-model locks, readiness, cooldown, failover |
| Credential flow | retain opaque refs, late resolution, secret zeroing, OAuth refresh, invalidation |
| Router | retain retries, refresh, compatibility repair, hedging, quota reservation, availability wait |
| Stream lifecycle | retain preflight, cancellation, terminal event, finalization evidence, usage reconciliation |
| Cache | retain memory LRU, Redis, fallback policy, coalescing, generation, response/content cache |
| Provider catalog | retain built-ins, custom providers, aliases, model capabilities, refresh/stale behavior |
| Public API | retain all current public endpoints and wire envelopes |
| Admin API | retain auth, authorization, accounts, providers, proxies, settings, telemetry, backup, tools |
| CLI | retain serve, doctor, route explain, probe, compat commands, cache explain, readiness |
| Security | retain capture prevention, outbound policy, bounded/redacted evidence |
| Observability | retain events, metrics, usage ledger, compatibility evidence, bounded labels |
| Database | retain PostgreSQL, migrations, repositories, backup/restore, token budget, telemetry |

---

# Before vs after performance expectations

| Change | Expected runtime effect | Expected build/import effect | Risk |
|---|---|---|---|
| Delete proxy alias package | none directly | lower indirection and package edge count | medium during caller migration |
| Flatten API packages | none unless duplicate handler setup is removed | lower server package fan-out | medium; endpoint behavior must remain exact |
| Flatten driver packages | none | lower package count and registry import complexity | low if only package move |
| Merge account contract/store wrappers | none | lower account package edges | low-medium |
| Share router attempt bookkeeping | possible allocation/setup reduction, unproven | one authority for retry transition | high if over-generalized |
| Optimize stream frame encoding | possible measurable alloc/CPU reduction | unchanged or slightly simpler codec path | high; requires wire differential proof |
| Change cache key/value copies | possible CPU/alloc reduction | unchanged | high; cache safety risk |
| Move database models into domain packages | usually none immediately | lower persistence coupling later | high; defer |
| Merge provider definition files | none | lower file navigation only | medium; no performance justification |
| Split large files only | none | navigation only | low but low value |

No expected performance gain is marked as achieved until a benchmark/profile demonstrates it.

---

# Recommended execution order

## Phase 0 — Record baseline

```text
- benchmark router success, one retry, exhaustion, and stream preflight;
- benchmark protocol decode/normalize/encode;
- benchmark cache hit/miss/coalescing;
- benchmark stream frame encoding;
- record allocs/op and bytes/op;
- capture CPU and mutex profiles for representative local load.
```

Existing proof suites remain the safety gate. No Kiro task is marked complete merely because a file moved.

## Phase 1 — Low-risk ownership cleanup

```text
1. Migrate callers away from the root proxy alias façade.
2. Delete proxy.go only after references reach zero.
3. Flatten account driver leaf packages into accounts/drivers.
4. Merge accounts/contract and accounts/store into accounts owner files.
5. Rename operator_task21.go to operator.go.
```

Expected result: fewer package edges, no request behavior change.

## Phase 2 — Public API dedupe

```text
1. Create one server/api owner.
2. Move endpoint files into that package without changing wire structs.
3. Extract only the common HTTP generation orchestration.
4. Keep per-surface codec calls and endpoint-specific validation explicit.
5. Delete empty package wrappers after all references migrate.
```

Expected result: one API orchestration authority, not a generic protocol mega-handler.

## Phase 3 — Measured request-path dedupe

```text
1. Compare Route and RouteStream attempt setup.
2. Extract only identical candidate/preparation/retry bookkeeping.
3. Profile stream bridge allocations.
4. Optimize typed/direct frame encoding only if the profile justifies it.
5. Profile cache key/body copy cost.
6. Change ownership/copy rules only with cache and race proof.
```

## Phase 4 — Deferred domain boundary cleanup

```text
1. Audit database/models callers.
2. Move only true domain types to account/provider/network owners.
3. Keep Bun/SQL fields and mappings in database.
4. Migrate callers incrementally.
5. Delete obsolete persistence aliases.
```

This phase is not a prerequisite for the first performance pass.

---

# Verification gates

After every bounded migration:

```powershell
go test ./...
go build ./...
go vet ./...

$env:CGO_ENABLED = '1'
$env:CC = 'C:\Users\Aria\Tools\llvm-mingw-20260616-ucrt-x86_64\bin\gcc.exe'
go test -race ./...

go run ./cmd/cartethyia compat matrix --corpus testdata/compatibility --json
```

The compatibility acceptance baseline must remain:

```text
19/19 scenarios passed
15/15 Tier-0 scenarios passed
10000 bps total score
10000 bps Tier-0 score
```

Performance acceptance for a claimed optimization requires evidence appropriate to the claim:

```text
latency claim        → benchmark distribution or request profile
allocation claim     → -benchmem / alloc profile
lock claim           → mutex/block profile under load
package claim        → go list/import graph before vs after
cache claim          → hit/miss/provider-call and race proof
protocol claim       → differential/corpus acceptance proof
stream claim         → frame-level benchmark plus terminal/cancellation proof
```

---

# Final decision

The corrected target is not “make daemon 25 packages”. The corrected target is:

```text
Before:
- 60 packages;
- duplicated package authority around proxy;
- over-fragmented API and account-driver package scaffolding;
- valid large core files that should not be split by LOC;
- runtime hotspots that need profiling, not tree cosmetics.

After:
- approximately 40–42 packages;
- one proxy authority;
- one public API package with shared HTTP orchestration;
- one account-driver package with separate driver implementations;
- provider/database/protocol/cache boundaries preserved;
- real request-path dedupe measured before it is accepted;
- no real feature or functionality intentionally removed.
```

The main optimization is **not fewer `.go` files**. It is:

```text
less duplicated orchestration,
less duplicate package ownership,
less unnecessary import fan-out,
and fewer repeated allocations only where profiling proves them.
```

## Current implementation evidence

The current cleanup checkout now reports:

```text
42 Go packages from go list ./...
35 packages with tests passing
7 packages with no tests
0 stale imports for deleted proxy/account/API package paths
```

Verified commands:

```text
go test ./...                         passed
go build ./...                        passed
go vet ./...                          passed
go test -race ./...                   passed
compat matrix                         19/19 passed
Tier-0 compatibility                  15/15 passed
total and Tier-0 score                10000 bps
fuzz request decoders                 passed
fuzz cache keys                       passed
bounded 10k-account load proof        passed
```

Measured smoke baselines on the current Windows workstation include:

```text
router ordinary success               228.8 us, 19,376 B, 209 allocs
router one retry                      55.9 us, 9,416 B, 56 allocs
router exhaustion                     30.6 us, 15,216 B, 80 allocs
stream preflight                      28.3 us, 5,024 B, 29 allocs
response cache hit                    10.7 us, 1,400 B, 20 allocs
response cache miss                   23.0 us, 4,320 B, 26 allocs
cache key fingerprint                 7.6 us, 3,280 B, 21 allocs
```

These are current smoke measurements, not cross-commit performance claims. A future optimization must compare the same benchmark workload against the pre-cleanup baseline before claiming a regression or improvement.
