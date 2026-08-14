package accounts

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"
)

// RefreshResult is the typed outcome of a single refresh attempt. The
// shape mirrors the legacy OAuthRefreshResult so callers can pattern
// match on it without unwrapping errors.
type RefreshResult struct {
	// OK is true when the refresh produced a new token set.
	OK bool
	// Token is the fresh token set when OK is true. Callers own
	// the inner Secrets and must Close them when done.
	Token *TokenSet
	// Error is the typed *Error when OK is false. It is always
	// non-nil in the failure case.
	Error *Error
}

// Refresher is the high-level refresh interface used by the proxy hot
// path. It encapsulates "fetch the latest token for an account,
// refreshing if necessary" so the proxy does not have to thread
// timestamps and safety skews through itself.
//
// Implementations MUST be safe to call concurrently for distinct
// account ids. Concurrent calls for the same account id should be
// coalesced to avoid double-refresh; the bundled InMemoryRefresher
// below does this.
type Refresher interface {
	// Current returns the live token set for the account, refreshing
	// it when the access token is within the safety skew of expiry.
	// The returned Token is a defensive copy owned by the caller.
	Current(ctx context.Context, accountID string) (*TokenSet, error)
	// ForceRefresh immediately refreshes, regardless of expiry.
	ForceRefresh(ctx context.Context, accountID string) (*TokenSet, error)
	// Invalidate drops any cached state for the account so the next
	// Current call refetches from the durable store. Used after
	// 401 responses.
	Invalidate(accountID string)
}

// Default refresh tuning. The values are conservative so the
// refresher cannot pin a goroutine indefinitely under any path.
const (
	defaultRefreshTimeout = 30 * time.Second
	defaultMaxAttempts    = 2
	defaultRetryBackoff   = 50 * time.Millisecond
)

type RefresherOptions struct {
	SafetySkew time.Duration
	Driver     AuthDriver
	// DriverResolver selects the provider-specific driver at refresh time.
	// It is preferred over Driver when configured; a missing provider returns
	// an explicit refresh-fatal error rather than falling back to another
	// provider's token endpoint.
	DriverResolver func(providerID string) (AuthDriver, bool)
	Secrets        SecretStore
	Records        RecordStore
	Accounts       AccountConfigStore
	Lease          RefreshLeaseStore
	LeaseTTL       time.Duration
	Now            func() time.Time
	RefreshTimeout time.Duration
	MaxAttempts    int
	RetryBackoff   time.Duration
	// Evidence receives bounded lifecycle transitions. It is never passed
	// token material or provider response bodies.
	Evidence func(RefreshEvidence)
}

type RefreshEvidence struct {
	ProviderID string
	AccountID  string
	Stage      string
	Outcome    string
	Code       string
	Rotated    bool
	StartedAt  time.Time
	EndedAt    time.Time
}

// InMemoryRefresher is the default Refresher. It layers a per-account
// singleflight on top of a Refresher, so concurrent requests for the
// same account share a single upstream refresh call. It does not own
// the driver or stores: those are injected.
type InMemoryRefresher struct {
	driver         AuthDriver
	driverResolver func(providerID string) (AuthDriver, bool)
	secrets        SecretStore
	records        RecordStore
	accounts       AccountConfigStore
	lease          RefreshLeaseStore
	leaseTTL       time.Duration

	safetySkew     time.Duration
	now            func() time.Time
	refreshTimeout time.Duration
	maxAttempts    int
	retryBackoff   time.Duration
	evidence       func(RefreshEvidence)
	mu             sync.Mutex
	pending        map[string]*singleFlight
	live           map[string]*TokenSet
	recordV        map[string]int64
	recordTS       map[string]time.Time
}

// singleFlight owns one in-flight refresh per account id. The lease
// is released exactly once: when the runner goroutine closes `done`
// and removes the entry from the refresher's pending map. Both
// transitions are idempotent so cancellation, retry, or panic cannot
// strand the slot.
type singleFlight struct {
	done chan struct{}
	res  *TokenSet
	err  error
}

