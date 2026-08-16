package admin

import (
	"context"
	"encoding/json"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Services aggregates the narrow dependencies each admin handler slice needs.
// It is constructed by the runtime wiring (not defined here) and passed into
// Register. Individual slices consume only the fields they need so the
// interface stays small and testable.
type Services struct {
	Dashboard DashboardService
	Accounts  AccountService
	Settings  SettingsService
	Auth      AuthService
	// OAuth optionally supplies the concrete provider-neutral OAuth lifecycle.
	// When nil, Auth is used for backwards-compatible OAuth routes.
	OAuth       OAuthLifecycleService
	Telemetry   TelemetryService
	ConsoleLogs ConsoleLogService
	Usage       UsageService
	Catalog     CatalogService
	// InFlightStats exposes bounded admission counters for the in-flight
	// stream. When nil the stream endpoint reports the service unavailable.
	InFlightStats InFlightStatsSource
	// InFlightDetail optionally exposes bounded per-request dispatch records
	// for the in-flight stream. Nil keeps the stream aggregate-only.
	InFlightDetail InFlightDetailSource
	// Authorizer is the injected scoped policy boundary. When nil, Register
	// adapts Auth.Current to session-scoped authorization.
	Authorizer AdminAuthorizer
	// Audit receives bounded mutation events after the handler completes.
	Audit AuditService
	// Generation publishes cache/catalog invalidation after a successful
	// service operation has crossed its commit boundary.
	Generation GenerationPublisher
}

// InFlightStatsSource is the bounded aggregate view over the admission
// limiter that backs the live in-flight stream.
type InFlightStatsSource interface {
	InFlight() int
	Waiters() int
	Grants() uint64
}

// InFlightRow is one live dispatch in the in-flight stream. Model/Surface
// come from the dispatch request; Provider and ClientIP stay empty until the
// hot path records them.
type InFlightRow struct {
	ID        string `json:"id"`
	Model     string `json:"model"`
	Provider  string `json:"provider"`
	ClientIP  string `json:"ip"`
	Surface   string `json:"surface,omitempty"`
	StartedAt string `json:"startedAt"`
	AgeMS     int64  `json:"ageMs"`
}

// InFlightDetailSource snapshots bounded per-request dispatch records.
type InFlightDetailSource interface {
	InFlightRows() []InFlightRow
}

// DashboardService surfaces the at-a-glance status of the daemon.
type DashboardService interface {
	Summary(ctx context.Context) (DashboardSummary, error)
}

// DashboardSummary is the payload returned by the dashboard endpoint.
type DashboardSummary struct {
	Version      string         `json:"version"`
	Environment  string         `json:"environment"`
	Uptime       string         `json:"uptime"`
	AccountCount int            `json:"accountCount"`
	ProxyCount   int            `json:"proxyCount"`
	APIKeyCount  int            `json:"apiKeyCount"`
	Health       map[string]any `json:"health,omitempty"`
}

// AccountService is the contract for account/credential management endpoints.
type AccountService interface {
	List(ctx context.Context, providerID string) ([]contracts.Account, error)
	BatchCreate(ctx context.Context, providerID string, items []AccountInput) ([]contracts.Account, error)
	Create(ctx context.Context, providerID string, input AccountInput) (contracts.Account, error)
	Update(ctx context.Context, providerID, accountID string, input AccountInput) (contracts.Account, error)
	Delete(ctx context.Context, providerID, accountID string) error
	BatchDelete(ctx context.Context, providerID string, accountIDs []string) (BatchResult, error)
	BatchUpdate(ctx context.Context, providerID string, items []AccountBatchPatch) (BatchResult, error)
	Credential(ctx context.Context, accountID string) (string, error)
	RefreshQuota(ctx context.Context, accountID string) (QuotaState, error)
	Quota(ctx context.Context, accountID string) (QuotaState, error)
	RevokeForProvider(ctx context.Context, providerID, accountID string) error
}

// AccountInput contains operator-safe account metadata. Secret material is
// written through an out-of-band credential resolver and never accepted by
// this JSON contract.
type AccountInput struct {
	Label             string         `json:"label,omitempty"`
	CredentialRef     string         `json:"credentialRef,omitempty"`
	Enabled           *bool          `json:"enabled,omitempty"`
	Model             string         `json:"model,omitempty"`
	Name              string         `json:"name,omitempty"`
	Email             string         `json:"email,omitempty"`
	ProviderAccountID string         `json:"providerAccountId,omitempty"`
	OrgID             string         `json:"orgId,omitempty"`
	OrgName           string         `json:"orgName,omitempty"`
	ProjectID         string         `json:"projectId,omitempty"`
	Metadata          map[string]any `json:"metadata,omitempty"`
}

// AccountBatchPatch is a partial update sent in a batch.
type AccountBatchPatch struct {
	AccountID string         `json:"accountId"`
	Enabled   *bool          `json:"enabled,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// BatchResult summarizes a batch operation's success and failure counts.
type BatchResult struct {
	Processed int      `json:"processed"`
	Succeeded int      `json:"succeeded"`
	Failed    int      `json:"failed"`
	Errors    []string `json:"errors,omitempty"`
}

// QuotaState describes a single account's quota snapshot.
type QuotaState struct {
	AccountID   string         `json:"accountId"`
	Used        int64          `json:"used"`
	Limit       int64          `json:"limit"`
	Remaining   int64          `json:"remaining"`
	ResetsAt    string         `json:"resetsAt,omitempty"`
	LastChecked string         `json:"lastChecked,omitempty"`
	Extras      map[string]any `json:"extras,omitempty"`
}

// OAuthState reports the state of a long-running OAuth handshake. It contains
// only bounded, operator-safe metadata; token material and provider responses
// are never part of this contract.
type OAuthState struct {
	SessionID       string `json:"sessionId,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	Status          string `json:"status"`
	Flow            string `json:"flow,omitempty"`
	URL             string `json:"url,omitempty"`
	State           string `json:"state,omitempty"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`
	IntervalSeconds int    `json:"intervalSeconds,omitempty"`
	ExpiresAt       string `json:"expiresAt,omitempty"`
}

// SettingsService is the contract for runtime configuration endpoints.
type SettingsService interface {
	Get(ctx context.Context) (RuntimeSettings, error)
	Patch(ctx context.Context, input RuntimeSettingsInput) (RuntimeSettings, error)
	Reset(ctx context.Context) (RuntimeSettings, error)
}

// RuntimeSettings is the top-level runtime configuration snapshot.
type RuntimeSettings struct {
	Environment string          `json:"environment"`
	LogLevel    string          `json:"logLevel"`
	ListenAddr  string          `json:"listenAddr"`
	Flags       map[string]bool `json:"flags,omitempty"`
	Metadata    map[string]any  `json:"metadata,omitempty"`
}

// RuntimeSettingsInput is the PATCH payload.
type RuntimeSettingsInput struct {
	LogLevel   *string         `json:"logLevel,omitempty"`
	ListenAddr *string         `json:"listenAddr,omitempty"`
	Flags      map[string]bool `json:"flags,omitempty"`
	Metadata   map[string]any  `json:"metadata,omitempty"`
}

// AuthService is the contract for login/session lifecycle endpoints.
type AuthService interface {
	Login(ctx context.Context, input LoginInput, request AuthRequest) (LoginResult, error)
	Logout(ctx context.Context, sessionID string) error
	Current(ctx context.Context, sessionID string) (Session, error)
	// Refresh validates the presented session token and re-issues a fresh
	// one. The returned LoginResult carries the rotated token through
	// SetCookie with the same cookie contract as Login; Session alone (with
	// an empty SetCookie) keeps the legacy no-rotation behavior.
	Refresh(ctx context.Context, sessionID string, request AuthRequest) (LoginResult, error)
	OAuthStart(ctx context.Context, providerID string, input OAuthStartInput) (OAuthState, error)
	OAuthComplete(ctx context.Context, sessionID string, input OAuthCompleteInput) (OAuthState, error)
	OAuthCancel(ctx context.Context, sessionID string) error
	OAuthRefresh(ctx context.Context, input OAuthRefreshInput) (OAuthState, error)
}

// OAuthLifecycleService is the narrow production seam for provider OAuth.
// It lets deployments compose OAuth without inventing a password/session
// service when those concerns are owned elsewhere.
type OAuthLifecycleService interface {
	OAuthStart(ctx context.Context, providerID string, input OAuthStartInput) (OAuthState, error)
	OAuthComplete(ctx context.Context, sessionID string, input OAuthCompleteInput) (OAuthState, error)
	OAuthCancel(ctx context.Context, sessionID string) error
	OAuthRefresh(ctx context.Context, input OAuthRefreshInput) (OAuthState, error)
}

// OAuthStatusService is an additive seam for device polling and browser
// status. Existing AuthService implementations remain source-compatible; when
// absent, the legacy OAuthComplete(session, empty input) status path is used.
type OAuthStatusService interface {
	OAuthStatus(ctx context.Context, sessionID string) (OAuthState, error)
}

// OAuthReauthService is an optional explicit reauthentication seam. Services
// that do not implement it still support the existing force-refresh contract.
type OAuthReauthService interface {
	OAuthReauthenticate(ctx context.Context, input OAuthRefreshInput) (OAuthState, error)
}

// LoginInput is the request body for password-based login.
type LoginInput struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
}

