package repositories

import (
	"context"

	"github.com/cartethyia/daemon/internal/database/migrations"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
)

// MigratorRunner is the interface cmd packages depend on when running
// migrations without importing the internal/db driver layer. It matches
// migrations.Migrator and exists so callers can wire the concrete
// runtime-backed implementation at composition time.
type MigratorRunner interface {
	Status(ctx context.Context) (migrations.MigrationStatus, error)
	Plan(ctx context.Context) (migrations.MigrationPlan, error)
	Apply(ctx context.Context) (migrations.MigrationResult, error)
}

// Bundle groups every Cartethyia repository for runtime wiring.
//
// The runtime injects one Bundle into the admin/proxy/auth packages; each
// consumer depends only on the subset it needs.
type Bundle struct {
	Accounts    AccountRepository
	APIKeys     APIKeyRepository
	Proxies     ProxyRepository
	Settings    SettingsRepository
	Bans        BanRepository
	Telemetry   TelemetryRepository
	Migrator    MigratorRunner
	TokenBudget tokenbudget.TokenBudgetAuthority
}

// WithAccounts returns a shallow copy of the bundle with Accounts set.
func (b Bundle) WithAccounts(r AccountRepository) Bundle {
	b.Accounts = r
	return b
}

// WithAPIKeys returns a shallow copy of the bundle with APIKeys set.
func (b Bundle) WithAPIKeys(r APIKeyRepository) Bundle {
	b.APIKeys = r
	return b
}

// WithProxies returns a shallow copy of the bundle with Proxies set.
func (b Bundle) WithProxies(r ProxyRepository) Bundle {
	b.Proxies = r
	return b
}

// WithSettings returns a shallow copy of the bundle with Settings set.
func (b Bundle) WithSettings(r SettingsRepository) Bundle {
	b.Settings = r
	return b
}

// WithBans returns a shallow copy of the bundle with Bans set.
func (b Bundle) WithBans(r BanRepository) Bundle {
	b.Bans = r
	return b
}

// WithTelemetry returns a shallow copy of the bundle with Telemetry set.
func (b Bundle) WithTelemetry(r TelemetryRepository) Bundle {
	b.Telemetry = r
	return b
}

// WithMigrator returns a shallow copy of the bundle with Migrator set.
func (b Bundle) WithMigrator(r MigratorRunner) Bundle {
	b.Migrator = r
	return b
}

// WithTokenBudget returns a shallow copy with the durable token authority set.
func (b Bundle) WithTokenBudget(r tokenbudget.TokenBudgetAuthority) Bundle {
	b.TokenBudget = r
	return b
}
