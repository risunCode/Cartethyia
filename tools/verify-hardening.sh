#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/router"

echo "==> 1. go test ./... -count=1"
go test ./... -count=1

echo "==> 2. go vet ./..."
go vet ./...

echo "==> 3. compat matrix acceptance"
go test ./cmd/cartethyia -run '^TestCompatMatrixApprovedCorpusRunsAcceptanceGates$' -count=1

echo "==> 4. coverage check"
go run ./scripts/check-coverage.go "$@"

echo "==> verify-router-hardening: ALL GATES PASS"