// NewInMemoryRefresher constructs a refresher from injected dependencies.
// Every storage boundary is required; absent stores are configuration errors,
// not silent in-memory fallbacks.
func NewInMemoryRefresher(opts RefresherOptions) (*InMemoryRefresher, error) {
	switch {
	case opts.Driver == nil && opts.DriverResolver == nil:
		return nil, NewError(ErrKindInvalidRequest, "", "", errors.New("RefresherOptions.Driver or DriverResolver is required"))
	case opts.Secrets == nil:
		return nil, NewError(ErrKindInvalidRequest, "", "", errors.New("RefresherOptions.Secrets is required"))
	case opts.Records == nil:
		return nil, NewError(ErrKindInvalidRequest, "", "", errors.New("RefresherOptions.Records is required"))
	case opts.Accounts == nil:
		return nil, NewError(ErrKindInvalidRequest, "", "", errors.New("RefresherOptions.Accounts is required"))
	}
	skew := opts.SafetySkew
	if skew <= 0 {
		skew = DefaultSafetySkew
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	timeout := opts.RefreshTimeout
	if timeout <= 0 {
		timeout = defaultRefreshTimeout
	}
	leaseTTL := opts.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = timeout + time.Second
	}
	attempts := opts.MaxAttempts
	if attempts <= 0 {
		attempts = defaultMaxAttempts
	}
	backoff := opts.RetryBackoff
	if backoff <= 0 {
		backoff = defaultRetryBackoff
	}
	evidence := opts.Evidence
	return &InMemoryRefresher{
		driver: opts.Driver, driverResolver: opts.DriverResolver, secrets: opts.Secrets, records: opts.Records,
		accounts: opts.Accounts, lease: opts.Lease, leaseTTL: leaseTTL,
		safetySkew: skew, now: now, refreshTimeout: timeout, maxAttempts: attempts,
		retryBackoff: backoff, evidence: evidence,
		pending: make(map[string]*singleFlight), live: make(map[string]*TokenSet),
		recordV: make(map[string]int64), recordTS: make(map[string]time.Time),
	}, nil
}
func (r *InMemoryRefresher) emitEvidence(ev RefreshEvidence) {
	if r.evidence == nil {
		return
	}
	if len(ev.ProviderID) > 96 {
		ev.ProviderID = ev.ProviderID[:96]
	}
	if len(ev.AccountID) > 96 {
		ev.AccountID = ev.AccountID[:96]
	}
	if len(ev.Stage) > 32 {
		ev.Stage = ev.Stage[:32]
	}
	if len(ev.Outcome) > 48 {
		ev.Outcome = ev.Outcome[:48]
	}
	if len(ev.Code) > 64 {
		ev.Code = ev.Code[:64]
	}
	r.evidence(ev)
}

// Current implements Refresher.
func (r *InMemoryRefresher) Current(ctx context.Context, accountID string) (*TokenSet, error) {
	if accountID == "" {
		return nil, NewError(ErrKindInvalidRequest, "", accountID, errors.New("accountID must not be empty"))
	}
	cached, ok := r.lookup(accountID)
	if ok && !cached.NeedsRefresh(r.now(), r.safetySkew) {
		return cached.Clone(), nil
	}
	return r.refreshSingle(ctx, accountID, false)
}

// ForceRefresh implements Refresher.
func (r *InMemoryRefresher) ForceRefresh(ctx context.Context, accountID string) (*TokenSet, error) {
	if accountID == "" {
		return nil, NewError(ErrKindInvalidRequest, "", accountID, errors.New("accountID must not be empty"))
	}
	return r.refreshSingle(ctx, accountID, true)
}

// Invalidate implements Refresher.
func (r *InMemoryRefresher) Invalidate(accountID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.live, accountID)
	delete(r.recordV, accountID)
	delete(r.recordTS, accountID)
}

