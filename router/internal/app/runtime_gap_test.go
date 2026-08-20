package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	proxy "github.com/cartethyia/daemon/internal/router"
)

func TestBuildCustomProviderAccountsSupportsLegacyAndMultipleRefs(t *testing.T) {
	accounts, err := buildCustomProviderAccounts([]models.CustomProvider{
		{Slug: "legacy", CredentialRef: "legacy-ref"},
		{Slug: "multi", CredentialRefs: []string{"one", "two"}},
	})
	if err != nil {
		t.Fatalf("buildCustomProviderAccounts: %v", err)
	}
	if len(accounts["legacy"]) != 1 || accounts["legacy"][0].ID != "custom:legacy:0" {
		t.Fatalf("legacy accounts = %#v", accounts["legacy"])
	}
	if len(accounts["multi"]) != 2 || accounts["multi"][1].CredentialRef.String() != "two" {
		t.Fatalf("multi accounts = %#v", accounts["multi"])
	}
	if !accounts["multi"][0].Enabled {
		t.Fatal("custom account should be enabled")
	}
}

func TestBuildCustomProviderAccountsRejectsInvalidReference(t *testing.T) {
	_, err := buildCustomProviderAccounts([]models.CustomProvider{{Slug: "broken", CredentialRefs: []string{""}}})
	if err == nil || !strings.Contains(err.Error(), `credential reference 0`) {
		t.Fatalf("invalid reference error = %v", err)
	}
}

func TestDiagnosticAccountStateWithoutDatabase(t *testing.T) {
	ref, err := contracts.NewCredentialRef("ref")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := &diagnosticSnapshot{}
	if state, reason := diagnosticAccountState(context.Background(), snapshot, proxy.Account{Enabled: false}, "model"); state != "" || reason != "disabled" {
		t.Fatalf("disabled state = %q, %q", state, reason)
	}
	if state, reason := diagnosticAccountState(context.Background(), snapshot, proxy.Account{Enabled: true}, "model"); state != "" || reason != "credential_reference_missing" {
		t.Fatalf("missing credential state = %q, %q", state, reason)
	}
	if state, reason := diagnosticAccountState(context.Background(), snapshot, proxy.Account{Enabled: true, CredentialRef: ref}, "model"); state != "healthy" || reason != "" {
		t.Fatalf("healthy state = %q, %q", state, reason)
	}
}

func TestValidateDiagnosticProxiesSkipsUnconfiguredDatabase(t *testing.T) {
	count, err := validateDiagnosticProxies(context.Background(), &diagnosticSnapshot{})
	if err != nil || count != 0 {
		t.Fatalf("unconfigured proxies = %d, %v", count, err)
	}
}

func TestAppendExclusionIsBoundedAndNilSafe(t *testing.T) {
	appendExclusion(nil, "account", "id", "reason")
	result := RouteExplanation{}
	for range maxDiagnosticExclusions + 2 {
		appendExclusion(&result, "account", "id", "reason")
	}
	if len(result.Exclusions) != maxDiagnosticExclusions {
		t.Fatalf("exclusion count = %d, want %d", len(result.Exclusions), maxDiagnosticExclusions)
	}
}

func TestReadinessRejectsProductionWithoutDatabase(t *testing.T) {
	cfg := Config{Environment: "production", AccountEncryptionKey: "key"}.WithDefaults()
	_, err := Readiness(context.Background(), cfg, "")
	if err == nil || !strings.Contains(err.Error(), "database is required") {
		t.Fatalf("production readiness error = %v", err)
	}
}

func TestDiagnosticAccountStateIgnoresExpiredModelLockWithoutDatabase(t *testing.T) {
	ref, err := contracts.NewCredentialRef("ref")
	if err != nil {
		t.Fatal(err)
	}
	state, reason := diagnosticAccountState(context.Background(), &diagnosticSnapshot{}, proxy.Account{Enabled: true, CredentialRef: ref, LastUsedAt: time.Time{}}, "model")
	if state != "healthy" || reason != "" {
		t.Fatalf("state = %q, reason = %q", state, reason)
	}
}
