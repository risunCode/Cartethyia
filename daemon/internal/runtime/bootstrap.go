package runtime

import (
	"context"
	"errors"
	"fmt"
	"github.com/cartethyia/daemon/internal/accounts"
	accountdrivers "github.com/cartethyia/daemon/internal/accounts/drivers"
	"github.com/cartethyia/daemon/internal/accounts/flow"
	db "github.com/cartethyia/daemon/internal/database"
	dbmodels "github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/providers"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/proxy/control/admission"
	"github.com/cartethyia/daemon/internal/proxy/control/continuation"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
	"github.com/cartethyia/daemon/internal/proxy/runtime"
	runtimecatalog "github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
	"github.com/cartethyia/daemon/internal/proxy/transport"
	"github.com/cartethyia/daemon/internal/runtime/cache"
	"github.com/cartethyia/daemon/internal/security/outbound"
	"github.com/cartethyia/daemon/internal/server"
	adminserver "github.com/cartethyia/daemon/internal/server/admin"
	api "github.com/cartethyia/daemon/internal/server/api"
	apicontracts "github.com/cartethyia/daemon/internal/server/apicontracts"
	servermiddleware "github.com/cartethyia/daemon/internal/server/middleware"
	"net/http"
	"os"
	"strings"
	"time"
)

type registrarFunc func(*http.ServeMux)

type shareInFlightSource struct{ limiter *admission.Limiter }

func (s shareInFlightSource) InFlight() int {
	if s.limiter == nil {
		return 0
	}
	active := s.limiter.Stats().Active
	if active < 0 {
		return 0
	}
	return int(active)
}

// adminInFlightStats adapts the admission limiter snapshot to the admin
// InFlightStatsSource contract without widening the admission package API.
type adminInFlightStats struct{ limiter *admission.Limiter }

func (s adminInFlightStats) InFlight() int {
	if s.limiter == nil {
		return 0
	}
	active := s.limiter.Stats().Active
	if active < 0 {
		return 0
	}
	return int(active)
}

func (s adminInFlightStats) Waiters() int {
	if s.limiter == nil {
		return 0
	}
	waiters := s.limiter.Stats().Waiters
	if waiters < 0 {
		return 0
	}
	return waiters
}

func (s adminInFlightStats) Grants() uint64 {
	if s.limiter == nil {
		return 0
	}
	return s.limiter.Stats().Grants
}

// adminInFlightDetail projects the bounded dispatch registry into the admin
// per-request stream rows. Provider and client IP stay empty until the hot
// path records them; the dashboard renders them as placeholders.
type adminInFlightDetail struct{ registry *proxy.InFlightRegistry }

func (s adminInFlightDetail) InFlightRows() []adminserver.InFlightRow {
	if s.registry == nil {
		return nil
	}
	records := s.registry.Snapshot()
	if len(records) == 0 {
		return nil
	}
	now := time.Now()
	rows := make([]adminserver.InFlightRow, 0, len(records))
	for _, record := range records {
		age := int64(0)
		if !record.StartedAt.IsZero() && now.After(record.StartedAt) {
			age = now.Sub(record.StartedAt).Milliseconds()
		}
		startedAt := record.StartedAt
		if startedAt.IsZero() {
			startedAt = now
		}
		rows = append(rows, adminserver.InFlightRow{
			ID:        record.ID,
			Model:     record.Model,
			Surface:   record.Surface,
			StartedAt: startedAt.UTC().Format(time.RFC3339Nano),
			AgeMS:     age,
		})
	}
	return rows
}

type publicAPIKeyResolver struct {
	store *dbrepositories.BunPublicAPIKeyResolver
}

func (r publicAPIKeyResolver) ResolveAPIKey(ctx context.Context, key string) (servermiddleware.PublicAPIKey, error) {
	value, err := r.store.ResolveAPIKey(ctx, key)
	if err != nil {
		return servermiddleware.PublicAPIKey{}, err
	}
	return servermiddleware.PublicAPIKey{
		ID: value.ID, Active: value.Active, RevokedAt: value.RevokedAt,
		RateLimitRpm: value.RateLimitRpm, MaxConcurrent: value.MaxConcurrentRequests,
		DailyTokenLimit: value.DailyTokenLimit, MonthlyTokenLimit: value.MonthlyTokenLimit,
		OneTimeTokenLimit: value.OneTimeTokenLimit, OneTimeTokensUsed: value.OneTimeTokensUsed,
		ProviderAllowlist: value.ProviderAllowlist, ModelAllowlist: value.ModelAllowlist, ModelDenylist: value.ModelDenylist,
	}, nil
}

func (r publicAPIKeyResolver) TouchAPIKey(ctx context.Context, id string) error {
	return r.store.TouchAPIKey(ctx, id)
}

func (f registrarFunc) Register(mux *http.ServeMux) {
	if mux == nil {
		return
	}
	f(mux)
}

// accountRefresherAdapter bridges the account lifecycle refresher to the
// proxy retry seam. Refresh always forces a single-flight refresh and closes
// the caller-owned token set; the account refresher remains the authority for
// leases, encrypted secret persistence, and CAS reconciliation.
type accountRefresherAdapter struct {
	refresher  accounts.Refresher
	invalidate func(accountID string)
}

