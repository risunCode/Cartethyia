#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 1. go test ./... -count=1"
go test ./... -count=1

echo "==> 2. go vet ./..."
go vet ./...

echo "==> 3. compat matrix"
go run ./cmd/cartethyia compat matrix --corpus testdata/compatibility

echo "==> 4. coverage check"
go run ./scripts/check-coverage.go "$@"

echo "==> verify-hardening: ALL GATES PASS"
