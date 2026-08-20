package auth

import (
	"context"
	"errors"
	"time"
)

// SecretStore persists the raw token material for an account. The
// contract deliberately separates "secrets" (encrypted, opaque blobs)
// from "records" (queryable, non-secret metadata) so that:
//
//   - Storage backends can specialize (KV vs relational) without leaking
//     material to the wrong layer.
//   - The runtime can fetch metadata for ranking without touching
//     crypto at all.
//   - Logging at the record layer is always safe.
//
// All methods MUST be safe to call concurrently from multiple goroutines.
type SecretStore interface {
	// PutAccess stores the access token for an account, replacing any
	// existing access token. The Secret is consumed; the store
	// becomes responsible for zeroing it after persistence.
	PutAccess(ctx context.Context, accountID string, secret *Secret) error

	// PutRefresh stores the refresh token, replacing any existing one.
	// An empty secret is allowed and clears the refresh slot.
	PutRefresh(ctx context.Context, accountID string, secret *Secret) error

	// GetAccess returns the access token for an account. The returned
	// Secret is a fresh copy owned by the caller; Close it when done.
	// ErrSecretNotFound means the account has no access token.
	GetAccess(ctx context.Context, accountID string) (*Secret, error)

	// GetRefresh returns the refresh token. ErrSecretNotFound means the
	// account has no refresh token.
	GetRefresh(ctx context.Context, accountID string) (*Secret, error)

	// Delete removes every secret associated with the account. It is
	// idempotent: deleting a missing account is not an error.
	Delete(ctx context.Context, accountID string) error
}

// RecordStore persists the non-secret OAuthTokenRecord views used for
// ranking, admin UI, and compare-and-swap on refresh.
type RecordStore interface {
	// Put writes the record, overwriting any prior version. The store
	// is expected to enforce optimistic concurrency through Version
	// when the underlying backend supports it.
	Put(ctx context.Context, record *OAuthTokenRecord) error
	// Get returns the record for the account id. ErrRecordNotFound means
	// the account has no persisted OAuth state.
	Get(ctx context.Context, accountID string) (*OAuthTokenRecord, error)

	// Delete removes the record. Idempotent.
	Delete(ctx context.Context, accountID string) error

	// List returns every record known to the store, useful for the
	// admin UI and for warm-up scans. Implementations are free to
	// stream results in batches.
	List(ctx context.Context) ([]*OAuthTokenRecord, error)

	// CompareAndSwap writes the record only when the persisted
	// Version matches expectedVersion. Returns ErrVersionMismatch
	// when the stored version differs. A negative expectedVersion
	// means "no record currently exists"; the write succeeds only
	// when the slot is empty. On success the persisted Version is
	// bumped to expectedVersion+1.
	CompareAndSwap(ctx context.Context, expectedVersion int64, record *OAuthTokenRecord) error
}

// RefreshLeaseHandle is an acquired cross-process refresh lease. The
// implementation must make Release idempotent.
type RefreshLeaseHandle interface {
	Release(context.Context) error
	// Renew extends the lease only when its account, owner, and generation
	// still match the durable authority. A lost or expired lease is rejected.
	Renew(context.Context, time.Duration) error
	// Fence returns the owner and monotonically increasing generation granted
	// by the lease. Durable commits must verify both values.
	Fence() RefreshFence
}

// RefreshFence identifies one acquired refresh generation. A commit carrying
// an old owner or generation must be rejected by the durable authority.
type RefreshFence struct {
	OwnerID    string
	Generation int64
}

// RefreshLeaseStore coordinates refresh-token use across daemon processes.
// Implementations should atomically acquire only when no unexpired lease
// exists, and should reject a lease owner that has been superseded.
type RefreshLeaseStore interface {
	Acquire(context.Context, string, string, time.Duration) (RefreshLeaseHandle, bool, error)
	// Renew extends one acquired lease. The returned bool is false when the
	// owner or generation is stale, or when the lease already expired.
	Renew(context.Context, string, RefreshFence, time.Duration) (bool, error)
}

// RefreshCommitter atomically persists refresh metadata and its encrypted
// secret material while enforcing the lease fence.
type RefreshCommitter interface {
	CommitRefresh(context.Context, int64, RefreshFence, *OAuthTokenRecord, *Secret, *Secret) error
}