func (r *InMemoryRefresher) lookup(accountID string) (*TokenSet, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ts, ok := r.live[accountID]
	if !ok {
		return nil, false
	}
	return ts, true
}

// refreshSingle coalesces concurrent refreshes for the same account id.
// The first caller wins the lease and spawns a detached runner
// goroutine; every other caller waits on the lease's done channel.
// Cancellation of the caller only shortens its own wait — the runner
// continues against a detached context with a bounded timeout so the
// lease is released even if every caller goes away.
func (r *InMemoryRefresher) refreshSingle(ctx context.Context, accountID string, force bool) (*TokenSet, error) {
	r.mu.Lock()
	if pending, ok := r.pending[accountID]; ok {
		r.mu.Unlock()
		select {
		case <-pending.done:
			return cloneTokenSet(pending.res), pending.err
		case <-ctx.Done():
			return nil, NewError(ErrKindRefreshTransient, "", accountID, ctx.Err())
		}
	}
	pending := &singleFlight{done: make(chan struct{})}
	r.pending[accountID] = pending
	r.mu.Unlock()

	// Detach the runner from the caller's cancellation so an
	// in-flight refresh survives the caller going away. The
	// detached ctx still has a hard timeout so a hung driver
	// cannot pin the goroutine indefinitely.
	runnerCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), r.refreshTimeout)
	go func() {
		defer cancel()
		defer close(pending.done)
		ts, err := r.runRefresh(runnerCtx, accountID, force)
		pending.res = ts
		pending.err = err
		r.mu.Lock()
		// Idempotent removal: deleting a missing key is a no-op.
		delete(r.pending, accountID)
		r.mu.Unlock()
	}()
	select {
	case <-pending.done:
		return cloneTokenSet(pending.res), pending.err
	case <-ctx.Done():
		return nil, NewError(ErrKindRefreshTransient, "", accountID, ctx.Err())
	}
}

