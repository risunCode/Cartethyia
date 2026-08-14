package accounts

import "time"

// CredentialKind classifies how a credential authenticates against a
// provider. The runtime dispatches on Kind to pick the right refresh
// driver and the right request-time header shape. Provider-specific
// extensions belong in the provider package, not here.
type CredentialKind string

const (
	// KindAPIKey is a static bearer-style key (sk-..., x-api-key, etc.).
	KindAPIKey CredentialKind = "api_key"
	// KindOAuth covers authorization-code and PKCE flows with refresh
	// tokens (Anthropic, OpenAI Codex, Kiro, etc.).
	KindOAuth CredentialKind = "oauth"
	// KindDevice covers device-code login flows that mint OAuth tokens.
	// The runtime treats device-issued tokens as OAuth for refresh
	// purposes; Kind is metadata for the admin UI.
	KindDevice CredentialKind = "device_code"
	// KindAccessOnly is a credential that deliberately has no refresh
	// operation. An expired access token requires interactive reauthentication.
	KindAccessOnly CredentialKind = "access_only"
	// KindCustom is the escape hatch for providers that don't fit
	// any of the above. The provider package is responsible for its
	// own refresh semantics.
	KindCustom CredentialKind = "custom"
)

// Valid reports whether the kind is a supported provider-neutral credential
// family.
func (k CredentialKind) Valid() bool {
	switch k {
	case KindAPIKey, KindOAuth, KindDevice, KindAccessOnly, KindCustom:
		return true
	default:
		return false
	}
}

// CredentialOrigin records how the current material was acquired. It is safe
// metadata and never contains token material.
type CredentialOrigin string

const (
	OriginAPIKey       CredentialOrigin = "api_key"
	OriginOAuth        CredentialOrigin = "oauth"
	OriginOAuthDevice  CredentialOrigin = "oauth_device"
	OriginOAuthRefresh CredentialOrigin = "oauth_refresh"
	OriginExternal     CredentialOrigin = "external"
)

// Valid reports whether the origin is one of the provider-neutral values.
func (o CredentialOrigin) Valid() bool {
	switch o {
	case OriginAPIKey, OriginOAuth, OriginOAuthDevice, OriginOAuthRefresh, OriginExternal:
		return true
	default:
		return false
	}
}

// DefaultOrigin returns the safe acquisition origin for a credential kind.
func DefaultOrigin(kind CredentialKind) CredentialOrigin {
	return defaultOrigin(kind)
}

// TokenSet is the provider-neutral result of an OAuth exchange or
// refresh. The Access field is a Secret; the rest are non-secret
// metadata that is safe to persist and to surface in the admin UI.
type TokenSet struct {
	// Access is the bearer material used for upstream calls.
	Access *Secret
	// Refresh is optional; some providers do not issue refresh tokens
	// (Anthropic setup-tokens) and can never be refreshed.
	Refresh *Secret
	// Origin records how the current material was acquired. It is safe
	// metadata and is never serialized with the Secret values.
	Origin CredentialOrigin
	// ExpiresAt is the wall-clock expiry of Access. Providers that do
	// not return an expiry (Anthropic setup-tokens) leave it zero.
	ExpiresAt time.Time
	// Scope is the space-separated or provider-specific scope string.
	Scope string
	// ProviderAccountID is the upstream-side account id, when the
	// provider distinguishes accounts. Useful for routing.
	ProviderAccountID string
	// Email is the account email when the provider inlines it.
	Email string
	// OrgID / OrgName identify the subscription workspace when the
	// provider exposes one (Anthropic console, Google Antigravity).
	OrgID   string
	OrgName string
}

// Valid reports whether the TokenSet has the minimum material required to
// authenticate. A zero access secret is never valid even if metadata is
// present.
func (t *TokenSet) Valid() bool {
	return t != nil && !t.Access.IsZero()
}

// NeedsRefresh reports whether the access token should be refreshed now.
// The supplied safetySkew widens the expiry window so a token is treated
// as expired slightly before its real expiry; pass a zero duration to use
// the exact expiry.
//
// A zero ExpiresAt is treated as "no expiry known" and never needs
// refresh; providers that use long-lived tokens (Anthropic
// setup-tokens, etc.) rely on this.
func (t *TokenSet) NeedsRefresh(now time.Time, safetySkew time.Duration) bool {
	if t == nil || t.Access.IsZero() {
		return false
	}
	if t.ExpiresAt.IsZero() {
		return false
	}
	return !now.Add(safetySkew).Before(t.ExpiresAt)
}

