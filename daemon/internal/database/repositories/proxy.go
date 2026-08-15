package repositories

import (
	"context"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

// ProxyRepository owns the proxies / proxy_health / proxy_settings /
// custom_providers / warp_accounts / warp_metrics surfaces.
//
// ProxySettings is a singleton (id = 1); GetSettings and PatchSettings
// model the legacy "row is the config" pattern. WarpAccount PID is held
// separately from "running" because a daemon restart may leave a stale
// PID until warp reattaches.
type ProxyRepository interface {
	List(ctx context.Context) ([]models.Proxy, error)
	Get(ctx context.Context, id string) (models.Proxy, error)
	Create(ctx context.Context, input models.ProxyCreateInput) (models.Proxy, error)
	Patch(ctx context.Context, id string, patch models.ProxyPatchInput) (models.Proxy, error)
	RecordTest(ctx context.Context, id string, result models.ProxyTestResult) (models.Proxy, error)
	Delete(ctx context.Context, id string) (bool, error)

	GetSettings(ctx context.Context) (models.ProxySettings, error)
	PatchSettings(ctx context.Context, patch models.ProxySettings) (models.ProxySettings, error)

	GetHealth(ctx context.Context, proxyID string) (models.ProxyHealth, error)
	UpsertHealth(ctx context.Context, health models.ProxyHealth) error
	RecordHealthFailure(ctx context.Context, proxyID, kind, message string, occurredAt time.Time, collapseWindow time.Duration, threshold int, baseBackoff, maxBackoff time.Duration) (models.ProxyHealth, error)
	RecordHealthSuccess(ctx context.Context, proxyID string, occurredAt time.Time) error
	ClaimHealthProbe(ctx context.Context, proxyID string, now, leaseUntil time.Time) (bool, error)

	ListCustomProviders(ctx context.Context) ([]models.CustomProvider, error)
	GetCustomProvider(ctx context.Context, id string) (models.CustomProvider, error)
	GetCustomProviderBySlug(ctx context.Context, slug string) (models.CustomProvider, error)
	UpsertCustomProvider(ctx context.Context, provider models.CustomProvider) (models.CustomProvider, error)
	DeleteCustomProvider(ctx context.Context, id string) (bool, error)

	ListWarpAccounts(ctx context.Context) ([]models.WarpAccount, error)
	GetWarpAccount(ctx context.Context, id string) (models.WarpAccount, error)
	UpsertWarpAccount(ctx context.Context, account models.WarpAccount) (models.WarpAccount, error)
	DeleteWarpAccount(ctx context.Context, id string) (bool, error)
	RecordWarpMetric(ctx context.Context, metric models.WarpMetric) error
}