// runRefresh performs the actual refresh pipeline. It re-reads the
// persisted generation (record Version) before calling the driver,
// coordinates an optional durable lease, and commits the record before
// replacing secrets so a stale refresh cannot overwrite a newer one.
func (r *InMemoryRefresher) runRefresh(ctx context.Context, accountID string, force bool) (*TokenSet, error) {
	started := r.now()
	cfg, err := r.loadAccount(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return nil, NewError(ErrKindInvalidRequest, "", accountID, errors.New("account not configured"))
	}
	r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "started", StartedAt: started})

	record, err := r.loadRecord(ctx, accountID)
	if err != nil {
		return nil, err
	}
	generation := int64(-1)
	if record != nil {
		generation = record.Version
		if record.ReauthenticationRequired {
			return nil, NewError(ErrKindReauthentication, cfg.ProviderID, accountID, errors.New("credential requires reauthentication"))
		}
	}
	refresh, err := r.loadRefresh(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if refresh != nil {
		defer refresh.Close()
	}

	// Access-only credentials explicitly never enter the refresh path.
	if cfg.Kind == KindAccessOnly {
		return r.accessOnly(ctx, cfg, record)
	}
	if refresh == nil || refresh.IsZero() {
		return r.currentWithoutRefresh(ctx, cfg, record)
	}

	var lease RefreshLeaseHandle
	if r.lease != nil {
		var acquired bool
		lease, acquired, err = r.lease.Acquire(ctx, accountID, refresh.Fingerprint(), r.leaseTTL)
		if err != nil {
			return nil, NewError(ErrKindRefreshTransient, cfg.ProviderID, accountID, err)
		}
		if !acquired {
			// A peer may have completed the refresh while we waited for its
			// lease. Prefer its durable result over using a stale token.
			if latest, latestErr := r.loadDurableToken(ctx, cfg, true); latestErr == nil && latest != nil {
				return latest, nil
			}
			return nil, NewError(ErrKindRefreshTransient, cfg.ProviderID, accountID, errors.New("refresh lease unavailable"))
		}
		defer func() {
			_ = lease.Release(context.Background())
		}()
		// Refresh drivers may outlive the initial lease TTL. Renew from a
		// child context so expiry or supersession cancels the attempt before
		// it can commit stale credentials. The loop exits with the attempt.
		attemptCtx, stopAttempt := context.WithCancel(ctx)
		ctx = attemptCtx
		renewInterval := r.leaseTTL / 3
		if renewInterval <= 0 {
			renewInterval = time.Millisecond
		}
		renewDone := make(chan struct{})
		go func() {
			defer close(renewDone)
			ticker := time.NewTicker(renewInterval)
			defer ticker.Stop()
			for {
				select {
				case <-attemptCtx.Done():
					return
				case <-ticker.C:
					ok, renewErr := r.lease.Renew(attemptCtx, accountID, lease.Fence(), r.leaseTTL)
					if renewErr != nil || !ok {
						stopAttempt()
						return
					}
				}
			}
		}()
		defer func() {
			stopAttempt()
			<-renewDone
		}()
	}

	// Bounded retry loop. Fatal / non-transient errors short circuit;
	// transient errors retry with a fixed backoff.
	var fresh *TokenSet
	driver := r.driver
	if r.driverResolver != nil {
		var ok bool
		driver, ok = r.driverResolver(cfg.ProviderID)
		if !ok || driver == nil {
			err := NewError(ErrKindRefreshFatal, cfg.ProviderID, accountID, errors.New("OAuth provider driver is unavailable"))
			r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "provider_unavailable", Code: string(ErrKindRefreshFatal), StartedAt: started, EndedAt: r.now()})
			return nil, err
		}
	}
	if driver == nil {
		return nil, NewError(ErrKindRefreshFatal, cfg.ProviderID, accountID, errors.New("OAuth provider driver is unavailable"))
	}
	for attempt := 1; attempt <= r.maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "transient", Code: string(ErrKindRefreshTransient), StartedAt: started, EndedAt: r.now()})
			return nil, NewError(ErrKindRefreshTransient, cfg.ProviderID, accountID, err)
		}
		fresh, err = driver.Refresh(ctx, RefreshTokenInput{ProviderID: cfg.ProviderID, AccountID: accountID, RefreshToken: refresh})
		if err == nil {
			break
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "transient", Code: string(ErrKindRefreshTransient), StartedAt: started, EndedAt: r.now()})
			return nil, NewError(ErrKindRefreshTransient, cfg.ProviderID, accountID, err)
		}
		if !isTransient(err) {
			redacted := redactError(err, cfg.ProviderID, accountID)
			if Classify(redacted) == ErrKindReauthentication {
				r.markReauthentication(ctx, cfg, record, generation)
				r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "reauthentication_required", Code: string(Classify(redacted)), StartedAt: started, EndedAt: r.now()})
			} else {
				r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "terminal", Code: string(Classify(redacted)), StartedAt: started, EndedAt: r.now()})
			}
			return nil, redacted
		}
		if attempt == r.maxAttempts {
			redacted := redactError(err, cfg.ProviderID, accountID)
			r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "transient", Code: string(Classify(redacted)), StartedAt: started, EndedAt: r.now()})
			return nil, redacted
		}
		select {
		case <-ctx.Done():
			return nil, NewError(ErrKindRefreshTransient, cfg.ProviderID, accountID, ctx.Err())
		case <-time.After(r.retryBackoff):
		}
	}
	if fresh == nil || !fresh.Valid() {
		r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "terminal", Code: string(ErrKindRefreshFatal), StartedAt: started, EndedAt: r.now()})
		return nil, NewError(ErrKindRefreshFatal, cfg.ProviderID, accountID, errors.New("driver returned an empty token set"))
	}
	rotated := fresh.Refresh != nil && !fresh.Refresh.IsZero()
	merged := mergeRefreshMetadata(fresh, refresh, record, cfg.Kind, r.now())
	fresh.Access.Close()
	if fresh.Refresh != nil {
		fresh.Refresh.Close()
	}

	// Durable stores that implement RefreshCommitter atomically fence the
	// lease, record generation, and encrypted secret slots. The legacy path is
	// retained only for explicitly process-local/test stores.
	if committer, ok := r.records.(RefreshCommitter); ok && lease != nil {
		var refreshSecret *Secret
		if rotated {
			refreshSecret = NewSecret(merged.Refresh.Reveal())
		}
		if err := committer.CommitRefresh(ctx, generation, lease.Fence(), mergedRecord(accountID, cfg, merged, r.now(), generation), NewSecret(merged.Access.Reveal()), refreshSecret); err != nil {
			merged.Close()
			if errors.Is(err, ErrVersionMismatch) {
				latest, latestErr := r.loadDurableToken(ctx, cfg, true)
				if latestErr != nil {
					return nil, latestErr
				}
				if latest != nil {
					return latest, nil
				}
			}
			return nil, err
		}
	} else {
		if err := r.commitRecord(ctx, accountID, cfg, merged, generation); err != nil {
			merged.Close()
			if errors.Is(err, ErrVersionMismatch) {
				latest, latestErr := r.loadDurableToken(ctx, cfg, true)
				if latestErr != nil {
					return nil, latestErr
				}
				if latest != nil {
					return latest, nil
				}
			}
			return nil, err
		}
		if err := r.persistAccess(ctx, accountID, merged); err != nil {
			merged.Close()
			return nil, err
		}
		if rotated {
			if err := r.persistRefresh(ctx, accountID, merged.Refresh); err != nil {
				merged.Close()
				return nil, err
			}
		}
	}
	r.emitEvidence(RefreshEvidence{ProviderID: cfg.ProviderID, AccountID: accountID, Stage: "refresh", Outcome: "success", Rotated: rotated, StartedAt: started, EndedAt: r.now()})
	result := merged.Clone()
	r.cacheLive(accountID, merged)
	merged.Close()
	return result, nil
}

