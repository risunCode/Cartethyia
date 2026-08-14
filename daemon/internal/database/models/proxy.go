package models

import "time"

// ProxyProtocol is the outbound proxy transport.
type ProxyProtocol string

const (
	ProxyProtocolHTTP   ProxyProtocol = "http"
	ProxyProtocolHTTPS  ProxyProtocol = "https"
	ProxyProtocolSOCKS5 ProxyProtocol = "socks5"
)

// Proxy is an outbound proxy route (proxies).
type Proxy struct {
	ID                       string
	Name                     string
	Protocol                 ProxyProtocol
	IsRelay                  bool
	Host                     string
	Port                     int
	Username                 string
	Password                 string
	Priority                 int
	Weight                   int
	MaxConcurrency           int
	Active                   bool
	CreatedAt                time.Time
	CooldownUntil            *time.Time
	CooldownLevel            int
	ConsecutiveUseCount      int
	LastUsedAt               *time.Time
	UpdatedAt                time.Time
	LastTestAt               *time.Time
	LastTestSuccessAt        *time.Time
	LastTestSuccessLatencyMs *int
	LastTestErrorAt          *time.Time
	LastTestError            string
	LastTestStatusCode       *int
}

// ProxyCreateInput is the create payload for a proxy.
type ProxyCreateInput struct {
	ID             string
	Name           string
	Protocol       ProxyProtocol
	Host           string
	Port           int
	Username       string
	Password       string
	IsRelay        bool
	MaxConcurrency int
	Priority       int
	Weight         int
	Active         bool
}

// ProxyPatchInput is the mutable subset of a proxy.
type ProxyPatchInput struct {
	Name                *string
	Protocol            *ProxyProtocol
	Host                *string
	Port                *int
	Username            *string
	Password            *string
	IsRelay             *bool
	MaxConcurrency      *int
	Priority            *int
	Weight              *int
	Active              *bool
	CooldownUntil       *time.Time
	CooldownLevel       *int
	ConsecutiveUseCount *int
	LastUsedAt          *time.Time
}

// ProxyTestResult is the per-test outcome recorded against a proxy.
type ProxyTestResult struct {
	TestedAt   time.Time
	OK         bool
	LatencyMs  *int
	StatusCode *int
	Error      string
}

// ProxyHealth is the per-proxy health sidecar (proxy_health). Parallel to
// AccountHealth but keyed by proxy id so proxy error text never sits beside
// proxy credentials.
type ProxyHealth struct {
	ProxyID          string
	Status           string
	ErrorKind        string
	StatusCode       *int
	SanitizedMessage string
	OccurredAt       *time.Time
	RetryAt          *time.Time
	UpdatedAt        time.Time
}

// ProxySettings is the singleton proxy-routing configuration (proxy_settings).
type ProxySettings struct {
	Enabled                bool
	ExcludedProviders      []string
	SmartDynamicRouting    bool
	SmartDynamicProxyCount int
	RoutingPreset          string
	TargetConcurrent       int
	WebSearchPreference    string
	UpdatedAt              time.Time
}

// CustomProvider is a user-added OpenAI/Anthropic-compatible endpoint.
// CredentialRef is an opaque secret-store identifier, never raw material.
type CustomProvider struct {
	ID             string
	Slug           string
	Name           string
	Type           string
	Protocol       string
	Surface        string
	BaseURL        string
	CredentialRef  string
	CredentialRefs []string
	TimeoutSeconds int
	Models         []byte
	CustomHeaders  []byte
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// WarpAccount is a Cloudflare WARP device-bound account (warp_accounts).
type WarpAccount struct {
	ID                  string
	Label               string
	DeviceID            string
	AccessToken         string
	LicenseKey          string
	PrivateKey          string
	AddressV4           string
	AddressV6           string
	PublicKey           string
	Endpoint            string
	EndpointPort        int
	DNS                 string
	MTU                 int
	SocksPort           int
	Enabled             bool
	Running             bool
	PID                 *int
	PreferIPv6          bool
	CustomEndpoint      string
	PersistentKeepalive int
	CreatedAt           time.Time
	UpdatedAt           *time.Time
}

// WarpMetric is a periodic sample from a running warp_accounts entry
// (warp_metrics).
type WarpMetric struct {
	ID          int64
	AccountID   string
	Label       string
	PID         int
	SocksPort   int
	RSSKB       int
	RXBytes     int
	TXBytes     int
	Healthy     bool
	EgressIP    string
	CollectedAt time.Time
}
