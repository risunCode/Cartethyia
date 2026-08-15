package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/cartethyia/daemon/internal/database/migrations"
	"github.com/cartethyia/daemon/internal/database/repositories"
)

// RuntimeStore is the durable PostgreSQL composition used by daemon startup.
// The database remains the authority; repositories are adapters over the same
// Bun handle and are never replaced with process-local stores.
type RuntimeStore struct {
	Database        *BunDatabase
	Migrator        *migrations.SQLMigrator
	CustomProviders *repositories.BunCustomProviderRepository
	Proxies         *repositories.BunProxyRepository
	APIKeys         *repositories.BunPublicAPIKeyResolver
	AdminAPIKeys    *repositories.BunAPIKeyRepository
	TokenBudget     *repositories.BunTokenBudgetRepository
	// RefreshLeases, Telemetry, and account authority stores share the same
	// PostgreSQL pool. Secret blobs are encrypted before persistence.
	RefreshLeases *repositories.BunRefreshLeaseStore
	Telemetry     *repositories.BunTelemetryRepository
	Settings      *repositories.BunSettingsRepository
	Catalog       *repositories.BunCatalogRepository
	Backups       *repositories.BunBackupRepository
	Bans          *repositories.BunBanRepository
	AccountCore   *repositories.BunAccountStores
	Accounts      *repositories.BunAccountConfigStore
	Records       *repositories.BunRecordStore
	Secrets       *repositories.BunSecretStore
}

// OpenRuntime parses a PostgreSQL URL, opens and pings the pool, applies all
// ordered migrations, and constructs the repositories that are implemented by
// this package. Any failure closes the pool before returning.
func OpenRuntime(ctx context.Context, rawURL string, encryptionKeys ...[]byte) (*RuntimeStore, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	store, err := openRuntimeStore(ctx, rawURL, encryptionKeys...)
	if err != nil {
		return nil, err
	}
	if _, err := store.Migrator.Apply(ctx); err != nil {
		_ = store.Database.Close()
		return nil, fmt.Errorf("database runtime: migrate PostgreSQL: %w", err)
	}
	return store, nil
}

// OpenRuntimeReadOnly opens the durable repositories without applying
// migrations. Diagnostic commands use it to inspect the same authorities as
// serving without changing schema or application state.
func OpenRuntimeReadOnly(ctx context.Context, rawURL string, encryptionKeys ...[]byte) (*RuntimeStore, error) {
	return openRuntimeStore(ctx, rawURL, encryptionKeys...)
}

func openRuntimeStore(ctx context.Context, rawURL string, encryptionKeys ...[]byte) (*RuntimeStore, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg, err := ParseConfig(rawURL)
	if err != nil {
		return nil, fmt.Errorf("database runtime: %w", err)
	}
	database, err := OpenBun(ctx, cfg)
	if err != nil {
		return nil, err
	}
	migrator := migrations.NewSQLMigrator(database)
	store := &RuntimeStore{
		Database:        database,
		Migrator:        migrator,
		CustomProviders: repositories.NewBunCustomProviderRepository(database.Bun()),
		Proxies:         repositories.NewBunProxyRepository(database.Bun()),
		APIKeys:         repositories.NewBunPublicAPIKeyResolver(database.Bun()),
		AdminAPIKeys:    repositories.NewBunAPIKeyRepository(database.Bun()),
		TokenBudget:     repositories.NewBunTokenBudgetRepository(database.Bun()),
		RefreshLeases:   repositories.NewBunRefreshLeaseStore(database.Bun()),
		Telemetry:       repositories.NewBunTelemetryRepository(database.Bun()),
		Settings:        repositories.NewBunSettingsRepository(database.Bun()),
		Catalog:         repositories.NewBunCatalogRepository(database.Bun()),
		Backups:         repositories.NewBunBackupRepository(database.Bun()),
		Bans:            repositories.NewBunBanRepository(database.Bun()),
	}
	if len(encryptionKeys) > 0 && len(encryptionKeys[0]) > 0 {
		core, storeErr := repositories.NewBunAccountStores(database.Bun(), encryptionKeys[0])
		if storeErr != nil {
			_ = database.Close()
			return nil, storeErr
		}
		store.AccountCore = core
		store.Accounts = &repositories.BunAccountConfigStore{BunAccountStores: core}
		store.Records = &repositories.BunRecordStore{BunAccountStores: core}
		store.Secrets = &repositories.BunSecretStore{BunAccountStores: core}
	}
	return store, nil
}

// Probe checks PostgreSQL reachability for readiness. It does not run
// migrations or mutate state after startup composition has completed.
func (s *RuntimeStore) Probe(ctx context.Context) error {
	if s == nil || s.Database == nil {
		return errors.New("database runtime: PostgreSQL is unavailable")
	}
	return s.Database.Ping(ctx)
}

// Close releases the PostgreSQL pool. It is safe to call on nil.
func (s *RuntimeStore) Close(context.Context) error {
	if s == nil || s.Database == nil {
		return nil
	}
	return s.Database.Close()
}

var _ repositories.MigratorRunner = (*migrations.SQLMigrator)(nil)
