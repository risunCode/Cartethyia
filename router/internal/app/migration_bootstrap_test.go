package app

import (
	"context"
	"os"
	"testing"

	"github.com/cartethyia/daemon/internal/storage/migrations"
)

// TestPostgreSQLBootstrapUsesStorageMigrationRegistry verifies the production
// composition path applies and reports the final storage migration registry.
// The integration dependency is optional; migration package unit tests provide
// the deterministic proof when PostgreSQL is unavailable.
func TestPostgreSQLBootstrapUsesStorageMigrationRegistry(t *testing.T) {
	rawURL := os.Getenv("CARTETHYIA_POSTGRES_URL")
	if rawURL == "" {
		t.Skip("set CARTETHYIA_POSTGRES_URL to run PostgreSQL bootstrap coverage")
	}

	deps, err := defaultBootstrapDependencies(Config{
		DatabaseURL:          rawURL,
		AccountEncryptionKey: "integration-key-material-32-bytes-long",
	}.WithDefaults())
	if err != nil {
		t.Fatalf("PostgreSQL bootstrap dependencies: %v", err)
	}
	if deps.Database == nil || deps.Database.Migrator == nil {
		t.Fatal("PostgreSQL bootstrap did not compose a storage migrator")
	}
	t.Cleanup(func() { _ = deps.Database.Close(context.Background()) })

	status, err := deps.Database.Migrator.Status(context.Background())
	if err != nil {
		t.Fatalf("storage migration status: %v", err)
	}
	all := migrations.All()
	want := all[len(all)-1].Version
	if len(status.Pending) != 0 {
		t.Fatalf("bootstrap left %d migrations pending", len(status.Pending))
	}
	if status.CurrentVersion != want {
		t.Fatalf("bootstrap migration version = %d, want final storage version %d", status.CurrentVersion, want)
	}
}
