package runtime

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	db "github.com/cartethyia/daemon/internal/database"
	"github.com/cartethyia/daemon/internal/providers"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/proxy/runtime"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	runtimecatalog "github.com/cartethyia/daemon/internal/proxy/runtime/catalog"
	"github.com/cartethyia/daemon/internal/runtime/cache"
)

const maxDiagnosticExclusions = proxy.MaxCandidateExclusions

type DiagnosticCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type DoctorReport struct {
	Checks []DiagnosticCheck `json:"checks"`
}

type RouteCandidateDiagnostic struct {
	Position      int    `json:"position"`
	ProviderID    string `json:"provider_id"`
	ClientModelID string `json:"client_model_id"`
	UpstreamModel string `json:"upstream_model_id"`
	Surface       string `json:"surface"`
	AccountID     string `json:"account_id,omitempty"`
	State         string `json:"state"`
}

type RouteExclusionDiagnostic struct {
	Kind   string `json:"kind"`
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"`
}

type ProxyDiagnostic struct {
	ID     string `json:"id"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type RouteExplanation struct {
	RequestedModel string                     `json:"requested_model"`
	Surface        string                     `json:"surface"`
	Generation     uint64                     `json:"generation"`
	Strategy       string                     `json:"strategy"`
	Candidates     []RouteCandidateDiagnostic `json:"candidates"`
	Exclusions     []RouteExclusionDiagnostic `json:"exclusions"`
	Proxies        []ProxyDiagnostic          `json:"proxies"`
}

// ReadinessCandidateDiagnostic is a credential-free, immutable account view
// for operator tooling. ID is already redacted and no credential resolution or
// pool operation is performed while constructing it.
type ReadinessCandidateDiagnostic struct {
	ID         string    `json:"id"`
	Provider   string    `json:"provider"`
	Model      string    `json:"model"`
	Tier       string    `json:"tier"`
	Exclusions []string  `json:"exclusions,omitempty"`
	RetryAt    time.Time `json:"retry_at,omitempty"`
}

type ReadinessReport struct {
	Generation uint64                         `json:"generation"`
	Degraded   bool                           `json:"degraded"`
	Candidates []ReadinessCandidateDiagnostic `json:"candidates"`
}

type diagnosticSnapshot struct {
	registry       *providers.Registry
	database       *db.RuntimeStore
	catalog        *runtimecatalog.Snapshot
	customAccounts map[string][]proxy.Account
}

func Doctor(ctx context.Context, cfg Config) (DoctorReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg = cfg.WithDefaults()
	if err := cfg.Validate(); err != nil {
		return DoctorReport{}, fmt.Errorf("diagnostics: config: %w", err)
	}
	report := DoctorReport{Checks: []DiagnosticCheck{{Name: "config", Status: "ok"}}}
	snapshot, err := openDiagnosticSnapshot(ctx, cfg)
	if err != nil {
		return report, err
	}
	defer snapshot.close()

	if snapshot.database == nil {
		report.Checks = append(report.Checks,
			DiagnosticCheck{Name: "database", Status: "skipped", Detail: "not configured"},
			DiagnosticCheck{Name: "migrations", Status: "skipped", Detail: "not configured"},
		)
	} else {
		if err := snapshot.database.Probe(ctx); err != nil {
			return report, fmt.Errorf("diagnostics: database: %w", err)
		}
		report.Checks = append(report.Checks, DiagnosticCheck{Name: "database", Status: "ok"})
		status, err := snapshot.database.Migrator.Status(ctx)
		if err != nil {
			return report, fmt.Errorf("diagnostics: migrations: %w", err)
		}
		if len(status.Pending) != 0 {
			return report, fmt.Errorf("diagnostics: migrations: %d pending", len(status.Pending))
		}
		report.Checks = append(report.Checks, DiagnosticCheck{Name: "migrations", Status: "ok", Detail: fmt.Sprintf("version %d", status.CurrentVersion)})
	}

	report.Checks = append(report.Checks,
		DiagnosticCheck{Name: "provider_registry", Status: "ok", Detail: fmt.Sprintf("%d providers", len(snapshot.registry.IDs()))},
		DiagnosticCheck{Name: "catalog", Status: "ok", Detail: fmt.Sprintf("%d models", len(snapshot.catalog.ModelIDs()))},
	)
	accountCount, err := validateDiagnosticAccounts(ctx, snapshot)
	if err != nil {
		return report, err
	}
	report.Checks = append(report.Checks, DiagnosticCheck{Name: "account_references", Status: "ok", Detail: fmt.Sprintf("%d accounts", accountCount)})
	proxyCount, err := validateDiagnosticProxies(ctx, snapshot)
	if err != nil {
		return report, err
	}
	report.Checks = append(report.Checks, DiagnosticCheck{Name: "proxies", Status: "ok", Detail: fmt.Sprintf("%d proxies", proxyCount)})

	if strings.TrimSpace(cfg.RedisURL) == "" {
		report.Checks = append(report.Checks, DiagnosticCheck{Name: "runtime_dependencies", Status: "ok", Detail: "required dependencies reachable"})
		return report, nil
	}
	client, err := cache.NewRedisClient(cfg.RedisURL, cfg.ConnectTimeout)
	if err != nil {
		return report, fmt.Errorf("diagnostics: runtime dependencies: Redis configuration")
	}
	remote, err := cache.NewRedisBackend(client, cache.RedisConfig{CommandTimeout: cfg.ConnectTimeout})
	if err != nil {
		_ = client.Close()
		return report, fmt.Errorf("diagnostics: runtime dependencies: Redis construction")
	}
	defer remote.Close()
	if err := remote.Probe(ctx); err != nil {
		return report, fmt.Errorf("diagnostics: runtime dependencies: Redis unavailable")
	}
	report.Checks = append(report.Checks, DiagnosticCheck{Name: "runtime_dependencies", Status: "ok", Detail: "required and optional dependencies reachable"})
	return report, nil
}

func ExplainRoute(ctx context.Context, cfg Config, model string, surface contracts.Surface) (RouteExplanation, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg = cfg.WithDefaults()
	if err := cfg.Validate(); err != nil {
		return RouteExplanation{}, fmt.Errorf("diagnostics: config: %w", err)
	}
	if strings.TrimSpace(model) == "" || !surface.IsValid() {
		return RouteExplanation{}, errors.New("diagnostics: model and valid surface are required")
	}
	snapshot, err := openDiagnosticSnapshot(ctx, cfg)
	if err != nil {
		return RouteExplanation{}, err
	}
	defer snapshot.close()
	plan, err := snapshot.catalog.Plan(model, surface)
	if err != nil {
		return RouteExplanation{}, err
	}
	result := RouteExplanation{RequestedModel: plan.RequestedModel, Surface: string(surface), Generation: plan.Generation, Strategy: string(plan.Strategy)}
	position := 0
	for _, member := range plan.Members {
		accountsForProvider, listErr := diagnosticAccounts(ctx, snapshot, member.ProviderID)
		if listErr != nil {
			return RouteExplanation{}, listErr
		}
		if len(accountsForProvider) == 0 {
			appendExclusion(&result, "route_member", redactDiagnosticID("provider", member.ProviderID), "no_accounts")
			continue
		}
		for _, account := range accountsForProvider {
			state, reason := diagnosticAccountState(ctx, snapshot, account, member.UpstreamModelID)
			if reason != "" {
				appendExclusion(&result, "account", redactDiagnosticID("account", account.ID), reason)
				continue
			}
			position++
			result.Candidates = append(result.Candidates, RouteCandidateDiagnostic{
				Position: position, ProviderID: member.ProviderID, ClientModelID: member.ClientModelID,
				UpstreamModel: member.UpstreamModelID, Surface: string(member.Surface),
				AccountID: redactDiagnosticID("account", account.ID), State: state,
			})
		}
	}
	if err := addProxyDiagnostics(ctx, snapshot, plan, &result); err != nil {
		return RouteExplanation{}, err
	}
	return result, nil
}

// Readiness returns only the last durable account snapshot and passive state.
// It intentionally does not construct an AccountPool, resolve credentials,
// refresh accounts, acquire leases, or probe providers.
func Readiness(ctx context.Context, cfg Config, model string) (ReadinessReport, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg = cfg.WithDefaults()
	if err := cfg.Validate(); err != nil {
		return ReadinessReport{}, fmt.Errorf("diagnostics: config: %w", err)
	}
	snapshot, err := openDiagnosticSnapshot(ctx, cfg)
	if err != nil {
		return ReadinessReport{}, err
	}
	defer snapshot.close()
	result := ReadinessReport{Generation: snapshot.catalog.Generation}
	for _, providerID := range snapshot.catalog.Providers {
		accounts, listErr := diagnosticAccounts(ctx, snapshot, providerID)
		if listErr != nil {
			return ReadinessReport{}, listErr
		}
		for _, account := range accounts {
			if strings.TrimSpace(model) != "" && account.Model != "" && account.Model != model {
				continue
			}
			candidate := ReadinessCandidateDiagnostic{ID: redactDiagnosticID("account", account.ID), Provider: providerID, Model: account.Model, Tier: "unknown"}
			if !account.Enabled {
				candidate.Tier, candidate.Exclusions = "unavailable", []string{"disabled"}
			} else if account.ReauthRequired {
				candidate.Tier, candidate.Exclusions = "unavailable", []string{"reauth_required"}
			} else if _, reason := diagnosticAccountState(ctx, snapshot, account, model); reason != "" {
				candidate.Tier, candidate.Exclusions = "temporarily_unavailable", []string{reason}
				if snapshot.database != nil && snapshot.database.AccountCore != nil {
					if lock, lockErr := (durableAccountStateStore{store: snapshot.database.AccountCore}).LoadModelLock(ctx, account.ID, model); lockErr == nil {
						candidate.RetryAt = lock.RetryAt
					}
				}
			}
			result.Candidates = append(result.Candidates, candidate)
		}
	}
	sort.SliceStable(result.Candidates, func(i, j int) bool {
		if result.Candidates[i].Provider != result.Candidates[j].Provider {
			return result.Candidates[i].Provider < result.Candidates[j].Provider
		}
		return result.Candidates[i].ID < result.Candidates[j].ID
	})
	return result, nil
}

func openDiagnosticSnapshot(ctx context.Context, cfg Config) (*diagnosticSnapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		return nil, fmt.Errorf("diagnostics: provider registry: %w", err)
	}
	result := &diagnosticSnapshot{registry: registry}
	if strings.EqualFold(cfg.Environment, "production") || strings.TrimSpace(cfg.DatabaseURL) != "" {
		if strings.TrimSpace(cfg.DatabaseURL) == "" {
			return nil, errors.New("diagnostics: database is required in production")
		}
		if strings.TrimSpace(cfg.AccountEncryptionKey) == "" {
			return nil, errors.New("diagnostics: account encryption key is required with PostgreSQL")
		}
		result.database, err = db.OpenRuntimeReadOnly(ctx, cfg.DatabaseURL, []byte(cfg.AccountEncryptionKey))
		if err != nil {
			return nil, fmt.Errorf("diagnostics: database: %w", err)
		}
		status, statusErr := result.database.Migrator.Status(ctx)
		if statusErr != nil {
			result.close()
			return nil, fmt.Errorf("diagnostics: migrations: %w", statusErr)
		}
		if len(status.Pending) != 0 {
			result.close()
			return nil, fmt.Errorf("diagnostics: migrations: %d pending", len(status.Pending))
		}
	}
	var source runtimecatalog.Source = runtimecatalog.StaticSource{Gen: 1}
	if result.database != nil {
		custom, customErr := result.database.CustomProviders.ListCustomProviders(ctx)
		if customErr != nil {
			result.close()
			return nil, fmt.Errorf("diagnostics: custom providers: %w", customErr)
		}
		result.customAccounts, customErr = buildCustomProviderAccounts(custom)
		if customErr != nil {
			result.close()
			return nil, fmt.Errorf("diagnostics: custom provider accounts: %w", customErr)
		}
		for _, provider := range custom {
			if err := providerbuiltin.RegisterCustomProvider(registry, providerbuiltin.CustomProviderInput{
				ID: provider.ID, Slug: provider.Slug, Name: provider.Name, Type: provider.Type,
				Protocol: provider.Protocol, Surface: provider.Surface, BaseURL: provider.BaseURL,
				CredentialRef: provider.CredentialRef, CredentialRefs: provider.CredentialRefs,
				TimeoutSeconds: provider.TimeoutSeconds, ModelsJSON: provider.Models, HeadersJSON: provider.CustomHeaders,
			}); err != nil {
				result.close()
				return nil, fmt.Errorf("diagnostics: custom provider registry: %w", err)
			}
		}
		source = &repositoryCatalogSource{repository: result.database.Catalog}
	}
	builder, err := runtimecatalog.NewBuilder(registry)
	if err != nil {
		result.close()
		return nil, fmt.Errorf("diagnostics: catalog builder: %w", err)
	}
	result.catalog, err = builder.Build(ctx, source)
	if err != nil {
		result.close()
		return nil, fmt.Errorf("diagnostics: catalog: %w", err)
	}
	return result, nil
}

func (s *diagnosticSnapshot) close() {
	if s != nil && s.database != nil {
		_ = s.database.Close(context.Background())
	}
}

func validateDiagnosticAccounts(ctx context.Context, snapshot *diagnosticSnapshot) (int, error) {
	count := 0
	if snapshot.database != nil && snapshot.database.Accounts != nil {
		configured, err := snapshot.database.Accounts.List(ctx)
		if err != nil {
			return 0, fmt.Errorf("diagnostics: account references: unavailable")
		}
		for _, account := range configured {
			if err := account.Validate(); err != nil || account.CredentialRef.IsZero() {
				return 0, errors.New("diagnostics: account references: invalid account metadata")
			}
			if _, err := snapshot.registry.Get(account.ProviderID); err != nil {
				return 0, errors.New("diagnostics: account references: unknown provider")
			}
			count++
		}
	} else {
		fixture := providerFixtureAccountStore{registry: snapshot.registry}
		for _, providerID := range snapshot.registry.IDs() {
			configured, err := fixture.ListAccounts(ctx, providerID)
			if err != nil {
				return 0, errors.New("diagnostics: account references: invalid provider metadata")
			}
			count += len(configured)
		}
	}
	for _, configured := range snapshot.customAccounts {
		count += len(configured)
	}
	return count, nil
}

func validateDiagnosticProxies(ctx context.Context, snapshot *diagnosticSnapshot) (int, error) {
	if snapshot.database == nil || snapshot.database.Proxies == nil {
		return 0, nil
	}
	configured, err := snapshot.database.Proxies.List(ctx)
	if err != nil {
		return 0, errors.New("diagnostics: proxies: unavailable")
	}
	for _, candidate := range configured {
		protocol := string(candidate.Protocol)
		if protocol != "http" && protocol != "https" && protocol != "socks5" {
			return 0, errors.New("diagnostics: proxies: unsupported protocol")
		}
		if strings.TrimSpace(candidate.Host) == "" || strings.ContainsAny(candidate.Host, "@/\\?#\r\n\t ") || candidate.Port < 1 || candidate.Port > 65535 || candidate.MaxConcurrency < 1 {
			return 0, errors.New("diagnostics: proxies: invalid endpoint metadata")
		}
	}
	return len(configured), nil
}

func diagnosticAccounts(ctx context.Context, snapshot *diagnosticSnapshot, providerID string) ([]proxy.Account, error) {
	var result []proxy.Account
	if snapshot.database != nil && snapshot.database.Accounts != nil {
		store := durableAccountStore{store: snapshot.database.Accounts, records: snapshot.database.Records}
		configured, err := store.ListAccounts(ctx, providerID)
		if err != nil {
			return nil, fmt.Errorf("diagnostics: account snapshot: unavailable")
		}
		result = append(result, configured...)
	} else {
		configured, err := (providerFixtureAccountStore{registry: snapshot.registry}).ListAccounts(ctx, providerID)
		if err != nil {
			return nil, errors.New("diagnostics: account snapshot: unavailable")
		}
		result = append(result, configured...)
	}
	result = append(result, snapshot.customAccounts[providerID]...)
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

func diagnosticAccountState(ctx context.Context, snapshot *diagnosticSnapshot, account proxy.Account, modelID string) (string, string) {
	if !account.Enabled {
		return "", "disabled"
	}
	if account.CredentialRef.IsZero() {
		return "", "credential_reference_missing"
	}
	if snapshot.database == nil || snapshot.database.AccountCore == nil {
		return "healthy", ""
	}
	stateStore := durableAccountStateStore{store: snapshot.database.AccountCore}
	state, err := stateStore.LoadAccount(ctx, account.ID)
	if err == nil {
		now := diagnosticNow()
		if state.State == proxy.StateDisabled || state.State == proxy.StateExhausted || state.State == proxy.StateError {
			return "", string(state.State)
		}
		if state.CooldownUntil.After(now) {
			return "", "cooling_down"
		}
	}
	lock, err := stateStore.LoadModelLock(ctx, account.ID, modelID)
	if err == nil && lock.RetryAt.After(diagnosticNow()) {
		return "", "model_locked"
	}
	return "healthy", ""
}

var diagnosticNow = func() time.Time { return time.Now().UTC() }

func addProxyDiagnostics(ctx context.Context, snapshot *diagnosticSnapshot, plan runtimecatalog.RoutePlan, result *RouteExplanation) error {
	if snapshot.database == nil || snapshot.database.Proxies == nil {
		return nil
	}
	settings, err := snapshot.database.Proxies.GetSettings(ctx)
	if err != nil {
		return errors.New("diagnostics: proxy settings unavailable")
	}
	configured, err := snapshot.database.Proxies.List(ctx)
	if err != nil {
		return errors.New("diagnostics: proxy snapshot unavailable")
	}
	excludedProviders := make(map[string]struct{}, len(settings.ExcludedProviders))
	for _, providerID := range settings.ExcludedProviders {
		excludedProviders[providerID] = struct{}{}
	}
	providerExcluded := false
	for _, member := range plan.Members {
		if _, ok := excludedProviders[member.ProviderID]; ok {
			providerExcluded = true
			break
		}
	}
	for _, candidate := range configured {
		item := ProxyDiagnostic{ID: redactDiagnosticID("proxy", candidate.ID), State: "available"}
		switch {
		case !settings.Enabled:
			item.State, item.Reason = "excluded", "proxy_routing_disabled"
		case providerExcluded:
			item.State, item.Reason = "excluded", "provider_excluded"
		case !candidate.Active:
			item.State, item.Reason = "excluded", "disabled"
		default:
			health, healthErr := snapshot.database.Proxies.GetHealth(ctx, candidate.ID)
			if healthErr == nil && health.RetryAt != nil && health.RetryAt.After(diagnosticNow()) {
				item.State, item.Reason = "excluded", "quarantined"
			}
		}
		result.Proxies = append(result.Proxies, item)
		if item.Reason != "" {
			appendExclusion(result, "proxy", item.ID, item.Reason)
		}
	}
	return nil
}

func appendExclusion(result *RouteExplanation, kind, id, reason string) {
	if result == nil || len(result.Exclusions) >= maxDiagnosticExclusions {
		return
	}
	result.Exclusions = append(result.Exclusions, RouteExclusionDiagnostic{Kind: kind, ID: id, Reason: reason})
}

func redactDiagnosticID(kind, value string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + value))
	return fmt.Sprintf("%s_%x", kind, sum[:6])
}
