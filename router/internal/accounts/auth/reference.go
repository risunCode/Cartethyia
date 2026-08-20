package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// MaxReferenceBytes bounds persisted credential references. References are
// identifiers only; request-time credential material is never accepted here.
const MaxReferenceBytes = 256

// Reference is an opaque persisted credential identifier. Its value may be
// serialized because it is only an identifier; it cannot contain Secret
// material through the type's API.
type Reference struct {
	value string
}

// NewReference creates a bounded opaque credential reference.
func NewReference(value string) (Reference, error) {
	if value == "" || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return Reference{}, fmt.Errorf("auth: invalid credential reference")
	}
	if len(value) > MaxReferenceBytes || strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return Reference{}, fmt.Errorf("auth: credential reference exceeds bounds")
	}
	return Reference{value: value}, nil
}

// String returns the identifier, never credential material.
func (r Reference) String() string { return r.value }

// IsZero reports whether the reference is absent.
func (r Reference) IsZero() bool { return r.value == "" }

// Equal compares two opaque references.
func (r Reference) Equal(other Reference) bool { return r.value == other.value }

// MarshalJSON emits only the opaque identifier.
func (r Reference) MarshalJSON() ([]byte, error) { return json.Marshal(r.value) }

// UnmarshalJSON accepts only a bounded opaque identifier.
func (r *Reference) UnmarshalJSON(data []byte) error {
	if r == nil {
		return errors.New("auth: nil credential reference")
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("auth: credential reference must be a string: %w", err)
	}
	if value == "" {
		*r = Reference{}
		return nil
	}
	ref, err := NewReference(value)
	if err != nil {
		return err
	}
	*r = ref
	return nil
}

// CredentialMetadata is the redacted, operator-safe view of a credential.
// It deliberately contains fingerprints and presence bits, never Secret
// values or provider headers.
type CredentialMetadata struct {
	Reference         Reference        `json:"reference"`
	AccountID         string           `json:"accountId"`
	ProviderID        string           `json:"providerId"`
	Kind              CredentialKind   `json:"kind"`
	Origin            CredentialOrigin `json:"origin"`
	AccessFingerprint string           `json:"accessFingerprint,omitempty"`
	ExpiresAt         time.Time        `json:"expiresAt,omitempty"`
	Scope             string           `json:"scope,omitempty"`
	ProviderAccountID string           `json:"providerAccountId,omitempty"`
	Email             string           `json:"email,omitempty"`
	OrgID             string           `json:"orgId,omitempty"`
	OrgName           string           `json:"orgName,omitempty"`
	HasAccess         bool             `json:"hasAccess"`
	HasRefresh        bool             `json:"hasRefresh"`
}

// Validate checks the non-secret metadata before it crosses an API boundary.
func (m CredentialMetadata) Validate() error {
	if m.Reference.IsZero() || m.AccountID == "" || m.ProviderID == "" {
		return errors.New("auth: credential metadata identity is incomplete")
	}
	if !m.Kind.Valid() {
		return fmt.Errorf("auth: invalid credential kind %q", m.Kind)
	}
	if !m.Origin.Valid() {
		return fmt.Errorf("auth: invalid credential origin %q", m.Origin)
	}
	for name, value := range map[string]string{
		"account id":          m.AccountID,
		"provider id":         m.ProviderID,
		"access fingerprint":  m.AccessFingerprint,
		"scope":               m.Scope,
		"provider account id": m.ProviderAccountID,
		"email":               m.Email,
		"organization id":     m.OrgID,
		"organization name":   m.OrgName,
	} {
		if len(value) > MaxReferenceBytes || !utf8.ValidString(value) ||
			strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return fmt.Errorf("auth: credential metadata %s exceeds bounds", name)
		}
	}
	return nil
}

// ResolvedCredential is an ephemeral adapter-facing credential. The Access
// field is available only after late resolution and must be closed by the
// caller. Metadata is safe to log, emit as metrics context, or return to an
// operator.
type ResolvedCredential struct {
	Metadata CredentialMetadata
	Access   *Secret
}

// Close releases the resolved access material. It is idempotent.
func (c *ResolvedCredential) Close() {
	if c == nil {
		return
	}
	if c.Access != nil {
		c.Access.Close()
		c.Access = nil
	}
}

// String and GoString make accidental formatting of a resolved credential
// safe; callers should log Metadata explicitly when needed.
func (c *ResolvedCredential) String() string   { return "<resolved-credential>" }
func (c *ResolvedCredential) GoString() string { return "<resolved-credential>" }

// MarshalJSON intentionally omits Access even if a resolved credential is
// accidentally included in an admin or diagnostic response.
func (c *ResolvedCredential) MarshalJSON() ([]byte, error) {
	if c == nil {
		return []byte("null"), nil
	}
	return json.Marshal(c.Metadata)
}

// CredentialResolver resolves an opaque reference as late as possible. The
// returned access material is ephemeral and must be closed by the caller.
type CredentialResolver interface {
	Resolve(ctx context.Context, ref Reference) (*ResolvedCredential, error)
}

