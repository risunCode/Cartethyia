package services

import (
	"context"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	consoleapi "github.com/cartethyia/daemon/internal/console/api"
	"github.com/cartethyia/daemon/internal/providers"
	runtimecatalog "github.com/cartethyia/daemon/internal/router/catalog"
	repos "github.com/cartethyia/daemon/internal/storage/repositories"
	"github.com/cartethyia/daemon/internal/storage/models"
)

// TelemetryStore is the bounded repository surface consumed by console
// telemetry and usage projections. Storage implementations stay behind it.
type TelemetryStore interface {
	OverviewStats(context.Context, time.Time, time.Time, string) (models.TelemetryOverview, error)
	TimeBuckets(context.Context, time.Time, time.Time, string, string, bool, int) ([]models.TelemetryBucketPoint, error)
	UpstreamGroups(context.Context, time.Time, time.Time, string, string, int) ([]models.TelemetryUpstreamGroup, error)
	UsageTotals(context.Context, time.Time, time.Time, string) (models.TelemetryUsageTotals, error)
	ClientUsage(context.Context, time.Time, time.Time, string, int) ([]models.TelemetryClientUsage, error)
	GetRequest(context.Context, int64) (models.RequestHistory, error)
	ListConsoleLogsFiltered(context.Context, models.ConsoleLogFilter) ([]models.ConsoleLog, error)
}

// BuildInput contains only owner interfaces and bounded runtime dependencies
// needed to compose production console services. It deliberately excludes
// bootstrap/application types so app remains the lifecycle owner.
type BuildInput struct {
	Accounts  accounts.AccountConfigStore
	Records   accounts.RecordStore
	Secrets   accounts.SecretStore
	Refresher accounts.Refresher
	DriverRegistry *accounts.Registry
	Registry  *providers.Registry
	Catalog   interface{ Status() runtimecatalog.RefreshStatus }
	Proxies   repos.ProxyRepository
	APIKeys   repos.APIKeyRepository
	Telemetry TelemetryStore
	Console   *ConsoleEventSink
	InFlightStats consoleapi.InFlightStatsSource
	InFlightDetail consoleapi.InFlightDetailSource
	Environment string
	Settings *repos.BunSettingsRepository
	ListenAddress string
	ConsolePassword string
}

// BuildServices composes concrete repository-backed console services while
// keeping storage and runtime implementations out of the HTTP API package.
func BuildServices(input BuildInput) (consoleapi.Services, error) {
	var out consoleapi.Services
	if input.Accounts != nil {
		out.Dashboard = &postgresDashboardAdminService{accounts: input.Accounts, proxies: input.Proxies, keys: input.APIKeys, environment: input.Environment}
		out.Accounts = &postgresAccountAdminService{accounts: input.Accounts, records: input.Records, secrets: input.Secrets, refresher: input.Refresher}
	}
	if input.Telemetry != nil {
		out.Telemetry = newPostgresTelemetryAdminService(input.Telemetry)
		out.Usage = newPostgresUsageAdminService(input.Telemetry)
		out.ConsoleLogs = newPostgresConsoleLogService(input.Telemetry, input.Console)
	}
	if input.Registry != nil {
		out.Catalog = &registryCatalogAdminService{registry: input.Registry, accounts: input.Accounts, catalog: input.Catalog}
	}
	out.InFlightStats = input.InFlightStats
	out.InFlightDetail = input.InFlightDetail
	if input.Settings != nil {
		out.Settings = newPostgresSettingsAdminService(input.Settings, input.Environment, input.ListenAddress)
	}
	if input.DriverRegistry != nil && input.Accounts != nil && input.Secrets != nil && input.Records != nil {
		oauth, err := consoleapi.NewOAuthService(input.DriverRegistry, accounts.NewManager(accounts.ManagerOptions{}), input.Accounts, input.Secrets, input.Records, input.Refresher)
		if err != nil {
			return consoleapi.Services{}, err
		}
		out.OAuth = oauth
		if input.Settings != nil {
			out.Auth = newSessionAuthService(input.Settings, oauth, input.ConsolePassword)
		}
	}
	return out, nil
}