func (a accountRefresherAdapter) Refresh(ctx context.Context, accountID string) error {
	if a.refresher == nil {
		return errors.New("runtime: OAuth refresher is unavailable")
	}
	token, err := a.refresher.ForceRefresh(ctx, accountID)
	if token != nil {
		token.Close()
	}
	if a.invalidate != nil {
		a.invalidate(accountID)
	}
	return err
}

func composeAccountRefresher(deps BootstrapDependencies) (accounts.Refresher, error) {
	if deps.Refresher != nil {
		return deps.Refresher, nil
	}
	// Development fixtures intentionally fail closed when durable account
	// boundaries or the provider driver registry are absent. No process-local
	// token store is synthesized for the request path.
	if deps.DriverRegistry == nil || deps.Accounts == nil || deps.Secrets == nil || deps.Records == nil {
		return nil, nil
	}
	refresher, err := accounts.NewInMemoryRefresher(accounts.RefresherOptions{
		DriverResolver: func(providerID string) (accounts.AuthDriver, bool) {
			return deps.DriverRegistry.Get(providerID)
		},
		Secrets:  deps.Secrets,
		Records:  deps.Records,
		Accounts: deps.Accounts,
		Lease:    deps.RefreshLeases,
	})
	if err != nil {
		return nil, fmt.Errorf("runtime: OAuth refresher: %w", err)
	}
	return refresher, nil
}

// BootstrapDependencies are mandatory runtime seams. Provider endpoints and
// credential references come from providers/; secret values come from the
// injected credential resolver, never from process environment variables.
type BootstrapDependencies struct {
	Registry      *providers.Registry
	Credentials   transport.CredentialResolver
	Accounts      accounts.AccountConfigStore
	Records       accounts.RecordStore
	Secrets       accounts.SecretStore
	Refresher     accounts.Refresher
	RefreshLeases accounts.RefreshLeaseStore
	AccountState  proxy.AccountStatePersistence
	// ObserveAccountPool is an optional diagnostic/test observer invoked once
	// after the private runtime pool is constructed. It must not mutate the pool.
	ObserveAccountPool func(*proxy.AccountPool)
	ProxySelector      transport.ProxySelector
	ProxyFailure       transport.ProxyFailureRecorder
	ProxySuccess       transport.ProxySuccessRecorder
	// Database is the mandatory PostgreSQL authority when configured by the
	// runtime. It is retained as a lifecycle dependency so readiness and close
	// semantics cover the same pool used by durable repositories.
	Database *db.RuntimeStore
	// Cache is optional and cache-only. PostgreSQL remains the authority for
	// accounts, credentials, leases, and telemetry.
	Cache cache.Cache
	// ResponseCache is an explicit opt-in complete-response cache. It is kept
	// separate from resolution cache policy so callers cannot enable replay by
	// merely configuring Redis.
	ResponseCache *cache.ResponseCache
	// MetadataWriter is the bounded, payload-free request-history enqueue path.
	MetadataWriter *observability.AsyncMetadataWriter
	// Observability is the single metrics and bounded lifecycle evidence registry.
	Observability *observability.Registry
	// DriverRegistry is the OAuth lifecycle registry. It is distinct from the
	// wire provider registry because OAuth drivers own token endpoints.
	DriverRegistry   *accountdrivers.Registry
	BaseURLOverrides map[string]string
	CustomProviders  dbrepositories.CustomProviderRepository
	Catalog          RuntimeCatalogRepository
	// Admin optionally supplies the composed V2 dashboard registrar. Keeping
	// this seam optional preserves truthful route omission when persistence or
	// authentication services are not configured.
	Admin server.AdminRegistrar
	// PublicAPIKeys is the injectable public V1 credential authority. It must
	// be durable in production; nil is only an anonymous development seam.
	PublicAPIKeys servermiddleware.PublicAPIKeyResolver
	// TokenBudget is the durable hard-limit authority. Production must never
	// replace it with a process-local counter.
	TokenBudget tokenbudget.TokenBudgetAuthority
}