// LoginResult is the response of a successful login.
type LoginResult struct {
	Session   Session `json:"session"`
	SetCookie string  `json:"setCookie,omitempty"`
	MaxAge    int     `json:"maxAge,omitempty"`
}

// Session is a console session record.
type Session struct {
	ID        string   `json:"id"`
	User      string   `json:"user"`
	Scopes    []string `json:"scopes,omitempty"`
	CreatedAt string   `json:"createdAt,omitempty"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
	CSRFToken string   `json:"csrfToken,omitempty"`
}

// AuthRequest carries the transport context AuthService needs.
type AuthRequest struct {
	IP        string
	UserAgent string
	BaseURL   string
	Secure    bool
}

// OAuthStartInput is the body for /oauth/start.
type OAuthStartInput struct {
	Scopes          []string `json:"scopes,omitempty"`
	AccountID       string   `json:"accountId,omitempty"`
	Flow            string   `json:"flow,omitempty"`
	RedirectURI     string   `json:"redirectUri,omitempty"`
	Mode            string   `json:"mode,omitempty"`
	AWSMode         string   `json:"awsMode,omitempty"`
	SocialProvider  string   `json:"socialProvider,omitempty"`
	CredentialJSON  string   `json:"credentialJson,omitempty"`
	AWSRegion       string   `json:"awsRegion,omitempty"`
	AWSStartURL     string   `json:"awsStartUrl,omitempty"`
	AWSClientID     string   `json:"awsClientId,omitempty"`
	AWSClientSecret string   `json:"awsClientSecret,omitempty"`
	ProfileARN      string   `json:"profileArn,omitempty"`
}

type OAuthCompleteInput struct {
	Code  string `json:"code"`
	State string `json:"state,omitempty"`
}

type OAuthRefreshInput struct {
	AccountID string `json:"accountId"`
	Force     bool   `json:"force"`
}

// TelemetryService is the contract for observability endpoints.
type TelemetryService interface {
	Overview(ctx context.Context, input TelemetryQuery) (TelemetryOverview, error)
	Requests(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error)
	Errors(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error)
	Upstream(ctx context.Context, input TelemetryQuery) ([]TelemetryBucket, error)
}

// TelemetryQuery is the common bounded filter for telemetry endpoints.
type TelemetryQuery struct {
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Period  string `json:"period,omitempty"`
	Bucket  string `json:"bucket,omitempty"`
	Cursor  string `json:"cursor,omitempty"`
	Limit   int    `json:"limit,omitempty"`
	GroupBy string `json:"group_by,omitempty"`
	Surface string `json:"surface,omitempty"`
}

// TelemetryOverview is a high-level summary.
type TelemetryOverview struct {
	Requests int64            `json:"requests"`
	Errors   int64            `json:"errors"`
	P50      int              `json:"p50Ms"`
	P95      int              `json:"p95Ms"`
	P99      int              `json:"p99Ms"`
	ByRoute  map[string]int64 `json:"byRoute,omitempty"`
}

// TelemetryBucket is a single time-bucketed data point.
type TelemetryBucket struct {
	Timestamp string         `json:"timestamp"`
	Count     int64          `json:"count"`
	Errors    int64          `json:"errors,omitempty"`
	LatencyMS int            `json:"latencyMs,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// ConsoleLogService provides bounded, operator-safe lifecycle evidence.
// Implementations must redact prompts, credentials, headers, cookies, and
// full upstream/provider bodies before returning rows.
type ConsoleLogService interface {
	List(ctx context.Context, input ConsoleLogQuery) ([]ConsoleLogEntry, error)
}

// ConsoleLogQuery is the bounded filter for Console Log evidence.
type ConsoleLogQuery struct {
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	Level  string `json:"level,omitempty"`
	Scope  string `json:"scope,omitempty"`
	Origin string `json:"origin,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// ConsoleLogEntry is a structured lifecycle row. Message is a bounded,
// operator-safe summary and never a raw prompt or provider response.
type ConsoleLogEntry struct {
	ID             string         `json:"id"`
	Timestamp      string         `json:"timestamp"`
	Event          string         `json:"event"`
	Level          string         `json:"level"`
	Scope          string         `json:"scope,omitempty"`
	Message        string         `json:"message,omitempty"`
	RequestID      string         `json:"request_id,omitempty"`
	TraceID        string         `json:"trace_id,omitempty"`
	Origin         string         `json:"origin,omitempty"`
	ClientFamily   string         `json:"client_family,omitempty"`
	Method         string         `json:"method,omitempty"`
	Path           string         `json:"path,omitempty"`
	Provider       string         `json:"provider,omitempty"`
	Model          string         `json:"model,omitempty"`
	AccountID      string         `json:"account_id,omitempty"`
	AccountDisplay string         `json:"account_display,omitempty"`
	ProxyID        string         `json:"proxy_id,omitempty"`
	ProxyDisplay   string         `json:"proxy_display,omitempty"`
	ProxySource    string         `json:"proxy_source,omitempty"`
	Status         int            `json:"status,omitempty"`
	ErrorCode      string         `json:"error_code,omitempty"`
	LatencyMS      *int           `json:"latency_ms,omitempty"`
	InputTokens    *int           `json:"input_tokens,omitempty"`
	OutputTokens   *int           `json:"output_tokens,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

// UsageService provides persisted request usage aggregates.
type UsageService interface {
	Usage(ctx context.Context, input TelemetryQuery) (UsageSummary, error)
	Clients(ctx context.Context, input TelemetryQuery) (ClientDistribution, error)
}

// UsageSummary is an operator-safe aggregate over canonical request evidence.
type UsageSummary struct {
	Requests     int64            `json:"requests"`
	InputTokens  *int64           `json:"input_tokens,omitempty"`
	OutputTokens *int64           `json:"output_tokens,omitempty"`
	TotalTokens  *int64           `json:"total_tokens,omitempty"`
	ByProvider   map[string]int64 `json:"by_provider,omitempty"`
	ByModel      map[string]int64 `json:"by_model,omitempty"`
}

// ClientDistribution contains bounded family totals and an explicit
// denominator. Unknown is represented as a regular bounded family.
type ClientDistribution struct {
	Total   int64             `json:"total"`
	Unknown int64             `json:"unknown"`
	Items   []ClientUsageItem `json:"items"`
}

type ClientUsageItem struct {
	Client     string  `json:"client"`
	Count      int64   `json:"count"`
	Percentage float64 `json:"percentage"`
	Source     string  `json:"source,omitempty"`
	Confidence string  `json:"confidence,omitempty"`
}

// CatalogService backs the V2 operator catalog. It is separate from the
// external /v1/models ingress so dashboard code has no V1 dependency.
type CatalogService interface {
	Providers(ctx context.Context) ([]CatalogProvider, error)
}

// CatalogProvider is the redacted provider metadata exposed to operators.
// CredentialRef is deliberately absent: catalog reads expose only credential
// kind and configuration state, never credential material or references.
type CatalogProvider struct {
	ID              string         `json:"id"`
	DisplayName     string         `json:"display_name"`
	Protocol        string         `json:"protocol,omitempty"`
	Protocols       []string       `json:"protocols,omitempty"`
	CredentialKind  string         `json:"credential_kind"`
	CredentialKinds []string       `json:"credential_kinds,omitempty"`
	Enabled         bool           `json:"enabled"`
	Configured      bool           `json:"configured"`
	AccountCount    int            `json:"account_count"`
	ModelCount      int            `json:"model_count"`
	Generation      uint64         `json:"generation"`
	AuthScope       string         `json:"auth_scope,omitempty"`
	Models          []CatalogModel `json:"models,omitempty"`
}

// MarshalJSON keeps the established snake_case daemon contract while exposing
// the camelCase aliases consumed by the dashboard's closed parser. Both values
// are derived from the same redacted field; neither introduces a secret alias.
func (provider CatalogProvider) MarshalJSON() ([]byte, error) {
	type catalogProviderAlias CatalogProvider
	return json.Marshal(struct {
		catalogProviderAlias
		Name              string   `json:"name,omitempty"`
		CredentialKindV2  string   `json:"credentialKind,omitempty"`
		CredentialKindsV2 []string `json:"credentialKinds,omitempty"`
		EnabledV2         bool     `json:"enabled"`
		ConfiguredV2      bool     `json:"configured"`
		AccountCountV2    int      `json:"accountCount"`
		ModelCountV2      int      `json:"modelCount"`
		AuthScopeV2       string   `json:"authScope,omitempty"`
	}{catalogProviderAlias: catalogProviderAlias(provider), Name: provider.DisplayName, CredentialKindV2: provider.CredentialKind, CredentialKindsV2: provider.CredentialKinds, EnabledV2: provider.Enabled, ConfiguredV2: provider.Configured, AccountCountV2: provider.AccountCount, ModelCountV2: provider.ModelCount, AuthScopeV2: provider.AuthScope})
}

// CatalogModel is the redacted model metadata exposed to operators.
type CatalogModel struct {
	ID           string          `json:"id"`
	ProviderID   string          `json:"provider_id"`
	DisplayName  string          `json:"display_name,omitempty"`
	Enabled      bool            `json:"enabled"`
	Capabilities map[string]bool `json:"capabilities,omitempty"`
	Generation   uint64          `json:"generation"`
}

func (model CatalogModel) MarshalJSON() ([]byte, error) {
	type catalogModelAlias CatalogModel
	return json.Marshal(struct {
		catalogModelAlias
		Name         string `json:"name,omitempty"`
		ProviderIDV2 string `json:"providerId,omitempty"`
	}{catalogModelAlias: catalogModelAlias(model), Name: model.DisplayName, ProviderIDV2: model.ProviderID})
}