func (r *InMemoryRefresher) currentWithoutRefresh(ctx context.Context, cfg *AccountConfig, record *OAuthTokenRecord) (*TokenSet, error) {
	if record != nil && record.ReauthenticationRequired {
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("credential requires reauthentication"))
	}
	if record != nil && !record.ExpiresAt.IsZero() &&
		(cfg.Kind == KindOAuth || cfg.Kind == KindDevice) &&
		!r.now().Before(record.ExpiresAt) {
		r.markReauthentication(ctx, cfg, record, record.Version)
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("credential expired without refresh token"))
	}
	return r.loadDurableToken(ctx, cfg, false)
}

func (r *InMemoryRefresher) accessOnly(ctx context.Context, cfg *AccountConfig, record *OAuthTokenRecord) (*TokenSet, error) {
	token, err := r.loadDurableToken(ctx, cfg, false)
	if err != nil || token == nil {
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("access-only credential requires reauthentication"))
	}
	if record != nil && !record.ExpiresAt.IsZero() && !r.now().Before(record.ExpiresAt) {
		token.Close()
		r.markReauthentication(ctx, cfg, record, record.Version)
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("access-only credential expired"))
	}
	return token, nil
}

func (r *InMemoryRefresher) loadDurableToken(ctx context.Context, cfg *AccountConfig, preserveRefresh bool) (*TokenSet, error) {
	access, err := r.loadAccess(ctx, cfg.ID)
	if err != nil {
		return nil, err
	}
	if access == nil || access.IsZero() {
		if access != nil {
			access.Close()
		}
		return nil, NewError(ErrKindReauthentication, cfg.ProviderID, cfg.ID, errors.New("credential material is unavailable"))
	}
	record, recordErr := r.loadRecord(ctx, cfg.ID)
	if recordErr != nil {
		access.Close()
		return nil, recordErr
	}
	token := &TokenSet{Access: access, Origin: defaultOrigin(cfg.Kind)}
	if record != nil {
		token.ExpiresAt = record.ExpiresAt
		token.Scope = record.Scope
		token.ProviderAccountID = record.ProviderAccountID
		token.Email = record.Email
		token.OrgID = record.OrgID
		token.OrgName = record.OrgName
		if record.Origin.Valid() {
			token.Origin = record.Origin
		}
	}
	if preserveRefresh {
		if refresh, refreshErr := r.loadRefresh(ctx, cfg.ID); refreshErr == nil {
			token.Refresh = refresh
		}
	}
	r.cacheLive(cfg.ID, token)
	return token, nil
}