func defaultBootstrapDependencies(configs ...Config) (BootstrapDependencies, error) {
	cfg := Config{}.WithDefaults()
	if len(configs) > 0 {
		cfg = configs[0].WithDefaults()
	}
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		return BootstrapDependencies{}, fmt.Errorf("runtime: default providers: %w", err)
	}
	driverRegistry, err := accountdrivers.NewRegistry(nil)
	if err != nil {
		return BootstrapDependencies{}, fmt.Errorf("runtime: default OAuth drivers: %w", err)
	}
	deps := BootstrapDependencies{
		Registry:       registry,
		DriverRegistry: driverRegistry,
		Credentials:    rejectCredential,
		Observability:  observability.NewRegistry().WithLogger(observability.NewLogger(nil, observability.LevelInfo)),
	}
	fallback := cache.NewMemory(cache.MemoryConfig{MaxEntries: 1024, MaxInFlight: cache.DefaultMaxInFlight, MaxBytes: 16 * 1024 * 1024})
	deps.Cache = fallback
	if strings.EqualFold(cfg.Environment, "production") || strings.TrimSpace(cfg.DatabaseURL) != "" {
		if strings.TrimSpace(cfg.DatabaseURL) == "" {
			return BootstrapDependencies{}, errors.New("runtime: PostgreSQL DatabaseURL is required in production")
		}
		if strings.TrimSpace(cfg.AccountEncryptionKey) == "" {
			return BootstrapDependencies{}, errors.New("runtime: account encryption key is required with PostgreSQL")
		}
		openCtx, cancel := context.WithTimeout(context.Background(), cfg.ConnectTimeout)
		database, dbErr := db.OpenRuntime(openCtx, cfg.DatabaseURL, []byte(cfg.AccountEncryptionKey))
		cancel()
		if dbErr != nil {
			return BootstrapDependencies{}, fmt.Errorf("runtime: PostgreSQL bootstrap: %w", dbErr)
		}
		deps.Database = database
		deps.CustomProviders = database.CustomProviders
		deps.Catalog = database.Catalog
		deps.PublicAPIKeys = publicAPIKeyResolver{store: database.APIKeys}
		deps.TokenBudget = database.TokenBudget
		// Lease coordination is safe to compose independently of account
		// metadata/secret stores; production still fails closed below until the
		// complete account authority is available.
		deps.RefreshLeases = database.RefreshLeases
		deps.Accounts = database.Accounts
		deps.Records = database.Records
		deps.Secrets = database.Secrets
		deps.AccountState = durableAccountStateStore{store: database.AccountCore}
		proxyCoordinator := newDurableProxyCoordinator(database.Proxies, deps.Observability)
		if proxyCoordinator != nil {
			deps.ProxySelector = proxyCoordinator.selectProxy
			deps.ProxyFailure = proxyCoordinator.recordFailure
			deps.ProxySuccess = proxyCoordinator.recordSuccess
		}
		refresher, refreshErr := composeAccountRefresher(deps)
		if refreshErr != nil {
			_ = database.Close(context.Background())
			_ = fallback.Close()
			return BootstrapDependencies{}, refreshErr
		}
		deps.Refresher = refresher
		// Let composeCredentialResolver use the durable encrypted stores. The
		// rejecting fallback is only valid for development without PostgreSQL.
		deps.Credentials = nil
		deps.MetadataWriter = observability.NewAsyncMetadataWriter(
			context.Background(),
			dbrepositories.NewBunMetadataSink(database.Telemetry),
			1024,
		)
	}
	if strings.TrimSpace(cfg.RedisURL) != "" {
		client, clientErr := cache.NewRedisClient(cfg.RedisURL, cfg.ConnectTimeout)
		if clientErr != nil {
			if deps.MetadataWriter != nil {
				_ = deps.MetadataWriter.Close(context.Background())
			}
			if deps.Database != nil {
				_ = deps.Database.Close(context.Background())
			}
			_ = fallback.Close()
			return BootstrapDependencies{}, fmt.Errorf("runtime: RedisURL: %w", clientErr)
		}
		remote, remoteErr := cache.NewRedisBackend(client, cache.RedisConfig{CommandTimeout: cfg.ConnectTimeout})
		if remoteErr != nil {
			_ = client.Close()
			if deps.MetadataWriter != nil {
				_ = deps.MetadataWriter.Close(context.Background())
			}
			if deps.Database != nil {
				_ = deps.Database.Close(context.Background())
			}
			_ = fallback.Close()
			return BootstrapDependencies{}, fmt.Errorf("runtime: Redis cache: %w", remoteErr)
		}
		composed, routerErr := cache.NewRouter(remote, fallback)
		if routerErr != nil {
			_ = remote.Close()
			if deps.MetadataWriter != nil {
				_ = deps.MetadataWriter.Close(context.Background())
			}
			if deps.Database != nil {
				_ = deps.Database.Close(context.Background())
			}
			_ = fallback.Close()
			return BootstrapDependencies{}, fmt.Errorf("runtime: Redis cache router: %w", routerErr)
		}
		deps.Cache = composed
	}
	return deps, nil
}

// providerFixtureAccountStore is retained only for non-production bootstrap
// fixtures. It deliberately must not be used as a production account source.
type providerFixtureAccountStore struct {
	registry *providers.Registry
}

func (s providerFixtureAccountStore) ListAccounts(_ context.Context, providerID string) ([]proxy.Account, error) {
	if s.registry == nil {
		return nil, errors.New("runtime: provider fixture account store has no registry")
	}
	provider, err := s.registry.Get(providerID)
	if err != nil {
		return nil, fmt.Errorf("runtime: load provider fixture %q: %w", providerID, err)
	}
	if provider == nil {
		return nil, fmt.Errorf("runtime: provider fixture %q resolved to nil", providerID)
	}
	meta := provider.Metadata()
	if meta.ID == "" || meta.CredentialRef == "" {
		return nil, fmt.Errorf("runtime: provider fixture %q has incomplete credential ownership", providerID)
	}
	ref, err := contracts.NewCredentialRef(meta.CredentialRef)
	if err != nil {
		return nil, fmt.Errorf("runtime: provider fixture %q credential reference: %w", providerID, err)
	}
	return []proxy.Account{{
		ID:            meta.ID,
		Provider:      meta.ID,
		CredentialRef: ref,
		Enabled:       true,
	}}, nil
}

