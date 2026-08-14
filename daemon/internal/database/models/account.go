package models

import "time"

// CredentialKind classifies the secret format of a provider account.
type CredentialKind string

const (
	CredentialKindAPIKey CredentialKind = "api_key"
	CredentialKindOAuth  CredentialKind = "oauth"
	CredentialKindManual CredentialKind = "manual"
	CredentialKindNone   CredentialKind = "none"
)

// Account is the non-secret provider credential selection record.
// CredentialRef points to request-time secret material in the auth boundary;
// raw credentials never enter this model.
type Account struct {
	ID                  string
	Provider            string
	Name                string
	CredentialKind      CredentialKind
	CredentialRef       string
	CredentialHint      string
	Priority            int
	Active              bool
	CooldownUntil       *time.Time
	CooldownLevel       int
	ConsecutiveUseCount int
	LastUsedAt          *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type AccountCreateInput struct {
	ID             string
	Provider       string
	Name           string
	CredentialKind CredentialKind
	CredentialRef  string
	CredentialHint string
	Priority       int
	Active         bool
}

type AccountPatchInput struct {
	Name                *string
	CredentialKind      *CredentialKind
	CredentialRef       *string
	CredentialHint      *string
	Priority            *int
	Active              *bool
	CooldownUntil       *time.Time
	CooldownLevel       *int
	ConsecutiveUseCount *int
	LastUsedAt          *time.Time
}

// AccountListPagination is the keyset pagination request for ListPaged.
type AccountListPagination struct {
	Limit  int
	Cursor string
}

// AccountListPage is the keyset pagination result for ListPaged.
type AccountListPage struct {
	Items      []Account
	NextCursor string
}

// AccountHealth is the per-account health sidecar (provider_account_health).
type AccountHealth struct {
	AccountID        string
	Status           string
	ErrorKind        string
	StatusCode       *int
	SanitizedMessage string
	OccurredAt       *time.Time
	RetryAt          *time.Time
	LastRefreshAt    *time.Time
	QuotaJSON        []byte
	QuotaError       string
	QuotaFetchedAt   *time.Time
	ProviderID       string
	DisabledUntilMs  *int64
	FailureCount     int
	Generation       int
	UpdatedAt        time.Time
}

// AccountModelLock is the per-(account, model) cooldown sidecar
// (account_model_locks). An error on model A (e.g. claude/sonnet-4) does
// NOT block model B (e.g. claude/haiku-4) on the same account.
type AccountModelLock struct {
	AccountID        string
	ModelID          string
	RetryAt          time.Time
	ErrorKind        string
	StatusCode       *int
	SanitizedMessage string
	FailureCount     int
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// OAuthRefreshLease is a short-lived lease guaranteeing only one oauth
// refresh attempt runs concurrently for a given account
// (oauth_refresh_leases).
type OAuthRefreshLease struct {
	AccountID        string
	OwnerID          string
	Generation       int
	TokenFingerprint string
	LeaseUntilMs     int64
	AcquiredAtMs     int64
}
