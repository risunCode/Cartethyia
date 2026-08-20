package api

import (
	"context"

	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"github.com/cartethyia/daemon/internal/router/batch"
)

// Services aggregates the narrow dependencies each admin handler slice needs.
// It is constructed by the runtime wiring (not defined here) and passed into
// Register. Individual slices consume only the fields they need so the
// interface stays small and testable.
type Services struct {
	Dashboard  DashboardService
	Accounts   AccountService
	Settings   SettingsService
	Auth       AuthService
	ProxyAdmin ProxyAdminService
	// OAuth optionally supplies the concrete provider-neutral OAuth lifecycle.
	// When nil, Auth is used for backwards-compatible OAuth routes.
	OAuth       OAuthLifecycleService
	Telemetry   TelemetryService
	ConsoleLogs ConsoleLogService
	Usage       UsageService
	Catalog     CatalogService
	// Batch owns durable batch lifecycle operations. Public and console
	// handlers project this same service through separate authorization seams.
	Batch batch.Service
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

// consolecontracts.InFlightRow is one live dispatch in the in-flight stream. Model/Surface
// come from the dispatch request; Provider and ClientIP stay empty until the
// hot path records them.
// InFlightDetailSource snapshots bounded per-request dispatch records.
type InFlightDetailSource interface {
	InFlightRows() []consolecontracts.InFlightRow
}

// DashboardService surfaces the at-a-glance status of the daemon.
type DashboardService interface {
	Summary(ctx context.Context) (consolecontracts.DashboardSummary, error)
}

// AccountService is the contract for account/credential management endpoints.
type AccountService interface {
	List(ctx context.Context, providerID string) ([]consolecontracts.Account, error)
	BatchCreate(ctx context.Context, providerID string, items []consolecontracts.AccountInput) ([]consolecontracts.Account, error)
	Create(ctx context.Context, providerID string, input consolecontracts.AccountInput) (consolecontracts.Account, error)
	Update(ctx context.Context, providerID, accountID string, input consolecontracts.AccountInput) (consolecontracts.Account, error)
	Delete(ctx context.Context, providerID, accountID string) error
	BatchDelete(ctx context.Context, providerID string, accountIDs []string) (consolecontracts.BatchResult, error)
	BatchUpdate(ctx context.Context, providerID string, items []consolecontracts.AccountBatchPatch) (consolecontracts.BatchResult, error)
	Credential(ctx context.Context, accountID string) (string, error)
	RefreshQuota(ctx context.Context, accountID string) (consolecontracts.QuotaState, error)
	Quota(ctx context.Context, accountID string) (consolecontracts.QuotaState, error)
	RevokeForProvider(ctx context.Context, providerID, accountID string) error
}

// SettingsService is the contract for runtime configuration endpoints.
type SettingsService interface {
	Get(ctx context.Context) (consolecontracts.RuntimeSettings, error)
	Patch(ctx context.Context, input consolecontracts.RuntimeSettingsInput) (consolecontracts.RuntimeSettings, error)
	Reset(ctx context.Context) (consolecontracts.RuntimeSettings, error)
}

// AuthService is the contract for login/session lifecycle endpoints.
type AuthService interface {
	Login(ctx context.Context, input LoginInput, request AuthRequest) (LoginResult, error)
	Logout(ctx context.Context, sessionID string) error
	Current(ctx context.Context, sessionID string) (consolecontracts.Session, error)
	// Refresh validates the presented session token and re-issues a fresh
	// one. The returned LoginResult carries the rotated token through
	// SetCookie with the same cookie contract as Login; consolecontracts.Session alone (with
	// an empty SetCookie) keeps the legacy no-rotation behavior.
	Refresh(ctx context.Context, sessionID string, request AuthRequest) (LoginResult, error)
	OAuthStart(ctx context.Context, providerID string, input OAuthStartInput) (consolecontracts.OAuthState, error)
	OAuthComplete(ctx context.Context, sessionID string, input OAuthCompleteInput) (consolecontracts.OAuthState, error)
	OAuthCancel(ctx context.Context, sessionID string) error
	OAuthRefresh(ctx context.Context, input OAuthRefreshInput) (consolecontracts.OAuthState, error)
}

// OAuthLifecycleService is the narrow production seam for provider OAuth.
// It lets deployments compose OAuth without inventing a password/session
// service when those concerns are owned elsewhere.
type OAuthLifecycleService interface {
	OAuthStart(ctx context.Context, providerID string, input OAuthStartInput) (consolecontracts.OAuthState, error)
	OAuthComplete(ctx context.Context, sessionID string, input OAuthCompleteInput) (consolecontracts.OAuthState, error)
	OAuthCancel(ctx context.Context, sessionID string) error
	OAuthRefresh(ctx context.Context, input OAuthRefreshInput) (consolecontracts.OAuthState, error)
}

// OAuthStatusService is an additive seam for device polling and browser
// status. Existing AuthService implementations remain source-compatible; when
// absent, the legacy OAuthComplete(session, empty input) status path is used.
type OAuthStatusService interface {
	OAuthStatus(ctx context.Context, sessionID string) (consolecontracts.OAuthState, error)
}

// OAuthReauthService is an optional explicit reauthentication seam. Services
// that do not implement it still support the existing force-refresh contract.
type OAuthReauthService interface {
	OAuthReauthenticate(ctx context.Context, input OAuthRefreshInput) (consolecontracts.OAuthState, error)
}

// LoginInput is the request body for password-based login.
type LoginInput struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
}

