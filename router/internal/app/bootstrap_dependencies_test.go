package app

import (
	"context"
	"strings"
	"testing"
)

func TestDefaultBootstrapDependenciesDevPath(t *testing.T) {
	deps, err := defaultBootstrapDependencies(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("defaultBootstrapDependencies: %v", err)
	}
	if deps.Registry == nil || deps.DriverRegistry == nil || deps.Cache == nil {
		t.Fatalf("missing core deps: %#v", deps)
	}
	t.Cleanup(func() { _ = deps.Cache.Close() })
}

// TestDefaultBootstrapDependenciesWireResponseCacheAndUsage proves the
// complete-response cache and the usage ledger are constructed on the default
// bootstrap path, so the dispatch service's cache and usage seams are live in
// production instead of silently no-oping.
func TestDefaultBootstrapDependenciesWireResponseCacheAndUsage(t *testing.T) {
	deps, err := defaultBootstrapDependencies(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("defaultBootstrapDependencies: %v", err)
	}
	t.Cleanup(func() { _ = deps.Cache.Close() })
	if deps.ResponseCache == nil {
		t.Fatal("ResponseCache is not wired by defaultBootstrapDependencies")
	}
	if deps.Usage == nil {
		t.Fatal("Usage ledger is not wired by defaultBootstrapDependencies")
	}
}

func TestParseEnableHedging(t *testing.T) {
	cases := map[string]bool{
		"":           false,
		"   ":        false,
		"true":       true,
		"1":          true,
		"TRUE":       true,
		"false":      false,
		"0":          false,
		"yes":        false,
		"garbage":    false,
		" true \t\n": true,
	}
	for raw, want := range cases {
		if got := parseEnableHedging(raw); got != want {
			t.Fatalf("parseEnableHedging(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestDefaultBootstrapDependenciesProductionRequiresDatabaseURL(t *testing.T) {
	_, err := defaultBootstrapDependencies(Config{Environment: "production"}.WithDefaults())
	if err == nil || !strings.Contains(err.Error(), "DatabaseURL") {
		t.Fatalf("expected DatabaseURL error, got %v", err)
	}
}

func TestDefaultBootstrapDependenciesProductionRequiresEncryptionKey(t *testing.T) {
	_, err := defaultBootstrapDependencies(Config{
		Environment: "production",
		DatabaseURL: "postgres://user:pass@localhost:5432/cartethyia",
	}.WithDefaults())
	if err == nil || !strings.Contains(err.Error(), "encryption key") {
		t.Fatalf("expected encryption key error, got %v", err)
	}
}

func TestBuildHandlerWithArtworkAndDependenciesRequiresRegistry(t *testing.T) {
	_, err := buildHandlerWithArtworkAndDependencies(Config{}.WithDefaults(), BootstrapDependencies{}, "")
	if err == nil || !strings.Contains(err.Error(), "registry is required") {
		t.Fatalf("expected registry error, got %v", err)
	}
}

func TestDefaultBootstrapDependenciesWithDatabaseURLWithoutPG(t *testing.T) {
	_, err := defaultBootstrapDependencies(Config{
		DatabaseURL:          "postgres://user:pass@127.0.0.1:1/none",
		AccountEncryptionKey: "sixteen-byte-key!",
		ConnectTimeout:       1,
	}.WithDefaults())
	if err == nil {
		t.Fatal("expected PostgreSQL bootstrap failure without live database")
	}
	if !strings.Contains(err.Error(), "PostgreSQL") && !strings.Contains(err.Error(), "connect") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildHandlerUsesDefaultBootstrap(t *testing.T) {
	handler, err := buildHandler(Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("buildHandler: %v", err)
	}
	if handler == nil {
		t.Fatal("nil handler")
	}
}

func TestBuildHandlerWithArtworkUsesDefaultBootstrap(t *testing.T) {
	handler, err := buildHandlerWithArtwork(Config{}.WithDefaults(), "")
	if err != nil {
		t.Fatalf("buildHandlerWithArtwork: %v", err)
	}
	if handler == nil {
		t.Fatal("nil handler")
	}
}

func TestBuildHandlerWithExplicitDeps(t *testing.T) {
	deps, err := defaultBootstrapDependencies(Config{}.WithDefaults())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deps.Cache.Close() })
	handler, err := buildHandlerWith(Config{}.WithDefaults(), deps)
	if err != nil {
		t.Fatalf("buildHandlerWith: %v", err)
	}
	if handler == nil {
		t.Fatal("nil handler")
	}
}

func TestOpenDiagnosticSnapshotDevPath(t *testing.T) {
	snapshot, err := openDiagnosticSnapshot(context.Background(), Config{}.WithDefaults())
	if err != nil {
		t.Fatalf("openDiagnosticSnapshot: %v", err)
	}
	if snapshot.registry == nil || snapshot.catalog == nil {
		t.Fatalf("snapshot missing registry/catalog: %#v", snapshot)
	}
	snapshot.close()
}