// Clone returns a deep copy of the TokenSet. Both Secret fields are
// duplicated so mutations to the originals do not affect the clone. The
// returned TokenSet's Secrets are independent and must each be Closed
// when no longer needed.
func (t *TokenSet) Clone() *TokenSet {
	if t == nil {
		return nil
	}
	out := &TokenSet{
		Scope:             t.Scope,
		ProviderAccountID: t.ProviderAccountID,
		Email:             t.Email,
		OrgID:             t.OrgID,
		OrgName:           t.OrgName,
		ExpiresAt:         t.ExpiresAt,
		Origin:            t.Origin,
	}
	if !t.Access.IsZero() {
		out.Access = NewSecret(t.Access.Reveal())
	}
	if !t.Refresh.IsZero() {
		out.Refresh = NewSecret(t.Refresh.Reveal())
	}
	return out
}
// Close releases both secret fields owned by the token set. It is safe to
// call repeatedly and on a nil receiver.
func (t *TokenSet) Close() {
	if t == nil {
		return
	}
	t.Access.Close()
	t.Refresh.Close()
	t.Access = nil
	t.Refresh = nil
}


// OAuthTokenRecord is the non-secret, durable view of a token stored in
// the local database. Token material is referenced by Secret (a
// fingerprint) and by the encrypted blob, never duplicated in plain
// text. Use this record when persisting state across restarts; the
// in-memory TokenSet above is the request-time working copy.
type OAuthTokenRecord struct {
	// AccountID is the local id of the credential account.
	AccountID string
	// ProviderID identifies the upstream.
	ProviderID string
	// Kind is the credential kind for this record.
	Kind CredentialKind
	// Origin is the safe acquisition metadata for the current material.
	Origin CredentialOrigin
	// AccessFingerprint is the stable non-secret identity of the
	// current access token. Used for compare-and-swap refresh.
	AccessFingerprint string
	// RefreshFingerprint is the stable non-secret identity of the
	// refresh token, if any.
	RefreshFingerprint string
	// ExpiresAt mirrors TokenSet.ExpiresAt for indexing.
	ExpiresAt time.Time
	// Scope is persisted for the admin UI and for round-tripping.
	Scope string
	// ProviderAccountID mirrors TokenSet.ProviderAccountID.
	ProviderAccountID string
	// Email mirrors TokenSet.Email.
	Email string
	// OrgID / OrgName mirror the workspace info.
	OrgID   string
	OrgName string
	// IssuedAt is the wall-clock time the token was minted.
	IssuedAt time.Time
	// ReauthenticationRequired is set after a definitive provider rejection.
	// It is non-secret lifecycle state and prevents repeatedly attempting a
	// known-invalid refresh token.
	ReauthenticationRequired bool
	// Version is a monotonic counter incremented on every successful
	// refresh. Used for compare-and-swap and for race detection.
	Version int64
}

// FromTokenSet projects a TokenSet into a durable OAuthTokenRecord. The
// resulting record contains no token material: only fingerprints and
// metadata. Callers are responsible for storing the underlying Secret
// blobs through the SecretStore.
func (r *OAuthTokenRecord) FromTokenSet(accountID, providerID string, kind CredentialKind, ts *TokenSet, now time.Time) {
	if r == nil {
		return
	}
	r.AccountID = accountID
	r.ProviderID = providerID
	r.Kind = kind
	if ts == nil {
		return
	}
	if !ts.Origin.Valid() {
		ts = ts.Clone()
		ts.Origin = defaultOrigin(kind)
	}
	r.Origin = ts.Origin
	r.AccessFingerprint = ts.Access.Fingerprint()
	if !ts.Refresh.IsZero() {
		r.RefreshFingerprint = ts.Refresh.Fingerprint()
	} else {
		r.RefreshFingerprint = ""
	}
	r.ExpiresAt = ts.ExpiresAt
	r.Scope = ts.Scope
	r.ProviderAccountID = ts.ProviderAccountID
	r.Email = ts.Email
	r.OrgID = ts.OrgID
	r.OrgName = ts.OrgName
	r.IssuedAt = now
}

// DefaultSafetySkew is the recommended pre-expiry window used by the
// runtime to trigger background refresh. 30 seconds mirrors the
// upstream-safety-window convention in the legacy code; the value is
// deliberately small because refresh itself runs on the request path.
const DefaultSafetySkew = 30 * time.Second