// durableAccountStore adapts the account package's persisted, provider-neutral
type durableAccountStore struct {
	store   accounts.AccountConfigStore
	records accounts.RecordStore
}

type durableAccountStateStore struct {
	store interface {
		GetHealth(context.Context, string) (dbmodels.AccountHealth, error)
		UpsertHealth(context.Context, dbmodels.AccountHealth) error
		GetModelLock(context.Context, string, string) (dbmodels.AccountModelLock, error)
		UpsertModelLock(context.Context, dbmodels.AccountModelLock) error
		ClearModelLock(context.Context, string, string) error
		ClearModelLocks(context.Context, string) error
	}
}

func (s durableAccountStateStore) LoadAccount(ctx context.Context, accountID string) (proxy.AccountHealthState, error) {
	health, err := s.store.GetHealth(ctx, accountID)
	if err != nil {
		return proxy.AccountHealthState{}, err
	}
	state := proxy.AccountHealthState{CooldownUntil: time.Time{}, FailureCount: health.FailureCount}
	if health.RetryAt != nil {
		state.CooldownUntil = *health.RetryAt
	}
	if health.Status == "exhausted" {
		state.State = proxy.StateExhausted
	} else if health.Status == "disabled" {
		state.State = proxy.StateDisabled
	} else if health.Status == "cooling_down" {
		state.State = proxy.StateCoolingDown
	} else if health.Status == "error" {
		state.State = proxy.StateError
	} else {
		state.State = proxy.StateHealthy
	}
	if health.OccurredAt != nil {
		state.LastFailure = *health.OccurredAt
	}
	return state, nil
}

func (s durableAccountStateStore) SaveAccount(ctx context.Context, accountID string, state proxy.AccountHealthState) error {
	status := string(state.State)
	if status == "" {
		status = string(proxy.StateHealthy)
	}
	var retry, occurred *time.Time
	if !state.CooldownUntil.IsZero() {
		retry = &state.CooldownUntil
	}
	if !state.LastFailure.IsZero() {
		occurred = &state.LastFailure
	}
	return s.store.UpsertHealth(ctx, dbmodels.AccountHealth{AccountID: accountID, Status: status, RetryAt: retry, OccurredAt: occurred, FailureCount: state.FailureCount})
}

func (s durableAccountStateStore) LoadModelLock(ctx context.Context, accountID, modelID string) (proxy.ModelLockState, error) {
	lock, err := s.store.GetModelLock(ctx, accountID, modelID)
	if err != nil {
		return proxy.ModelLockState{}, err
	}
	return proxy.ModelLockState{RetryAt: lock.RetryAt, FailureCount: lock.FailureCount}, nil
}

func (s durableAccountStateStore) SaveModelLock(ctx context.Context, accountID, modelID string, state proxy.ModelLockState) error {
	return s.store.UpsertModelLock(ctx, dbmodels.AccountModelLock{AccountID: accountID, ModelID: modelID, RetryAt: state.RetryAt, FailureCount: state.FailureCount})
}

func (s durableAccountStateStore) ClearModelLock(ctx context.Context, accountID, modelID string) error {
	return s.store.ClearModelLock(ctx, accountID, modelID)
}

func (s durableAccountStateStore) ClearModelLocks(ctx context.Context, accountID string) error {
	return s.store.ClearModelLocks(ctx, accountID)
}

func (s durableAccountStore) ListAccounts(ctx context.Context, providerID string) ([]proxy.Account, error) {
	if s.store == nil {
		return nil, errors.New("runtime: account configuration store is unavailable")
	}
	if directory, ok := s.store.(accounts.AccountDirectoryStore); ok {
		entries, err := directory.ListAccountDirectory(ctx, providerID)
		if err != nil {
			return nil, fmt.Errorf("runtime: list account directory: %w", err)
		}
		out := make([]proxy.Account, 0, len(entries))
		for _, entry := range entries {
			if entry.Config == nil || entry.Config.ProviderID != providerID || !entry.Config.Enabled {
				continue
			}
			account, projectErr := projectDurableAccount(entry.Config, entry.Record)
			if projectErr != nil {
				return nil, projectErr
			}
			if account != nil {
				out = append(out, *account)
			}
		}
		return out, nil
	}
	configs, err := s.store.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("runtime: list account configurations: %w", err)
	}
	out := make([]proxy.Account, 0, len(configs))
	for _, cfg := range configs {
		if cfg == nil || cfg.ProviderID != providerID || !cfg.Enabled {
			continue
		}
		var record *accounts.OAuthTokenRecord
		if s.records != nil {
			if loaded, recordErr := s.records.Get(ctx, cfg.ID); recordErr == nil && loaded != nil {
				record = loaded
			}
		}
		account, projectErr := projectDurableAccount(cfg, record)
		if projectErr != nil {
			return nil, projectErr
		}
		if account != nil {
			out = append(out, *account)
		}
	}
	return out, nil
}