func mergeRefreshMetadata(fresh *TokenSet, oldRefresh *Secret, record *OAuthTokenRecord, kind CredentialKind, now time.Time) *TokenSet {
	out := fresh.Clone()
	if !out.Origin.Valid() {
		out.Origin = defaultOrigin(kind)
	}
	if out.Refresh.IsZero() && oldRefresh != nil && !oldRefresh.IsZero() {
		out.Refresh = NewSecret(oldRefresh.Reveal())
	}
	if record != nil {
		if out.Scope == "" {
			out.Scope = record.Scope
		}
		if out.ProviderAccountID == "" {
			out.ProviderAccountID = record.ProviderAccountID
		}
		if out.Email == "" {
			out.Email = record.Email
		}
		if out.OrgID == "" {
			out.OrgID = record.OrgID
		}
		if out.OrgName == "" {
			out.OrgName = record.OrgName
		}
	}
	return out
}

// isTransient reports whether err carries the refresh-transient
// classification. Only typed *Error values are inspected; unknown
func isTransient(err error) bool {
	if err == nil {
		return false
	}
	var ae *Error
	if errors.As(err, &ae) {
		return ae.Reason == ErrKindRefreshTransient
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

// redactError coerces err into a typed *Error whose string form is
// guaranteed not to leak credential material. The cause is replaced
// with a sanitized summary that carries only the *Error's
// classification; any other wrapped cause is dropped.
func redactError(err error, providerID, accountID string) *Error {
	if err == nil {
		return nil
	}
	var ae *Error
	if errors.As(err, &ae) {
		return &Error{
			ProviderID: providerID,
			AccountID:  accountID,
			Reason:     ae.Reason,
			Cause:      errors.New(redactString(ae.Cause)),
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return NewError(ErrKindRefreshTransient, providerID, accountID, errors.New("network refresh failed"))
	}
	return NewError(ErrKindRefreshFatal, providerID, accountID, errors.New("driver refresh failed"))
}

// drops the original error message because unknown errors may carry
// credential material we cannot inspect. The caller still sees the
// kind classification through the typed *Error wrapper.
func redactString(cause error) string {
	if cause == nil {
		return "driver refresh failed"
	}
	return "driver refresh failed"
}

func (r *InMemoryRefresher) loadAccount(ctx context.Context, accountID string) (*AccountConfig, error) {
	cfg, err := r.accounts.Get(ctx, accountID)
	if errors.Is(err, ErrAccountNotFound) {
		return nil, NewError(ErrKindInvalidRequest, "", accountID, err)
	}
	return cfg, err
}

func (r *InMemoryRefresher) loadAccess(ctx context.Context, accountID string) (*Secret, error) {
	secret, err := r.secrets.GetAccess(ctx, accountID)
	if errors.Is(err, ErrSecretNotFound) {
		return nil, nil
	}
	return secret, err
}

func (r *InMemoryRefresher) loadRefresh(ctx context.Context, accountID string) (*Secret, error) {
	secret, err := r.secrets.GetRefresh(ctx, accountID)
	if errors.Is(err, ErrSecretNotFound) {
		return nil, nil
	}
	return secret, err
}

func (r *InMemoryRefresher) loadRecord(ctx context.Context, accountID string) (*OAuthTokenRecord, error) {
	record, err := r.records.Get(ctx, accountID)
	if errors.Is(err, ErrRecordNotFound) {
		return nil, nil
	}
	return record, err
}

func (r *InMemoryRefresher) persistAccess(ctx context.Context, accountID string, ts *TokenSet) error {
	if ts == nil || !ts.Valid() {
		return NewError(ErrKindInvalidRequest, "", accountID, errors.New("token set is required"))
	}
	return r.secrets.PutAccess(ctx, accountID, NewSecret(ts.Access.Reveal()))
}

func (r *InMemoryRefresher) persistRefresh(ctx context.Context, accountID string, secret *Secret) error {
	if secret == nil || secret.IsZero() {
		return nil
	}
	return r.secrets.PutRefresh(ctx, accountID, NewSecret(secret.Reveal()))
}

// commitRecord writes the new record under CAS so a stale generation cannot
// overwrite a fresher one. Version mismatch is returned so the caller can
// reconcile with the winning peer.
func (r *InMemoryRefresher) commitRecord(ctx context.Context, accountID string, cfg *AccountConfig, ts *TokenSet, expectedVersion int64) error {
	rec := &OAuthTokenRecord{}
	rec.FromTokenSet(accountID, cfg.ProviderID, cfg.Kind, ts, r.now())
	rec.Version = expectedVersion + 1
	if err := r.records.CompareAndSwap(ctx, expectedVersion, rec); err != nil {
		if errors.Is(err, ErrVersionMismatch) {
			return NewError(ErrKindStorage, cfg.ProviderID, accountID, ErrVersionMismatch)
		}
		return NewError(ErrKindStorage, cfg.ProviderID, accountID, err)
	}
	r.mu.Lock()
	r.recordV[accountID] = rec.Version
	r.mu.Unlock()
	return nil
}

func mergedRecord(accountID string, cfg *AccountConfig, ts *TokenSet, now time.Time, version int64) *OAuthTokenRecord {
	record := &OAuthTokenRecord{}
	record.FromTokenSet(accountID, cfg.ProviderID, cfg.Kind, ts, now)
	record.Version = version
	return record
}
func (r *InMemoryRefresher) markReauthentication(ctx context.Context, cfg *AccountConfig, record *OAuthTokenRecord, expectedVersion int64) {
	if cfg == nil || record == nil {
		return
	}
	marked := *record
	marked.ReauthenticationRequired = true
	marked.Version = expectedVersion + 1
	_ = r.records.CompareAndSwap(ctx, expectedVersion, &marked)
	r.mu.Lock()
	delete(r.live, cfg.ID)
	delete(r.recordV, cfg.ID)
	r.mu.Unlock()
}

func (r *InMemoryRefresher) cacheLive(accountID string, ts *TokenSet) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.live[accountID] = ts.Clone()
	r.recordTS[accountID] = r.now()
}

// cachedGeneration returns the last-known record Version for the
// account, or -1 if we have no local view. The first refresh path
// always re-reads; this is the optimistic starting point used when
// the durable store is unavailable.
func (r *InMemoryRefresher) cachedGeneration(accountID string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.recordV[accountID]; ok {
		return v
	}
	return -1
}

// Now exposes the clock for tests.
func (r *InMemoryRefresher) Now() time.Time { return r.now() }

// SafetySkew exposes the configured skew for tests.
func (r *InMemoryRefresher) SafetySkew() time.Duration { return r.safetySkew }

// MaxAttempts exposes the configured retry cap for tests.
func (r *InMemoryRefresher) MaxAttempts() int { return r.maxAttempts }

// PendingLen returns the number of active leases; for tests.
func (r *InMemoryRefresher) PendingLen() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

func cloneTokenSet(in *TokenSet) *TokenSet {
	if in == nil {
		return nil
	}
	return in.Clone()
}
