package models

import "time"

// ApiKey is the public projection of an API key (api_keys). The full secret
// is held separately via the credential accessor on the repository; this
// struct only carries the comparison prefix and operator-visible fields.
type ApiKey struct {
	ID                    string
	Name                  string
	KeyPrefix             string
	Active                bool
	RateLimitRpm          *int
	DailyTokenLimit       *int
	MonthlyTokenLimit     *int
	OneTimeTokenLimit     *int
	OneTimeTokensUsed     int
	QuoteBigText          string
	QuoteSubText          string
	QuoteBody             string
	MaxConcurrentRequests *int
	ProviderAllowlist     string
	ModelAllowlist        string
	ModelDenylist         string
	DisableRemoteMapping  bool
	LastUsedAt            *time.Time
	CreatedAt             time.Time
	RevokedAt             *time.Time
}

// ApiKeyCreateInput is the create payload for an API key.
type ApiKeyCreateInput struct {
	ID                    string
	Name                  string
	Key                   string
	KeyPrefix             string
	RateLimitRpm          *int
	DailyTokenLimit       *int
	MonthlyTokenLimit     *int
	OneTimeTokenLimit     *int
	MaxConcurrentRequests *int
	ProviderAllowlist     string
	ModelAllowlist        string
	ModelDenylist         string
	DisableRemoteMapping  bool
}

// ApiKeyPatchInput is the mutable subset of an API key. Nil fields mean
// "do not change"; non-nil fields replace the stored value.
type ApiKeyPatchInput struct {
	Name                  *string
	Key                   *string
	RateLimitRpm          *int
	DailyTokenLimit       *int
	MonthlyTokenLimit     *int
	OneTimeTokenLimit     *int
	QuoteBigText          *string
	QuoteSubText          *string
	QuoteBody             *string
	MaxConcurrentRequests *int
	ProviderAllowlist     *string
	ModelAllowlist        *string
	ModelDenylist         *string
	DisableRemoteMapping  *bool
	Active                *bool
}

// ShareLink is a one-shot or monitor token bound to an API key (share_links).
type ShareLink struct {
	ID           string
	APIKeyID     string
	TokenHash    string
	Kind         string
	Active       bool
	CreatedAt    time.Time
	ExpiresAt    *time.Time
	UsedAt       *time.Time
	LastViewedAt *time.Time
}
