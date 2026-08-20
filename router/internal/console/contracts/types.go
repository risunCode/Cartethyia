package contracts

import "encoding/json"

// Account is the operator-safe account projection. Credential material is never
// represented; CredentialRef is an opaque, non-secret configuration reference.
type Account struct {
	ID                string `json:"id"`
	Provider          string `json:"provider"`
	Model             string `json:"model,omitempty"`
	Enabled           bool   `json:"enabled"`
	Email             string `json:"email,omitempty"`
	Name              string `json:"name,omitempty"`
	ProviderAccountID string `json:"providerAccountId,omitempty"`
	OrgID             string `json:"orgId,omitempty"`
	OrgName           string `json:"orgName,omitempty"`
	ProjectID         string `json:"projectId,omitempty"`
	Region            string `json:"region,omitempty"`
	ReauthRequired    bool   `json:"reauthRequired,omitempty"`
}

// InFlightRow is one bounded live dispatch projection.
type InFlightRow struct {
	ID        string `json:"id"`
	Model     string `json:"model"`
	Provider  string `json:"provider"`
	ClientIP  string `json:"ip"`
	Surface   string `json:"surface,omitempty"`
	StartedAt string `json:"startedAt"`
	AgeMS     int64  `json:"ageMs"`
}

type DashboardSummary struct {
	Version      string         `json:"version"`
	Environment  string         `json:"environment"`
	Uptime       string         `json:"uptime"`
	AccountCount int            `json:"accountCount"`
	ProxyCount   int            `json:"proxyCount"`
	APIKeyCount  int            `json:"apiKeyCount"`
	Health       map[string]any `json:"health,omitempty"`
}

// AccountInput is bounded account metadata. Secrets are written through an
// out-of-band credential resolver and are not accepted by this contract.
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

type AccountBatchPatch struct {
	AccountID string         `json:"accountId"`
	Enabled   *bool          `json:"enabled,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type BatchResult struct {
	Processed int      `json:"processed"`
	Succeeded int      `json:"succeeded"`
	Failed    int      `json:"failed"`
	Errors    []string `json:"errors,omitempty"`
}

type QuotaState struct {
	AccountID   string         `json:"accountId"`
	Used        int64          `json:"used"`
	Limit       int64          `json:"limit"`
	Remaining   int64          `json:"remaining"`
	ResetsAt    string         `json:"resetsAt,omitempty"`
	LastChecked string         `json:"lastChecked,omitempty"`
	Extras      map[string]any `json:"extras,omitempty"`
}

// OAuthState contains bounded handshake metadata only. OAuth tokens and
// provider response bodies are never represented here.
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

type RuntimeSettings struct {
	Environment string          `json:"environment"`
	LogLevel    string          `json:"logLevel"`
	ListenAddr  string          `json:"listenAddr"`
	Flags       map[string]bool `json:"flags,omitempty"`
	Metadata    map[string]any  `json:"metadata,omitempty"`
}

type RuntimeSettingsInput struct {
	LogLevel   *string         `json:"logLevel,omitempty"`
	ListenAddr *string         `json:"listenAddr,omitempty"`
	Flags      map[string]bool `json:"flags,omitempty"`
	Metadata   map[string]any  `json:"metadata,omitempty"`
}

// Session is the public session projection. Cookies and CSRF/auth header
// material are transport-only and deliberately absent.
type Session struct {
	ID        string   `json:"id"`
	User      string   `json:"user"`
	Scopes    []string `json:"scopes,omitempty"`
	CreatedAt string   `json:"createdAt,omitempty"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
}

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

type TelemetryOverview struct {
	Requests int64            `json:"requests"`
	Errors   int64            `json:"errors"`
	P50      int              `json:"p50Ms"`
	P95      int              `json:"p95Ms"`
	P99      int              `json:"p99Ms"`
	ByRoute  map[string]int64 `json:"byRoute,omitempty"`
}