// LoginResult is the response of a successful login.
type LoginResult struct {
	Session   consolecontracts.Session `json:"session"`
	SetCookie string                   `json:"setCookie,omitempty"`
	MaxAge    int                      `json:"maxAge,omitempty"`
}

// Session is a console session record.
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
	Overview(ctx context.Context, input consolecontracts.TelemetryQuery) (consolecontracts.TelemetryOverview, error)
	Requests(ctx context.Context, input consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error)
	Errors(ctx context.Context, input consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error)
	Upstream(ctx context.Context, input consolecontracts.TelemetryQuery) ([]consolecontracts.TelemetryBucket, error)
	RequestDetail(ctx context.Context, id string) (consolecontracts.RequestDetail, error)
}

// ConsoleLogService provides bounded, operator-safe lifecycle evidence.
// Implementations must redact prompts, credentials, headers, cookies, and
// full upstream/provider bodies before returning rows, and must accept
// browser/client-error inserts without exposing secret material.
type ConsoleLogService interface {
	List(context.Context, consolecontracts.ConsoleLogQuery) ([]consolecontracts.ConsoleLogEntry, error)
	Insert(context.Context, consolecontracts.ClientErrorInput) error
}

// UsageService provides persisted request usage aggregates.
type UsageService interface {
	Usage(ctx context.Context, input consolecontracts.TelemetryQuery) (consolecontracts.UsageSummary, error)
	Clients(ctx context.Context, input consolecontracts.TelemetryQuery) (consolecontracts.ClientDistribution, error)
}

// CatalogService backs the V2 operator catalog. It is separate from the
// external /v1/models ingress so dashboard code has no V1 dependency.
type CatalogService interface {
	Providers(ctx context.Context) ([]consolecontracts.CatalogProvider, error)
}

// ProxyAdminService is the contract for proxy management endpoints.
type ProxyAdminService interface {
	List(ctx context.Context) ([]consolecontracts.ProxyRecord, error)
	Create(ctx context.Context, input consolecontracts.ProxyInput) (consolecontracts.ProxyRecord, error)
	Update(ctx context.Context, id string, input consolecontracts.ProxyInput) (consolecontracts.ProxyRecord, error)
	Delete(ctx context.Context, id string) error
}