// ErrSecretNotFound means a requested access or refresh secret is absent.
var ErrSecretNotFound = errors.New("auth: secret not found")

// ErrRecordNotFound means an account has no persisted OAuth state.
var ErrRecordNotFound = errors.New("auth: record not found")

// ErrAccountNotFound is returned by stores when an account id is unknown.
var ErrAccountNotFound = errors.New("auth: account not found")

// ErrVersionMismatch is returned by record stores when optimistic CAS loses.
var ErrVersionMismatch = errors.New("auth: record version mismatch")

// AccountConfig is the static configuration for a credential account:
// identity, credential kind, and the non-secret bits the runtime needs to
// route and refresh. Secret material is NEVER in this struct; it lives
// in SecretStore.
type AccountConfig struct {
	// ID is the local account identifier. Must be unique.
	ID string
	// ProviderID identifies the upstream.
	ProviderID string
	// Kind is the credential kind.
	Kind CredentialKind
	// Enabled flags the account as available for selection.
	Enabled bool
	// Labels are non-secret free-form tags for the admin UI.
	Labels map[string]string
	// CredentialRef identifies where request-time material is resolved. It
	// is opaque and contains no API key, OAuth token, or client secret.
	CredentialRef Reference
	// OAuthClientID is the OAuth client identifier issued by the
	// provider. Non-secret.
	OAuthClientID string
	// RedirectURI is the OAuth callback URL configured with the
	// provider. Non-secret.
	RedirectURI string
	// Scopes is the list of scopes requested at login. Provider
	// packages may treat this as authoritative.
	Scopes []string
}

// Validate checks the non-secret account configuration before persistence.
func (a *AccountConfig) Validate() error {
	if a == nil {
		return errors.New("auth: account config must not be nil")
	}
	if a.ID == "" {
		return errors.New("auth: account id must not be empty")
	}
	if a.ProviderID == "" {
		return errors.New("auth: provider id must not be empty")
	}
	if !a.Kind.Valid() {
		return errors.New("auth: account credential kind is invalid")
	}
	if !a.CredentialRef.IsZero() {
		if _, err := NewReference(a.CredentialRef.String()); err != nil {
			return err
		}
	}
	return nil
}

// NeedsOAuth reports whether the account is an OAuth-flow credential.
func (a *AccountConfig) NeedsOAuth() bool {
	if a == nil {
		return false
	}
	return a.Kind == KindOAuth || a.Kind == KindDevice
}

// AccountConfigStore is the durable storage for AccountConfig records.
// It mirrors the legacy "credential config store" surface and is
// deliberately separate from the OAuth secret/record stores so the
// admin UI can read account metadata without ever touching raw tokens.
type AccountConfigStore interface {
	// Put stores the config, replacing any prior config with the same
	// ID. The store owns only non-secret metadata.
	Put(ctx context.Context, cfg *AccountConfig) error
	// Get returns the config for the given id.
	Get(ctx context.Context, id string) (*AccountConfig, error)
	// List returns every known config, in stable (id) order.
	List(ctx context.Context) ([]*AccountConfig, error)
	// Delete removes the config. Idempotent.
	Delete(ctx context.Context, id string) error
}

// AccountDirectoryEntry is the non-secret projection used to build the
// request-path account directory. Config and Record contain only account
// metadata; access and refresh material remain in SecretStore.
type AccountDirectoryEntry struct {
	Config *AccountConfig
	Record *OAuthTokenRecord
}

// AccountDirectoryStore optionally supplies account config and token-record
// metadata in one provider-filtered query. Stores that do not implement this
// interface continue to work through the safe AccountConfigStore fallback.
type AccountDirectoryStore interface {
	ListAccountDirectory(ctx context.Context, providerID string) ([]AccountDirectoryEntry, error)
}

// AccountConfigCacheOptions tunes a small in-memory read cache used by
// the request path. Cache values contain non-secret account metadata only.
type AccountConfigCacheOptions struct {
	// TTL is the lifetime of a cached entry. Zero disables caching.
	TTL time.Duration
	// MaxEntries caps the cache size. Zero means unlimited; negative
	// is treated as zero.
	MaxEntries int
}