// StoreResolverOptions wires the provider-neutral resolver to account metadata,
// secret persistence, token metadata, and optional OAuth refresh coordination.
type StoreResolverOptions struct {
	Accounts  AccountConfigStore
	Secrets   SecretStore
	Records   RecordStore
	Refresher Refresher
	// AccessCache enables a bounded request-path cache when both TTL and
	// MaxEntries are positive. It stores access material and safe metadata
	// only; refresh tokens are never cached.
	AccessCache CredentialCacheOptions
}

// CredentialCacheOptions tunes the optional request-path access cache. A
// non-positive TTL or MaxEntries disables caching. The cache is intentionally
// bounded so credential material cannot grow without limit in a daemon.
type CredentialCacheOptions struct {
	TTL        time.Duration
	MaxEntries int
}

type cachedCredential struct {
	metadata CredentialMetadata
	access   *Secret
	expires  time.Time
	used     uint64
}

// StoreCredentialResolver is the canonical late-resolution boundary for
// account credentials. It never places secrets in AccountConfig or metadata.
type StoreCredentialResolver struct {
	accounts  AccountConfigStore
	secrets   SecretStore
	records   RecordStore
	refresher Refresher

	cacheMu    sync.Mutex
	cache      map[string]cachedCredential
	cacheTTL   time.Duration
	cacheMax   int
	cacheClock uint64
	closed     bool
}

// NewStoreCredentialResolver constructs a resolver backed by the injected
// stores. Account metadata and secret material remain separate boundaries.
func NewStoreCredentialResolver(opts StoreResolverOptions) (*StoreCredentialResolver, error) {
	if opts.Accounts == nil {
		return nil, errors.New("auth: credential resolver requires an account store")
	}
	if opts.Secrets == nil {
		return nil, errors.New("auth: credential resolver requires a secret store")
	}
	return &StoreCredentialResolver{
		accounts:  opts.Accounts,
		secrets:   opts.Secrets,
		records:   opts.Records,
		refresher: opts.Refresher,
		cache:     make(map[string]cachedCredential),
		cacheTTL:  opts.AccessCache.TTL,
		cacheMax:  opts.AccessCache.MaxEntries,
	}, nil
}

// Resolve implements CredentialResolver. OAuth refresh, when configured, is
// delegated to the existing Refresher so the resolver does not create a
// second refresh or lease path.
func (r *StoreCredentialResolver) Resolve(ctx context.Context, ref Reference) (*ResolvedCredential, error) {
	if r == nil || r.accounts == nil || r.secrets == nil {
		return nil, NewError(ErrKindStorage, "", "", errors.New("credential resolver is unavailable"))
	}
	if ref.IsZero() {
		return nil, NewError(ErrKindInvalidRequest, "", "", errors.New("credential reference must not be empty"))
	}
	if err := ctx.Err(); err != nil {
		return nil, NewError(ErrKindRefreshTransient, "", ref.String(), err)
	}
	if resolved := r.cached(ref.String()); resolved != nil {
		return resolved, nil
	}

	cfg, err := r.accounts.Get(ctx, ref.String())
	if errors.Is(err, ErrAccountNotFound) {
		return nil, NewError(ErrKindInvalidRequest, "", ref.String(), err)
	}
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return nil, NewError(ErrKindInvalidRequest, "", ref.String(), ErrAccountNotFound)
	}
	if !cfg.CredentialRef.IsZero() && !cfg.CredentialRef.Equal(ref) {
		return nil, NewError(ErrKindInvalidRequest, cfg.ProviderID, cfg.ID, errors.New("credential reference does not match account"))
	}

	var token *TokenSet
	if cfg.NeedsOAuth() && r.refresher != nil {
		token, err = r.refresher.Current(ctx, cfg.ID)
	} else {
		var access *Secret
		access, err = r.secrets.GetAccess(ctx, cfg.ID)
		if errors.Is(err, ErrSecretNotFound) {
			err = nil
		}
		if err == nil && access != nil && !access.IsZero() {
			token = &TokenSet{Access: access, Origin: defaultOrigin(cfg.Kind)}
		} else if access != nil {
			access.Close()
		}
	}
	if token == nil || !token.Valid() {
		if token != nil {
			token.Access.Close()
			token.Refresh.Close()
		}
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("credential material is unavailable"))
	}
	if token.Origin == "" {
		token.Origin = defaultOrigin(cfg.Kind)
	}
	hasRefresh := !token.Refresh.IsZero()
	token.Refresh.Close()
	token.Refresh = nil

	metadata := CredentialMetadata{
		Reference:         ref,
		AccountID:         cfg.ID,
		ProviderID:        cfg.ProviderID,
		Kind:              cfg.Kind,
		Origin:            token.Origin,
		AccessFingerprint: token.Access.Fingerprint(),
		ExpiresAt:         token.ExpiresAt,
		Scope:             token.Scope,
		ProviderAccountID: token.ProviderAccountID,
		Email:             token.Email,
		OrgID:             token.OrgID,
		OrgName:           token.OrgName,
		HasAccess:         token.Valid(),
		HasRefresh:        hasRefresh,
	}
	if record, recordErr := r.loadRecord(ctx, cfg.ID); recordErr == nil && record != nil {
		metadata.HasRefresh = metadata.HasRefresh || record.RefreshFingerprint != ""
		if record.ReauthenticationRequired ||
			(cfg.Kind == KindAccessOnly && !record.ExpiresAt.IsZero() && !time.Now().Before(record.ExpiresAt)) {
			token.Access.Close()
			return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("credential requires reauthentication"))
		}
	} else if recordErr != nil {
		token.Access.Close()
		return nil, recordErr
	}
	if err := metadata.Validate(); err != nil {
		token.Access.Close()
		return nil, err
	}
	r.cacheCredential(ref.String(), metadata, token.Access)
	return &ResolvedCredential{Metadata: metadata, Access: token.Access}, nil
}

