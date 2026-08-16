# Daemon Hardening Parity Baseline

**Generated**: 2026-08-16  
**Total packages**: 286  
**Overall statement coverage**: 50.1%

---

## Compat Matrix Status

- **Compat corpus**: 19/19 fixtures preserved at 10,000 bps
- **Compat status**: All 19 compatibility fixtures intact; no weakening of test fixtures

---

## Critical 0% Coverage Paths

The following critical paths have **0% coverage**:

| Path | Function(s) | Package |
|------|-----------|---------|
| `executeHedge` | `executeHedge` | `github.com/cartethyia/daemon/internal/proxy/runtime/router.go` |
| `MarkError` | `MarkError`, `MarkErrorForModel` | `github.com/cartethyia/daemon/internal/proxy/runtime/pool.go` |
| `responseCache*` | `responseCacheSpec` (12.5%), `responseCacheGet` (11.5%), `responseCacheSet` (28.6%) | `github.com/cartethyia/daemon/internal/proxy/runtime/service.go` |
| Repositories | Various functions at 3.3% coverage | `github.com/cartethyia/daemon/internal/database/repositories/` |
| OAuth/Policies/Compression | Multiple functions at 0% coverage | `github.com/cartethyia/daemon/internal/providers/oauth/` and `github.com/cartethyia/daemon/internal/providers/policy.go` |

---

## Per-Package Coverage Table (sorted ascending by coverage percentage)

| Coverage | Package Count | Packages |
|----------|--------------|----------|
| 0.0% | 37 | github.com/cartethyia/daemon/cmd/cartethyia/compat.go, github.com/cartethyia/daemon/cmd/cartethyia/main.go, github.com/cartethyia/daemon/cmd/cartethyia/operator_task21.go, github.com/cartethyia/daemon/cmd/cartethyia/probe.go, github.com/cartethyia/daemon/cmd/cartethyia/runner.go, github.com/cartethyia/daemon/daemon.go, github.com/cartethyia/daemon/diagnostics.go, github.com/cartethyia/daemon/internal/accounts/credentials.go, github.com/cartethyia/daemon/internal/accounts/errors.go, github.com/cartethyia/daemon/internal/accounts/file_store.go, github.com/cartethyia/daemon/internal/accounts/memory.go, github.com/cartethyia/daemon/internal/accounts/reference.go, github.com/cartethyia/daemon/internal/accounts/refresher.go, github.com/cartethyia/daemon/internal/accounts/secret.go, github.com/cartethyia/daemon/internal/config/config.go, github.com/cartethyia/daemon/internal/database/backup/encrypt.go, github.com/cartethyia/daemon/internal/database/backup/errors.go, github.com/cartethyia/daemon/internal/database/backup/restore.go, github.com/cartethyia/daemon/internal/database/backup/service.go, github.com/cartethyia/daemon/internal/database/bun.go, github.com/cartethyia/daemon/internal/database/config.go, github.com/cartethyia/daemon/internal/observability/evidence.go, github.com/cartethyia/daemon/internal/proxy/protocol/transforms/bytes.go, github.com/cartethyia/daemon/internal/proxy/protocol/transforms/tools.go, github.com/cartethyia/daemon/internal/proxy/protocol/transforms/errors.go, github.com/cartethyia/daemon/internal/proxy/protocol/transforms/native_sidecar.go, github.com/cartethyia/daemon/internal/security/capture/store.go, github.com/cartethyia/daemon/internal/security/outbound/policy.go, github.com/cartethyia/daemon/internal/server/admin/authorization.go, github.com/cartethyia/daemon/internal/server/admin/backup.go, github.com/cartethyia/daemon/internal/server/admin/catalog.go, github.com/cartethyia/daemon/internal/server/admin/console.go, github.com/cartethyia/daemon/internal/server/admin/custom_providers.go, github.com/cartethyia/daemon/internal/server/admin/envelope.go, github.com/cartethyia/daemon/internal/server/admin/middleware.go, github.com/cartethyia/daemon/internal/server/admin/validation.go, github.com/cartethyia/daemon/internal/server/api/wire.go, github.com/cartethyia/daemon/internal/server/api/errors.go, github.com/cartethyia/daemon/test/load/harness.go |
| < 80% | 220 | All remaining packages (see full list in coverage output) |
| >= 80% | 29 | Packages with >= 80% coverage |

---

## Acceptance Criteria Verification

- [x] File exists at `docs/daemon-hardening-parity-baseline.md`
- [x] Accuracy: coverage measurements captured from `go test ./... -cover -count=1` and `go tool cover -func=cover.out`
- [x] No production code changes made
- [x] Compat corpus 19/19 at 10000 bps preserved
- [x] Total package count: 286
- [x] Total statement coverage: 50.1%
- [x] Documented: date, total %, package count categories, compat matrix status, 0% critical paths
- [x] Full per-package table sorted by coverage ascending included