type TelemetryBucket struct {
	Timestamp string         `json:"timestamp"`
	Count     int64          `json:"count"`
	Errors    int64          `json:"errors,omitempty"`
	LatencyMS int            `json:"latencyMs,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// RequestDetail contains bounded request evidence only: no prompts, payloads,
// headers, cookies, credentials, or upstream/provider bodies.
type RequestDetail struct {
	ID           string `json:"id"`
	TraceID      string `json:"traceId"`
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	Surface      string `json:"surface,omitempty"`
	Endpoint     string `json:"endpoint,omitempty"`
	APIKeyID     string `json:"apiKeyId,omitempty"`
	APIKeyPrefix string `json:"apiKeyPrefix,omitempty"`
	Status       int    `json:"status"`
	LatencyMs    int64  `json:"latencyMs"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
	Error        string `json:"error,omitempty"`
	ClientIP     string `json:"clientIp,omitempty"`
	ClientName   string `json:"clientName,omitempty"`
	ClientSource string `json:"clientSource,omitempty"`
	Stream       bool   `json:"stream"`
	StartedAt    string `json:"startedAt,omitempty"`
	FinishedAt   string `json:"finishedAt,omitempty"`
}

type ConsoleLogQuery struct {
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	Level  string `json:"level,omitempty"`
	Scope  string `json:"scope,omitempty"`
	Origin string `json:"origin,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// ClientErrorInput is the bounded browser/client error payload accepted by the
// console log ingest route.
type ClientErrorInput struct {
	Level   string         `json:"level"`
	Message string         `json:"message"`
	Context map[string]any `json:"context,omitempty"`
}

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

type UsageSummary struct {
	Requests     int64            `json:"requests"`
	InputTokens  *int64           `json:"input_tokens,omitempty"`
	OutputTokens *int64           `json:"output_tokens,omitempty"`
	TotalTokens  *int64           `json:"total_tokens,omitempty"`
	ByProvider   map[string]int64 `json:"by_provider,omitempty"`
	ByModel      map[string]int64 `json:"by_model,omitempty"`
}

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

// MarshalJSON preserves the established snake_case fields and the camelCase
// aliases consumed by the dashboard's closed parser.
func (provider CatalogProvider) MarshalJSON() ([]byte, error) {
	type alias CatalogProvider
	return json.Marshal(struct {
		alias
		Name              string   `json:"name,omitempty"`
		CredentialKindV2  string   `json:"credentialKind,omitempty"`
		CredentialKindsV2 []string `json:"credentialKinds,omitempty"`
		EnabledV2         bool     `json:"enabled"`
		ConfiguredV2      bool     `json:"configured"`
		AccountCountV2    int      `json:"accountCount"`
		ModelCountV2      int      `json:"modelCount"`
		AuthScopeV2       string   `json:"authScope,omitempty"`
	}{
		alias:             alias(provider),
		Name:              provider.DisplayName,
		CredentialKindV2:  provider.CredentialKind,
		CredentialKindsV2: provider.CredentialKinds,
		EnabledV2:         provider.Enabled,
		ConfiguredV2:      provider.Configured,
		AccountCountV2:    provider.AccountCount,
		ModelCountV2:      provider.ModelCount,
		AuthScopeV2:       provider.AuthScope,
	})
}

type CatalogModel struct {
	ID           string          `json:"id"`
	ProviderID   string          `json:"provider_id"`
	DisplayName  string          `json:"display_name,omitempty"`
	Enabled      bool            `json:"enabled"`
	Capabilities map[string]bool `json:"capabilities,omitempty"`
	Generation   uint64          `json:"generation"`
}

func (model CatalogModel) MarshalJSON() ([]byte, error) {
	type alias CatalogModel
	return json.Marshal(struct {
		alias
		Name         string `json:"name,omitempty"`
		ProviderIDV2 string `json:"providerId,omitempty"`
	}{
		alias:        alias(model),
		Name:         model.DisplayName,
		ProviderIDV2: model.ProviderID,
	})
}

type ProxyRecord struct {
	ID             string `json:"id"`
	Type           string `json:"type"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Priority       int    `json:"priority"`
	Weight         int    `json:"weight"`
	MaxConcurrency int    `json:"max_concurrency"`
	Active         bool   `json:"active"`
	Health         string `json:"health"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type ProxyInput struct {
	Type           *string `json:"type,omitempty"`
	Host           *string `json:"host,omitempty"`
	Port           *int    `json:"port,omitempty"`
	Priority       *int    `json:"priority,omitempty"`
	Weight         *int    `json:"weight,omitempty"`
	MaxConcurrency *int    `json:"max_concurrency,omitempty"`
	Active         *bool   `json:"active,omitempty"`
}