func projectDurableAccount(cfg *accounts.AccountConfig, record *accounts.OAuthTokenRecord) (*proxy.Account, error) {
	if cfg == nil || !cfg.Enabled {
		return nil, nil
	}
	ref := cfg.CredentialRef
	if ref.IsZero() {
		var err error
		ref, err = accounts.NewReference(cfg.ID)
		if err != nil {
			return nil, fmt.Errorf("runtime: account %q credential reference: %w", cfg.ID, err)
		}
	}
	credentialRef, err := contracts.NewCredentialRef(ref.String())
	if err != nil {
		return nil, fmt.Errorf("runtime: account %q credential reference: %w", cfg.ID, err)
	}
	account := &proxy.Account{ID: cfg.ID, Provider: cfg.ProviderID, CredentialRef: credentialRef, Enabled: cfg.Enabled}
	if record != nil {
		account.Email = record.Email
		account.ProviderAccountID = record.ProviderAccountID
		account.OrgID = record.OrgID
		account.OrgName = record.OrgName
		account.ReauthRequired = record.ReauthenticationRequired
	}
	return account, nil
}

type registryCatalog struct {
	registry *providers.Registry
}

type RuntimeCatalogRepository interface {
	ListAliases(context.Context) ([]dbmodels.ModelAlias, error)
	ListCombos(context.Context) ([]dbmodels.Combo, error)
}

type repositoryCatalogSource struct {
	repository RuntimeCatalogRepository
	generation uint64
}

func (s *repositoryCatalogSource) Load(ctx context.Context) ([]runtimecatalog.Alias, []runtimecatalog.Combination, uint64, error) {
	aliases, err := s.repository.ListAliases(ctx)
	if err != nil {
		return nil, nil, 0, err
	}
	combinations, err := s.repository.ListCombos(ctx)
	if err != nil {
		return nil, nil, 0, err
	}
	aliasValues := make([]runtimecatalog.Alias, len(aliases))
	for i, alias := range aliases {
		aliasValues[i] = runtimecatalog.Alias{Alias: alias.Alias, Target: alias.Model}
	}
	combinationValues := make([]runtimecatalog.Combination, len(combinations))
	for i, combination := range combinations {
		combinationValues[i] = runtimecatalog.Combination{ID: combination.ID, Members: append([]string(nil), combination.Models...), Strategy: combination.Strategy}
	}
	s.generation++
	return aliasValues, combinationValues, s.generation, nil
}

func (c registryCatalog) List() ([]contracts.Account, error) {
	if c.registry == nil {
		return nil, errors.New("runtime: provider catalog has no registry")
	}
	out := make([]contracts.Account, 0)
	for _, id := range c.registry.IDs() {
		provider, err := c.registry.Get(id)
		if err != nil {
			return nil, fmt.Errorf("runtime: load catalog provider %q: %w", id, err)
		}
		if provider == nil {
			return nil, fmt.Errorf("runtime: catalog provider %q resolved to nil", id)
		}
		meta := provider.Metadata()
		var ref contracts.CredentialRef
		if meta.CredentialRef != "" {
			var err error
			ref, err = contracts.NewCredentialRef(meta.CredentialRef)
			if err != nil {
				return nil, fmt.Errorf("runtime: catalog provider %q credential reference: %w", id, err)
			}
		}
		models := provider.Models()
		if models == nil {
			return nil, fmt.Errorf("runtime: catalog provider %q has no model catalog", id)
		}
		for _, model := range models.List() {
			out = append(out, contracts.Account{
				ID:            id + ":" + model.ID,
				Provider:      id,
				Model:         model.ID,
				CredentialRef: ref,
				Enabled:       true,
			})
		}
	}
	return out, nil
}

func buildHandler(cfg Config) (http.Handler, error) {
	return buildHandlerWithArtwork(cfg, "")
}

func buildHandlerWithArtwork(cfg Config, artwork string) (http.Handler, error) {
	deps, err := defaultBootstrapDependencies(cfg)
	if err != nil {
		return nil, err
	}
	return buildHandlerWithArtworkAndDependencies(cfg, deps, artwork)
}

