package contracts

import "time"

// ShareAPIKeyResponse is the bounded public projection of an API key.
type ShareAPIKeyResponse struct {
	ID     string `json:"id"`
	Prefix string `json:"prefix"`
	Active bool   `json:"active"`
}

// ShareNotes contains operator-authored share presentation text.
type ShareNotes struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Body     string `json:"body"`
}

// ShareMonitorResponse is the bounded monitor payload for a public share.
type ShareMonitorResponse struct {
	Name                  string              `json:"name"`
	Active                bool                `json:"active"`
	APIKey                ShareAPIKeyResponse `json:"apiKey"`
	QuotaAvailable        bool                `json:"quotaAvailable"`
	InFlight              int                 `json:"inFlight"`
	TotalTokens           int64               `json:"totalTokens"`
	TotalRequests         int64               `json:"totalRequests"`
	DailyUsed             int64               `json:"dailyUsed"`
	DailyLimit            *int                `json:"dailyLimit"`
	DailyRemaining        *int64              `json:"dailyRemaining"`
	MonthlyUsed           int64               `json:"monthlyUsed"`
	MonthlyLimit          *int                `json:"monthlyLimit"`
	MonthlyRemaining      *int64              `json:"monthlyRemaining"`
	OneTimeLimit          *int                `json:"oneTimeLimit"`
	OneTimeUsed           int                 `json:"oneTimeUsed"`
	OneTimeRemaining      *int64              `json:"oneTimeRemaining"`
	RateLimitRPM          *int                `json:"rateLimitRpm"`
	MaxConcurrentRequests *int                `json:"maxConcurrentRequests"`
	ProviderAllowlist     *string             `json:"providerAllowlist"`
	ModelAllowlist        *string             `json:"modelAllowlist"`
	ModelDenylist         *string             `json:"modelDenylist"`
	Notes                 ShareNotes          `json:"notes"`
	CreatedAt             time.Time           `json:"createdAt"`
	LastUsedAt            *time.Time          `json:"lastUsedAt"`
	BaseURL               string              `json:"baseUrl"`
}

// ShareSetupResponse is the one-shot setup payload. Key is only emitted after
// the repository consumes a valid setup link. This is the sole console wire
// exception that carries setup credential material: callers MUST treat it as
// no-store, no-log, and non-reusable; it is never part of monitor or admin
// projections.
type ShareSetupResponse struct {
	Name      string     `json:"name"`
	Key       string     `json:"key"` // setup-only secret; never cache or log
	BaseURL   string     `json:"baseUrl"`
	ExpiresAt *time.Time `json:"expiresAt"`
}