// Invalidate removes a cached access credential for ref and zeroes the
// retained material. Callers that delete or replace account credentials can
// use this to avoid serving material until the configured TTL elapses.
func (r *StoreCredentialResolver) Invalidate(ref Reference) {
	if r == nil || ref.IsZero() {
		return
	}
	r.cacheMu.Lock()
	if entry, ok := r.cache[ref.String()]; ok {
		entry.access.Close()
		delete(r.cache, ref.String())
	}
	r.cacheMu.Unlock()
}

// InvalidateAccount removes every cached access credential belonging to the
// account. Router refresh retries identify accounts by local id rather than
// by opaque credential reference, so this is the safe invalidation boundary.
func (r *StoreCredentialResolver) InvalidateAccount(accountID string) {
	if r == nil || accountID == "" {
		return
	}
	r.cacheMu.Lock()
	for key, entry := range r.cache {
		if entry.metadata.AccountID == accountID {
			entry.access.Close()
			delete(r.cache, key)
		}
	}
	r.cacheMu.Unlock()
}

// Close zeroes all retained access material and disables future cache use.
// It is safe to call repeatedly and on a nil resolver.
func (r *StoreCredentialResolver) Close() error {
	if r == nil {
		return nil
	}
	r.cacheMu.Lock()
	if !r.closed {
		for key, entry := range r.cache {
			entry.access.Close()
			delete(r.cache, key)
		}
		r.closed = true
	}
	r.cacheMu.Unlock()
	return nil
}

func (r *StoreCredentialResolver) cached(key string) *ResolvedCredential {
	r.cacheMu.Lock()
	defer r.cacheMu.Unlock()
	if r.closed || r.cacheTTL <= 0 || r.cacheMax <= 0 {
		return nil
	}
	entry, ok := r.cache[key]
	if !ok {
		return nil
	}
	now := time.Now()
	if !now.Before(entry.expires) {
		entry.access.Close()
		delete(r.cache, key)
		return nil
	}
	r.cacheClock++
	entry.used = r.cacheClock
	r.cache[key] = entry
	return &ResolvedCredential{Metadata: entry.metadata, Access: NewSecret(entry.access.Reveal())}
}

func (r *StoreCredentialResolver) cacheCredential(key string, metadata CredentialMetadata, access *Secret) {
	if access == nil || access.IsZero() || r.cacheTTL <= 0 || r.cacheMax <= 0 {
		return
	}
	r.cacheMu.Lock()
	defer r.cacheMu.Unlock()
	if r.closed {
		return
	}
	now := time.Now()
	expires := now.Add(r.cacheTTL)
	if !metadata.ExpiresAt.IsZero() && metadata.ExpiresAt.Before(expires) {
		expires = metadata.ExpiresAt
	}
	if !now.Before(expires) {
		return
	}
	if prior, ok := r.cache[key]; ok {
		prior.access.Close()
		delete(r.cache, key)
	}
	for len(r.cache) >= r.cacheMax {
		var oldestKey string
		var oldest uint64
		for candidate, entry := range r.cache {
			if !now.Before(entry.expires) {
				oldestKey = candidate
				break
			}
			if oldestKey == "" || entry.used < oldest {
				oldestKey, oldest = candidate, entry.used
			}
		}
		if entry, ok := r.cache[oldestKey]; ok {
			entry.access.Close()
			delete(r.cache, oldestKey)
		} else {
			break
		}
	}
	r.cacheClock++
	r.cache[key] = cachedCredential{metadata: metadata, access: NewSecret(access.Reveal()), expires: expires, used: r.cacheClock}
}

func (r *StoreCredentialResolver) loadRecord(ctx context.Context, accountID string) (*OAuthTokenRecord, error) {
	if r.records == nil {
		return nil, nil
	}
	return r.records.Get(ctx, accountID)
}

func defaultOrigin(kind CredentialKind) CredentialOrigin {
	switch kind {
	case KindAPIKey:
		return OriginAPIKey
	case KindDevice:
		return OriginOAuthDevice
	case KindOAuth:
		return OriginOAuth
	default:
		return OriginExternal
	}
}