func buildHandlerWith(cfg Config, deps BootstrapDependencies) (http.Handler, error) {
	return buildHandlerWithArtworkAndDependencies(cfg, deps, "")
}
func buildHandlerWithArtworkAndDependencies(cfg Config, deps BootstrapDependencies, artwork string) (http.Handler, error) {
	if deps.Registry == nil {
		return nil, errors.New("runtime: bootstrap registry is required")
	}
	metrics := deps.Observability
	if metrics == nil {
		metrics = observability.NewRegistry()
	}
	metrics.WithMetadataWriter(deps.MetadataWriter)
	var console *consoleEventSink
	if deps.Database != nil && deps.Database.Telemetry != nil {
		// The console evidence sink rides the existing event pipeline: terminal
		// lifecycle events become bounded operator evidence in the live ring
		// and in console_logs. An externally provided Recorder keeps its own
		// sink contract and the live tail is simply not attached.
		console = newConsoleEventSink(context.Background(), deps.Database.Telemetry)
	}
	if metrics.Recorder() == nil {
		sink := observability.EventSink(observability.LogSink{Logger: metrics.Logger()})
		if console != nil {
			sink = fanOutEventSink{sinks: []observability.EventSink{observability.LogSink{Logger: metrics.Logger()}, console}}
		}
		metrics.WithRecorder(observability.NewRecorder(context.Background(), sink, observability.WithCapacity(observability.MaxConcurrentEvents)))
	}
	var customAccountSource map[string][]proxy.Account
	if deps.CustomProviders != nil {
		customProviders, customErr := deps.CustomProviders.ListCustomProviders(context.Background())
		if customErr != nil {
			return nil, fmt.Errorf("runtime: list custom providers: %w", customErr)
		}
		customAccountSource, customErr = buildCustomProviderAccounts(customProviders)
		if customErr != nil {
			return nil, fmt.Errorf("runtime: custom provider accounts: %w", customErr)
		}
		for _, custom := range customProviders {
			if err := providerbuiltin.RegisterCustomProvider(deps.Registry, providerbuiltin.CustomProviderInput{
				ID: custom.ID, Slug: custom.Slug, Name: custom.Name, Type: custom.Type, Protocol: custom.Protocol, Surface: custom.Surface,
				BaseURL: custom.BaseURL, CredentialRef: custom.CredentialRef,
				CredentialRefs: custom.CredentialRefs,
				TimeoutSeconds: custom.TimeoutSeconds, ModelsJSON: custom.Models, HeadersJSON: custom.CustomHeaders,
			}); err != nil {
				return nil, fmt.Errorf("runtime: register custom provider %q: %w", custom.Slug, err)
			}
		}
	}
	if deps.Accounts == nil && (strings.EqualFold(cfg.Environment, "production") || deps.Database != nil) {
		return nil, errors.New("runtime: durable account configuration store is required; PostgreSQL account adapter is not composed")
	}
	refresher, err := composeAccountRefresher(deps)
	if err != nil {
		return nil, err
	}
	// Keep the composed refresher on the dependency projection so the
	// credential resolver and admin OAuth service use the same single-flight,
	// durable refresh path as router retries.
	deps.Refresher = refresher
	credentialResolver, invalidateCredential, err := composeCredentialResolverWithInvalidator(deps)
	if err != nil {
		return nil, err
	}
	baseURLs, err := providerBaseURLs(deps.Registry, deps.BaseURLOverrides)
	if err != nil {
		return nil, err
	}
	var accountStore proxy.AccountStore
	if deps.Accounts != nil {
		accountStore = compositeAccountStore{primary: durableAccountStore{store: deps.Accounts, records: deps.Records}, custom: customAccountSource, customRepository: deps.CustomProviders}
	} else {
		// Development/test composition may still provide a narrow explicit
		// provider fixture. Production is rejected above.
		accountStore = compositeAccountStore{primary: providerFixtureAccountStore{registry: deps.Registry}, custom: customAccountSource, customRepository: deps.CustomProviders}
	}
	pool, err := proxy.NewAccountPool(proxy.PoolConfig{Store: accountStore, TTL: proxy.DefaultAccountSnapshotTTL, StatePersistence: deps.AccountState})
	if err != nil {
		return nil, fmt.Errorf("runtime: account pool: %w", err)
	}
	if deps.ObserveAccountPool != nil {
		deps.ObserveAccountPool(pool)
	}
	var routerRefresher proxy.CredentialRefresher
	if refresher != nil {
		routerRefresher = accountRefresherAdapter{refresher: refresher, invalidate: invalidateCredential}
	}
	router, err := proxy.NewRouter(proxy.RouterConfig{Pool: pool, MaxAttempts: 3, Observer: metrics, Refresher: routerRefresher, DefaultOutputCap: int64(cfg.MaxOutputTokens)})
	if err != nil {
		return nil, fmt.Errorf("runtime: router: %w", err)
	}
	catalogBuilder, err := runtimecatalog.NewBuilder(deps.Registry)
	if err != nil {
		return nil, fmt.Errorf("runtime: catalog builder: %w", err)
	}
	var catalogSource runtimecatalog.Source = runtimecatalog.StaticSource{Gen: 1}
	if deps.Catalog != nil {
		catalogSource = &repositoryCatalogSource{repository: deps.Catalog}
	}
	catalogStore, err := runtimecatalog.NewStore(context.Background(), catalogBuilder, catalogSource, runtimecatalog.StoreConfig{})
	if err != nil {
		return nil, fmt.Errorf("runtime: catalog snapshot: %w", err)
	}
	outboundPolicy := &outbound.Policy{
		AllowLoopback:  !strings.EqualFold(cfg.Environment, "production"),
		AllowPrivate:   !strings.EqualFold(cfg.Environment, "production"),
		MaxRedirects:   3,
		RequestTimeout: cfg.RequestTimeout,
	}
	httpTransport := &transport.HTTPTransport{
		Registry:          deps.Registry,
		BaseURLs:          baseURLs,
		ResolveCredential: credentialResolver,
		ProxySelector:     deps.ProxySelector,
		ProxyFailure:      deps.ProxyFailure,
		ProxySuccess:      deps.ProxySuccess,
		OutboundPolicy:    outboundPolicy,
		MaxResponseBytes:  int64(cfg.MaxBodyBytes),
		ConnectTimeout:    cfg.ConnectTimeout,
		FirstByteTimeout:  cfg.FirstByteTimeout,
		TotalTimeout:      cfg.RequestTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}
	streamOutboundPolicy := *outboundPolicy
	streamOutboundPolicy.RequestTimeout = cfg.StreamTotalTimeout
	streamHTTPTransport := &transport.HTTPTransport{
		Registry:          deps.Registry,
		BaseURLs:          baseURLs,
		ResolveCredential: credentialResolver,
		ProxySelector:     deps.ProxySelector,
		ProxyFailure:      deps.ProxyFailure,
		ProxySuccess:      deps.ProxySuccess,
		OutboundPolicy:    &streamOutboundPolicy,
		MaxResponseBytes:  int64(cfg.MaxBodyBytes),
		ConnectTimeout:    cfg.ConnectTimeout,
		FirstByteTimeout:  cfg.FirstByteTimeout,
		TotalTimeout:      cfg.StreamTotalTimeout,
		IdleTimeout:       cfg.StreamIdleTimeout,
	}
	dispatch := &proxy.DispatchService{
		Router:          router,
		Transport:       httpTransport,
		StreamTransport: streamHTTPTransport,
		Continuations:   continuation.New(cfg.UsageRetention),
		Metadata:        deps.MetadataWriter,
		Evidence:        metrics,
		Catalog:         catalogStore,
		Codecs:          transforms.NewDefaultRegistry(),
		ResponseCache:   deps.ResponseCache,
	}
	limiter, err := admission.New(
		admission.Layer{Name: "global", Limit: cfg.MaxConcurrent},
		admission.Layer{Name: "stream", Limit: cfg.MaxConcurrentStream},
	)
	if err != nil {
		return nil, fmt.Errorf("runtime: admission setup: %w", err)
	}
	dispatch.Admission = limiter
	inFlightRegistry := proxy.NewInFlightRegistry(512)
	dispatch.InFlight = inFlightRegistry
	adminWiring := adminServiceWiring{console: console, catalog: catalogStore, limiter: limiter, environment: cfg.Environment, inFlight: inFlightRegistry}
	publicCatalog := registryCatalog{registry: deps.Registry}
	if deps.Admin == nil && deps.DriverRegistry != nil && deps.Accounts != nil && deps.Secrets != nil && deps.Records != nil {
		sessions := flow.NewManager(flow.ManagerOptions{})
		oauthService, oauthErr := adminserver.NewOAuthService(deps.DriverRegistry, sessions, deps.Accounts, deps.Secrets, deps.Records, refresher)
		if oauthErr != nil {
			return nil, fmt.Errorf("runtime: OAuth admin composition: %w", oauthErr)
		}
		deps.Admin = registrarFunc(func(mux *http.ServeMux) {
			services := postgresAdminServices(deps, adminWiring)
			services.OAuth = oauthService
			if deps.Database != nil && deps.Database.Settings != nil {
				services.Settings = newPostgresSettingsAdminService(deps.Database.Settings, cfg.Environment, cfg.ListenAddress)
				services.Auth = newSessionAuthService(deps.Database.Settings, oauthService, os.Getenv("CONSOLE_PASSWORD"))
			}
			if deps.CustomProviders != nil {
				services.CustomProviders = &customProviderAdminService{repository: deps.CustomProviders, registry: deps.Registry}
			}
			adminserver.Register(mux, services)
		})
	} else if deps.Admin == nil && deps.CustomProviders != nil {
		customService := &customProviderAdminService{repository: deps.CustomProviders, registry: deps.Registry}
		deps.Admin = registrarFunc(func(mux *http.ServeMux) {
			services := postgresAdminServices(deps, adminWiring)
			services.CustomProviders = customService
			if deps.Database != nil && deps.Database.Settings != nil {
				services.Settings = newPostgresSettingsAdminService(deps.Database.Settings, cfg.Environment, cfg.ListenAddress)
			}
			adminserver.Register(mux, services)
		})
	} else if deps.Admin == nil && deps.Database != nil && deps.Database.Settings != nil {
		settingsService := newPostgresSettingsAdminService(deps.Database.Settings, cfg.Environment, cfg.ListenAddress)
		deps.Admin = registrarFunc(func(mux *http.ServeMux) {
			services := postgresAdminServices(deps, adminWiring)
			services.Settings = settingsService
			adminserver.Register(mux, services)
		})
	}
	base, err := server.NewRouterWith(server.Options{
		Registry:      metrics,
		HealthArtwork: artwork,
		V1: registrarFunc(func(mux *http.ServeMux) {
			api.RegisterV1(mux, api.Deps{Proxy: dispatch, Catalog: publicCatalog, Evidence: metrics})
		}),
		V1Auth:  servermiddleware.PublicV1Auth(deps.PublicAPIKeys, deps.TokenBudget, strings.EqualFold(cfg.Environment, "production")),
		V2Admin: deps.Admin,
		Share: func() *server.ShareOptions {
			if deps.Database == nil || deps.Database.AdminAPIKeys == nil {
				return nil
			}
			return &server.ShareOptions{APIKeys: deps.Database.AdminAPIKeys, Usage: deps.Database.Telemetry, InFlight: shareInFlightSource{limiter: limiter}}
		}(),
	})
	if err != nil {
		return nil, fmt.Errorf("runtime: server router: %w", err)
	}
	return base, nil
}

// adminServiceWiring carries bootstrap composition locals that are not part
// of BootstrapDependencies but are required to build the production admin
// services: the live console evidence sink, the runtime catalog store, the
// admission limiter snapshot, the bounded in-flight registry, and the
// configured environment.
type adminServiceWiring struct {
	console     *consoleEventSink
	catalog     *runtimecatalog.Store
	limiter     *admission.Limiter
	inFlight    *proxy.InFlightRegistry
	environment string
}

func postgresAdminServices(deps BootstrapDependencies, wiring adminServiceWiring) adminserver.Services {
	services := adminserver.Services{}
	if deps.Database == nil {
		if deps.Registry != nil {
			services.Catalog = &registryCatalogAdminService{registry: deps.Registry, accounts: deps.Accounts, catalog: wiring.catalog}
		}
		if wiring.limiter != nil {
			services.InFlightStats = adminInFlightStats{limiter: wiring.limiter}
		}
		return services
	}
	if deps.Database.AdminAPIKeys != nil {
		services.APIKeys = &postgresAPIKeyAdminService{repository: deps.Database.AdminAPIKeys}
	}
	if deps.Database.Proxies != nil {
		services.Proxies = &postgresProxyAdminService{repository: deps.Database.Proxies}
	}
	if deps.Database.Accounts != nil {
		services.Dashboard = &postgresDashboardAdminService{accounts: deps.Database.Accounts, proxies: deps.Database.Proxies, keys: deps.Database.AdminAPIKeys, environment: wiring.environment, started: time.Now().UTC()}
		services.Accounts = &postgresAccountAdminService{accounts: deps.Accounts, records: deps.Records, secrets: deps.Secrets, refresher: deps.Refresher}
	}
	if deps.Database.Telemetry != nil {
		services.Telemetry = newPostgresTelemetryAdminService(deps.Database.Telemetry)
		services.Usage = newPostgresUsageAdminService(deps.Database.Telemetry)
		services.ConsoleLogs = newPostgresConsoleLogService(deps.Database.Telemetry, wiring.console)
	}
	if deps.Registry != nil {
		services.Catalog = &registryCatalogAdminService{registry: deps.Registry, accounts: deps.Accounts, catalog: wiring.catalog}
	}
	if wiring.limiter != nil {
		services.InFlightStats = adminInFlightStats{limiter: wiring.limiter}
	}
	if wiring.inFlight != nil {
		services.InFlightDetail = adminInFlightDetail{registry: wiring.inFlight}
	}
	return services
}

func providerBaseURLs(registry *providers.Registry, overrides map[string]string) (map[string]string, error) {
	if registry == nil {
		return nil, errors.New("runtime: provider URL registry is required")
	}
	urls := make(map[string]string)
	for _, id := range registry.IDs() {
		provider, err := registry.Get(id)
		if err != nil {
			return nil, fmt.Errorf("runtime: load provider URL %q: %w", id, err)
		}
		if provider == nil {
			return nil, fmt.Errorf("runtime: provider URL %q resolved to nil", id)
		}
		base := strings.TrimRight(provider.Metadata().BaseURL, "/")
		if override := strings.TrimRight(overrides[id], "/"); override != "" {
			base = override
		}
		if base == "" {
			return nil, fmt.Errorf("runtime: provider %q has no base URL", id)
		}
		urls[id] = base
	}
	return urls, nil
}

func composeCredentialResolver(deps BootstrapDependencies) (transport.CredentialResolver, error) {
	resolver, _, err := composeCredentialResolverWithInvalidator(deps)
	return resolver, err
}

func composeCredentialResolverWithInvalidator(deps BootstrapDependencies) (transport.CredentialResolver, func(string), error) {
	if deps.Credentials != nil {
		return deps.Credentials, nil, nil
	}
	if deps.Accounts == nil || deps.Secrets == nil {
		return nil, nil, errors.New("runtime: bootstrap credential resolver or account/secret stores are required")
	}
	resolver, err := accounts.NewStoreCredentialResolver(accounts.StoreResolverOptions{
		Accounts:  deps.Accounts,
		Secrets:   deps.Secrets,
		Records:   deps.Records,
		Refresher: deps.Refresher,
		AccessCache: accounts.CredentialCacheOptions{
			TTL:        30 * time.Second,
			MaxEntries: 1024,
		},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("runtime: credential resolver: %w", err)
	}
	resolve := func(ctx context.Context, ref string) (string, error) {
		accountRef, err := accounts.NewReference(ref)
		if err != nil {
			return "", err
		}
		resolved, err := resolver.Resolve(ctx, accountRef)
		if err != nil {
			return "", err
		}
		if resolved == nil || resolved.Access == nil || resolved.Access.IsZero() {
			if resolved != nil {
				resolved.Close()
			}
			return "", errors.New("runtime: credential material is unavailable")
		}
		value := resolved.Access.RevealString()
		resolved.Close()
		if value == "" {
			return "", errors.New("runtime: credential material is unavailable")
		}
		return value, nil
	}
	return resolve, resolver.InvalidateAccount, nil
}

func rejectCredential(_ context.Context, ref string) (string, error) {
	if ref == "" {
		return "", errors.New("runtime: empty provider credential reference")
	}
	return "", fmt.Errorf("runtime: provider credential %q has no configured secret store", ref)
}

var _ apicontracts.ModelCatalog = registryCatalog{}
