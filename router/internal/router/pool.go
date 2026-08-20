// File: pool.go
// AD-1 in-memory account pool. Concurrency-safe selection, in-flight
// accounting, and TTL-driven quota reset. All persistence is delegated to a
// caller-supplied AccountStore so the package stays dependency-free.
package router

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts"
	contracts "github.com/cartethyia/daemon/internal/protocol"
)

// AccountState is the runtime health of a single account. Pool mutates the
// state through MarkError / MarkTransient / MarkExhausted; callers read it
// via Snapshot.
type AccountState = accounts.AccountState

const (
	StateHealthy     = accounts.StateHealthy
	StateCoolingDown = accounts.StateCoolingDown
	StateExhausted   = accounts.StateExhausted
	StateDisabled    = accounts.StateDisabled
	StateError       = accounts.StateError
)

// Account is the runtime view of one provider credential. The pool does not
// own secret material: CredentialRef is an opaque reference the runtime
// resolves through its secret store.
type Account struct {
	ID                string
	Provider          string
	Model             string
	CredentialRef     contracts.CredentialRef
	Enabled           bool
	Email             string
	Name              string
	ProviderAccountID string
	OrgID             string
	OrgName           string
	ProjectID         string
	Region            string
	ReauthRequired    bool
	LastUsedAt        time.Time
	QuotaResetAt      time.Time
}

// ErrNoAccount is returned when no usable account exists for the requested
// provider/model. Callers surface it as a 503.
var ErrNoAccount = errors.New("proxy: no usable account")

// Account snapshot bounds keep durable directory reads off the hot path while
// preventing a failed refresh from serving arbitrarily old account data.
const (
	DefaultAccountSnapshotTTL      = 5 * time.Second
	DefaultAccountSnapshotStaleTTL = 30 * time.Second
	MaxCandidateExclusions         = 32
)

// AccountStore supplies the pool with persisted accounts. The interface is
// intentionally narrow so the central wiring layer can inject a database,
// an in-memory fixture, or a remote cache.
type AccountStore interface {
	// ListAccounts returns every enabled account for a provider. The order
	// is implementation-defined; the pool sorts deterministically.
	ListAccounts(ctx context.Context, providerID string) ([]Account, error)
}

// AccountStatePersistence is the optional durable sidecar for account health
// and per-model locks. Implementations must store only the supplied
// non-secret state; credential material never crosses this boundary.
type AccountStatePersistence = accounts.StatePersistence
type AccountHealthState = accounts.AccountHealthState
type ModelLockState = accounts.ModelLockState

// PoolConfig configures the AccountPool.
type PoolConfig struct {
	// Store supplies accounts. Required.
	Store AccountStore
	// TTL is the cache lifetime for a provider's account snapshot. A
	// non-positive TTL disables the cache and forces a store hit on every
	// selection.
	TTL time.Duration
	// StaleTTL is the additional bounded interval for which the last valid
	// snapshot may be used after TTL expiry when refresh fails. Zero uses the
	// conservative default; a negative value disables stale serving.
	StaleTTL time.Duration
	// Now is the clock used for TTL and quota calculations. When nil,
	// time.Now is used.
	Now func() time.Time
	// StatePersistence is optional outside production. When configured, health
	// and model-lock transitions are written synchronously with bounded
	// contexts and reloaded before selection.
	StatePersistence AccountStatePersistence
}

// AccountPool is the in-memory account pool (AD-1).
type AccountPool struct {
	store    AccountStore
	ttl      time.Duration
	staleTTL time.Duration
	now      func() time.Time

	mu                sync.Mutex
	cache             map[string]providerSnapshot // providerID → snapshot
	refreshes         map[string]*providerRefresh // providerID → active refresh
	lastIndex         map[string]int              // rotating tie cursor per provider
	inFlight          map[string]int              // accountID → active count
	stateOwner        *accounts.StateStore
	// modelLocks is a read-only compatibility view for legacy diagnostics.
	// Selection and persistence always use stateOwner.
	modelLocks map[string]map[string]ModelLockState
}

type providerSnapshot struct {
	accounts      []Account
	fetchedAt     time.Time
	lastRefreshAt time.Time
	degraded      bool
}

type providerRefresh struct {
	done     chan struct{}
	snapshot providerSnapshot
	err      error
}

// SelectionInput is resolved route-plan data. The pool never derives provider
// ownership from request headers or resolves catalog aliases itself.
type SelectionInput struct {
	ProviderID         string
	ModelID            string
	Surface            contracts.Surface
	PolicyGeneration   uint64
	ExcludedAccountIDs map[string]struct{}
}

type ExclusionReason string

const (
	ExclusionDisabled         ExclusionReason = "disabled"
	ExclusionExhausted        ExclusionReason = "exhausted"
	ExclusionCooling          ExclusionReason = "cooling"
	ExclusionModelLocked      ExclusionReason = "model_locked"
	ExclusionAlreadyAttempted ExclusionReason = "already_attempted"
	ExclusionUnavailable      ExclusionReason = "unavailable"
)

// CandidateExclusion is bounded, deterministic, and contains no credential
// material. RetryAt is set only when this candidate can become valid later.
type CandidateExclusion struct {
	AccountID string
	Reason    ExclusionReason
	RetryAt   time.Time
}

// Availability reports why no candidate was selected and when the earliest
// valid candidate may become ready. Exclusions is capped at
// MaxCandidateExclusions while ExcludedCount reports the complete count.
type Availability struct {
	RetryAt          time.Time
	Exclusions       []CandidateExclusion
	ExcludedCount    int
	SnapshotDegraded bool
}

// AccountRuntimeSnapshot is an immutable copy safe for diagnostics and
// concurrent readers.
type AccountRuntimeSnapshot = accounts.RuntimeSnapshot

type ModelLockSnapshot struct {
	ModelID      string
	RetryAt      time.Time
	FailureCount int
}

type DiagnosticAccountSnapshot struct {
	ID             string
	Provider       string
	Model          string
	Enabled        bool
	ReauthRequired bool
	Runtime        AccountRuntimeSnapshot
	ModelLocks     []ModelLockSnapshot
}

type ProviderAccountSnapshot struct {
	ProviderID    string
	FetchedAt     time.Time
	LastRefreshAt time.Time
	StaleUntil    time.Time
	Degraded      bool
	Accounts      []DiagnosticAccountSnapshot
}

// AccountLease owns one account's in-flight increment. Release is idempotent;
// callers transfer the lease to a returned stream instead of also deferring a
// pool decrement.
type AccountLease struct {
	Account Account
	pool    *AccountPool
	once    sync.Once
}

// Release returns the account slot exactly once.
func (l *AccountLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.pool != nil {
			l.pool.release(l.Account.ID)
		}
	})
}

// NewAccountPool constructs an AccountPool. Missing stores are configuration
// errors returned to the caller instead of panics.
func NewAccountPool(cfg PoolConfig) (*AccountPool, error) {
	if cfg.Store == nil {
		return nil, errors.New("proxy: account pool store is required")
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	staleTTL := cfg.StaleTTL
	if staleTTL == 0 {
		staleTTL = DefaultAccountSnapshotStaleTTL
	}
	return &AccountPool{
		store:             cfg.Store,
		ttl:               cfg.TTL,
		staleTTL:          staleTTL,
		now:               now,
		cache:             make(map[string]providerSnapshot),
		refreshes:         make(map[string]*providerRefresh),
		lastIndex:         make(map[string]int),
		inFlight:          make(map[string]int),
		stateOwner:        accounts.NewStateStore(now, cfg.StatePersistence),
		modelLocks:        make(map[string]map[string]ModelLockState),
	}, nil
}

// AcquireCandidate atomically selects and reserves the least-loaded eligible
// account. Equal-load ties follow the provider's rotating cursor. The returned
// lease is the only owner of the matching in-flight increment.
func (p *AccountPool) AcquireCandidate(ctx context.Context, input SelectionInput) (*AccountLease, Availability, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, Availability{}, err
	}
	snapshot, err := p.providerAccounts(ctx, input.ProviderID, false)
	if err != nil {
		return nil, Availability{}, err
	}
	all := snapshot.accounts
	if len(all) == 0 {
		return nil, Availability{SnapshotDegraded: snapshot.degraded}, ErrNoAccount
	}
	p.hydrateModelLocks(ctx, input.ModelID, all)
	if err := ctx.Err(); err != nil {
		return nil, Availability{}, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	cursor := p.lastIndex[input.ProviderID]
	bestIndex := -1
	bestLoad := 0
	bestTier := ReadinessUnknown
	availability := Availability{SnapshotDegraded: snapshot.degraded}
	now := p.now()
	for i := range len(all) {
		idx := (cursor + i) % len(all)
		acct := all[idx]
		eligible, reason, retryAt := p.candidateEligibilityLocked(acct, input, now)
		if !eligible {
			availability.addExclusion(acct.ID, reason, retryAt)
			continue
		}
		load := p.inFlight[acct.ID]
		tier := p.readinessTierLocked(acct.ID, input)
		if bestIndex < 0 || tier > bestTier || (tier == bestTier && load < bestLoad) {
			bestIndex = idx
			bestLoad = load
			bestTier = tier
		}
	}
	if bestIndex < 0 {
		return nil, availability, ErrNoAccount
	}
	if err := ctx.Err(); err != nil {
		return nil, availability, err
	}
	acct := all[bestIndex]
	p.lastIndex[input.ProviderID] = (bestIndex + 1) % len(all)
	p.inFlight[acct.ID]++
	p.stateOwner.SetInFlight(acct.ID, p.inFlight[acct.ID])
	// A cancellation can race with the final reservation. Do not return an
	// owned lease to a canceled attempt, and undo the increment while the pool
	// lock is held so no subsequent selector can observe a phantom in-flight
	// use.
	if err := ctx.Err(); err != nil {
		p.inFlight[acct.ID]--
		p.stateOwner.SetInFlight(acct.ID, p.inFlight[acct.ID])
		// A canceled selection did not become an attempt. Keep the rotating
		// cursor unchanged so cancellation cannot perturb deterministic
		// round-robin order.
		p.lastIndex[input.ProviderID] = cursor
		return nil, availability, err
	}
	return &AccountLease{Account: acct, pool: p}, availability, nil
}

func (p *AccountPool) readinessTierLocked(accountID string, input SelectionInput) ReadinessTier {
	return p.stateOwner.ReadinessTier(accountID, input.ProviderID, input.ModelID, string(input.Surface), input.PolicyGeneration)
}

// MarkReadiness records bounded local/passive readiness evidence.
func (p *AccountPool) MarkReadiness(record ReadinessRecord) {
	if p == nil {
		return
	}
	p.stateOwner.MarkReadiness(accounts.ReadinessRecord{
		AccountID: record.AccountID, ProviderID: record.ProviderID, ModelID: record.ModelID,
		Surface: string(record.Surface), PolicyGeneration: record.PolicyGeneration,
		Tier: record.Tier, Code: record.Code, CheckedAt: record.CheckedAt, RetryAt: record.RetryAt,
	})
}

// ReadinessSnapshot returns immutable records for diagnostics without any
// refresh/acquire/probe side effect.
func (p *AccountPool) ReadinessSnapshot() []ReadinessRecord {
	if p == nil {
		return nil
	}
	records := p.stateOwner.ReadinessSnapshot()
	out := make([]ReadinessRecord, 0, len(records))
	for _, record := range records {
		out = append(out, ReadinessRecord{AccountID: record.AccountID, ProviderID: record.ProviderID, ModelID: record.ModelID,
			Surface: contracts.Surface(record.Surface), PolicyGeneration: record.PolicyGeneration, Tier: record.Tier,
			Code: record.Code, CheckedAt: record.CheckedAt, RetryAt: record.RetryAt})
	}
	return out
}

// AcquireAccount reserves one exact account for a bounded same-account replay.
// It never falls back to another account and each call creates a fresh attempt
// lease, so one lease cannot accidentally span multiple upstream calls.
func (p *AccountPool) AcquireAccount(ctx context.Context, providerID, accountID, modelID string) (*AccountLease, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snapshot, err := p.providerAccounts(ctx, providerID, false)
	if err != nil {
		return nil, err
	}
	all := snapshot.accounts
	p.hydrateModelLocks(ctx, modelID, all)
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	input := SelectionInput{ProviderID: providerID, ModelID: modelID}
	now := p.now()
	for _, acct := range all {
		if acct.ID != accountID {
			continue
		}
		if eligible, _, _ := p.candidateEligibilityLocked(acct, input, now); !eligible {
			return nil, ErrNoAccount
		}
		p.inFlight[acct.ID]++
		p.stateOwner.SetInFlight(acct.ID, p.inFlight[acct.ID])
		if err := ctx.Err(); err != nil {
			p.inFlight[acct.ID]--
			p.stateOwner.SetInFlight(acct.ID, p.inFlight[acct.ID])
			return nil, err
		}
		return &AccountLease{Account: acct, pool: p}, nil
	}
	return nil, ErrNoAccount
}

func (a *Availability) addExclusion(accountID string, reason ExclusionReason, retryAt time.Time) {
	a.ExcludedCount++
	if len(a.Exclusions) < MaxCandidateExclusions {
		a.Exclusions = append(a.Exclusions, CandidateExclusion{AccountID: accountID, Reason: reason, RetryAt: retryAt})
	}
	if !retryAt.IsZero() && (a.RetryAt.IsZero() || retryAt.Before(a.RetryAt)) {
		a.RetryAt = retryAt
	}
}

func (p *AccountPool) candidateEligibilityLocked(account Account, input SelectionInput, now time.Time) (bool, ExclusionReason, time.Time) {
	if !account.Enabled {
		return false, ExclusionDisabled, time.Time{}
	}
	if _, excluded := input.ExcludedAccountIDs[account.ID]; excluded {
		return false, ExclusionAlreadyAttempted, time.Time{}
	}
	if account.ReauthRequired || (account.Provider != "" && account.Provider != input.ProviderID) ||
		(account.Model != "" && input.ModelID != "" && account.Model != input.ModelID) {
		return false, ExclusionUnavailable, time.Time{}
	}
	state, stateSnapshot := p.stateOwner.Snapshot(account.ID)
	if stateSnapshot != nil && state == StateDisabled {
		return false, ExclusionDisabled, time.Time{}
	}

	var retryAt time.Time
	reason := ExclusionCooling
	if readiness, ok := p.stateOwner.Readiness(account.ID, input.ProviderID, input.ModelID, string(input.Surface), input.PolicyGeneration); ok &&
		readiness.Tier == ReadinessUnavailable {
		return false, ExclusionUnavailable, readiness.RetryAt
	}
	if stateSnapshot != nil {
		if stateSnapshot.CooldownUntil.After(now) {
			retryAt = stateSnapshot.CooldownUntil
		}
		if stateSnapshot.State == StateExhausted {
			reason = ExclusionExhausted
			quotaResetAt := stateSnapshot.QuotaResetAt
			if account.QuotaResetAt.After(quotaResetAt) {
				quotaResetAt = account.QuotaResetAt
			}
			if quotaResetAt.After(now) && quotaResetAt.After(retryAt) {
				retryAt = quotaResetAt
			}
			if retryAt.IsZero() && stateSnapshot.CooldownUntil.IsZero() && quotaResetAt.IsZero() {
				return false, ExclusionExhausted, time.Time{}
			}
		}
	}
	if input.ModelID != "" {
		lock, _ := p.stateOwner.ModelLock(account.ID, input.ModelID)
		if lock.RetryAt.After(now) && lock.RetryAt.After(retryAt) {
			retryAt = lock.RetryAt
			reason = ExclusionModelLocked
		}
	}
	if !retryAt.IsZero() {
		return false, reason, retryAt
	}
	return true, "", time.Time{}
}

func (p *AccountPool) hydrateModelLocks(ctx context.Context, modelID string, accounts []Account) {
	if p.stateOwner == nil || modelID == "" {
		return
	}
	for _, account := range accounts {
		p.stateOwner.HydrateModelLock(ctx, account.ID, modelID)
		if lock, ok := p.stateOwner.ModelLock(account.ID, modelID); ok {
			p.mu.Lock()
			if p.modelLocks[account.ID] == nil {
				p.modelLocks[account.ID] = make(map[string]ModelLockState)
			}
			p.modelLocks[account.ID][modelID] = lock
			p.mu.Unlock()
		}
	}
}

func (p *AccountPool) release(accountID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.inFlight[accountID] > 0 {
		p.inFlight[accountID]--
	}
	p.stateOwner.SetInFlight(accountID, p.inFlight[accountID])
}

// MarkError applies a non-quota, non-auth error to an account. The account
// moves into StateError with exponential cooldown. Idempotent.
func (p *AccountPool) MarkError(accountID string) {
	p.markFailure(accountID, FailureFatal, accountCooldownOnError)
}

func (p *AccountPool) MarkErrorForModel(accountID, modelID string) {
	p.markFailureForModel(accountID, modelID, FailureFatal, accountCooldownOnError)
}

// MarkTransient applies a transient failure (network blip, 5xx). The
// account is briefly cooled down but never disabled.
func (p *AccountPool) MarkTransient(accountID string) {
	p.markFailure(accountID, FailureTransient, transientCooldown)
}

func (p *AccountPool) MarkTransientForModel(accountID, modelID string) {
	p.markFailureForModel(accountID, modelID, FailureTransient, transientCooldown)
}

// MarkExhausted applies a quota exhaustion. The account is parked until
// QuotaResetAt (or AccountQuotaResetFallback when unset).
func (p *AccountPool) MarkExhausted(accountID string) {
	p.markFailure(accountID, FailureQuota, AccountQuotaResetFallback)
}

func (p *AccountPool) MarkExhaustedForModel(accountID, modelID string) {
	p.markFailureForModel(accountID, modelID, FailureQuota, AccountQuotaResetFallback)
}

// MarkAuthentication applies a credential rejection. The account is parked
// until the runtime can refresh the credential.
func (p *AccountPool) MarkAuthentication(accountID string) {
	p.markFailure(accountID, FailureAuthentication, accountAuthCooldown)
}

func (p *AccountPool) MarkAuthenticationForModel(accountID, modelID string) {
	p.markFailureForModel(accountID, modelID, FailureAuthentication, accountAuthCooldown)
}

// Reset clears the runtime state for an account (typically called after a
// successful credential refresh). Safe on unknown accounts.
func (p *AccountPool) Reset(accountID string) {
	p.stateOwner.Reset(accountID)
	p.mu.Lock()
	delete(p.modelLocks, accountID)
	p.mu.Unlock()
}

// Refresh forces a reload of the provider snapshot, bypassing TTL.
func (p *AccountPool) Refresh(ctx context.Context, providerID string) error {
	_, err := p.providerAccounts(ctx, providerID, true)
	return err
}

// CheckAndResetDailyQuota walks every tracked account and clears exhaustion
// when QuotaResetAt has elapsed. Designed to be called periodically by the
// runtime; idempotent.
func (p *AccountPool) CheckAndResetDailyQuota(now time.Time) int {
	return p.stateOwner.CheckAndResetDailyQuota(now)
}

// AccountMaintenance returns the bounded account-owned maintenance boundary
// used by schedulers. It does not expose router selection internals.
func (p *AccountPool) AccountMaintenance() accounts.MaintenanceState {
	if p == nil {
		return nil
	}
	return p.stateOwner
}

// InFlight returns the in-flight count for accountID. Used by metrics and
// tests.
func (p *AccountPool) InFlight(accountID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inFlight[accountID]
}

// Snapshot returns an immutable copy of one account's runtime state. Returns
// (StateDisabled, nil) for an account the pool has never seen.
func (p *AccountPool) Snapshot(accountID string) (AccountState, *AccountRuntimeSnapshot) {
	return p.stateOwner.Snapshot(accountID)
}

// ProviderSnapshot returns a non-mutating, credential-free copy of the last
// loaded provider snapshot for diagnostics. It never triggers a refresh.
func (p *AccountPool) ProviderSnapshot(providerID string) (ProviderAccountSnapshot, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	snapshot, ok := p.cache[providerID]
	if !ok {
		return ProviderAccountSnapshot{}, false
	}
	out := ProviderAccountSnapshot{
		ProviderID:    providerID,
		FetchedAt:     snapshot.fetchedAt,
		LastRefreshAt: snapshot.lastRefreshAt,
		StaleUntil:    p.staleUntilLocked(snapshot),
		Degraded:      snapshot.degraded,
		Accounts:      make([]DiagnosticAccountSnapshot, 0, len(snapshot.accounts)),
	}
	for _, account := range snapshot.accounts {
		runtimeSnapshot := AccountRuntimeSnapshot{State: StateHealthy, InFlight: p.inFlight[account.ID], QuotaResetAt: account.QuotaResetAt}
		if _, state := p.stateOwner.Snapshot(account.ID); state != nil {
			runtimeSnapshot = *state
			runtimeSnapshot.InFlight = p.inFlight[account.ID]
		}
		locks := p.stateOwner.ModelLocks(account.ID)
		modelLocks := make([]ModelLockSnapshot, 0, len(locks))
		for modelID, lock := range locks {
			modelLocks = append(modelLocks, ModelLockSnapshot{ModelID: modelID, RetryAt: lock.RetryAt, FailureCount: lock.FailureCount})
		}
		sort.Slice(modelLocks, func(i, j int) bool { return modelLocks[i].ModelID < modelLocks[j].ModelID })
		out.Accounts = append(out.Accounts, DiagnosticAccountSnapshot{
			ID:             account.ID,
			Provider:       account.Provider,
			Model:          account.Model,
			Enabled:        account.Enabled,
			ReauthRequired: account.ReauthRequired,
			Runtime:        runtimeSnapshot,
			ModelLocks:     modelLocks,
		})
	}
	return out, true
}

// Close is a no-op for the in-memory pool; it exists so callers can write
// symmetric open/close logic without branching on the concrete type.
func (p *AccountPool) Close() error { return nil }

// providerAccounts implements per-provider single-flight refresh. A failed
// refresh may serve only the last valid snapshot inside its bounded stale
// window; unrelated providers never share a lock or flight.
func (p *AccountPool) providerAccounts(ctx context.Context, providerID string, force bool) (providerSnapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return providerSnapshot{}, err
	}

	p.mu.Lock()
	now := p.now()
	if snapshot, ok := p.cache[providerID]; ok && !force && p.snapshotFreshLocked(snapshot, now) {
		p.mu.Unlock()
		return snapshot, nil
	}
	if flight := p.refreshes[providerID]; flight != nil {
		done := flight.done
		p.mu.Unlock()
		select {
		case <-done:
			return flight.snapshot, flight.err
		case <-ctx.Done():
			return providerSnapshot{}, ctx.Err()
		}
	}
	flight := &providerRefresh{done: make(chan struct{})}
	p.refreshes[providerID] = flight
	p.mu.Unlock()

	fetched, refreshErr := p.store.ListAccounts(ctx, providerID)
	if refreshErr == nil {
		sort.Slice(fetched, func(i, j int) bool { return fetched[i].ID < fetched[j].ID })
		p.registerAccounts(fetched)
		p.hydrateAccountStates(ctx, fetched)
	}

	p.mu.Lock()
	now = p.now()
	if refreshErr == nil {
		flight.snapshot = providerSnapshot{
			accounts:      append([]Account(nil), fetched...),
			fetchedAt:     now,
			lastRefreshAt: now,
		}
		p.cache[providerID] = flight.snapshot
	} else if snapshot, ok := p.cache[providerID]; ok && ctx.Err() == nil && p.snapshotStaleValidLocked(snapshot, now) {
		snapshot.degraded = true
		snapshot.lastRefreshAt = now
		p.cache[providerID] = snapshot
		flight.snapshot = snapshot
	} else {
		flight.err = refreshErr
		if snapshot, ok := p.cache[providerID]; ok {
			snapshot.degraded = true
			snapshot.lastRefreshAt = now
			p.cache[providerID] = snapshot
		}
	}
	delete(p.refreshes, providerID)
	close(flight.done)
	result, err := flight.snapshot, flight.err
	p.mu.Unlock()
	return result, err
}

func (p *AccountPool) snapshotFreshLocked(snapshot providerSnapshot, now time.Time) bool {
	if p.ttl <= 0 {
		return false
	}
	if snapshot.degraded && !p.snapshotStaleValidLocked(snapshot, now) {
		return false
	}
	reference := snapshot.fetchedAt
	if snapshot.degraded && snapshot.lastRefreshAt.After(reference) {
		reference = snapshot.lastRefreshAt
	}
	return !now.After(reference.Add(p.ttl))
}

func (p *AccountPool) snapshotStaleValidLocked(snapshot providerSnapshot, now time.Time) bool {
	if p.staleTTL < 0 || snapshot.fetchedAt.IsZero() {
		return false
	}
	return !now.After(p.staleUntilLocked(snapshot))
}

func (p *AccountPool) staleUntilLocked(snapshot providerSnapshot) time.Time {
	freshFor := p.ttl
	if freshFor < 0 {
		freshFor = 0
	}
	staleFor := p.staleTTL
	if staleFor < 0 {
		staleFor = 0
	}
	return snapshot.fetchedAt.Add(freshFor + staleFor)
}

func (p *AccountPool) registerAccounts(accounts []Account) {
	for _, account := range accounts {
		p.stateOwner.Ensure(account.ID, account.QuotaResetAt)
		p.stateOwner.SetInFlight(account.ID, p.inFlight[account.ID])
	}
}

func (p *AccountPool) hydrateAccountStates(ctx context.Context, accounts []Account) {
	if p.stateOwner == nil {
		return
	}
	for _, account := range accounts {
		p.stateOwner.Hydrate(ctx, account.ID, account.QuotaResetAt)
	}
}

func (p *AccountPool) markFailure(accountID string, kind FailureKind, base time.Duration) {
	switch kind {
	case FailureAuthentication:
		p.stateOwner.MarkAuthentication(accountID)
	case FailureQuota:
		p.stateOwner.MarkExhausted(accountID)
	case FailureTransient:
		p.stateOwner.MarkTransient(accountID)
	default:
		p.stateOwner.MarkError(accountID)
	}
}

func (p *AccountPool) markFailureForModel(accountID, modelID string, kind FailureKind, base time.Duration) {
	if modelID == "" {
		p.markFailure(accountID, kind, base)
		return
	}
	switch kind {
	case FailureAuthentication:
		p.stateOwner.MarkAuthenticationForModel(accountID, modelID)
	case FailureQuota:
		p.stateOwner.MarkExhaustedForModel(accountID, modelID)
	case FailureTransient:
		p.stateOwner.MarkTransientForModel(accountID, modelID)
	default:
		p.stateOwner.MarkErrorForModel(accountID, modelID)
	}
	if lock, ok := p.stateOwner.ModelLock(accountID, modelID); ok {
		p.mu.Lock()
		if p.modelLocks[accountID] == nil {
			p.modelLocks[accountID] = make(map[string]ModelLockState)
		}
		p.modelLocks[accountID][modelID] = lock
		p.mu.Unlock()
	}
}

// AccountPool tunables. These are exported so the central wiring layer can
// override them at construction time. They are intentionally conservative
// defaults matching the legacy TS traffic module.
const (
	// AccountQuotaResetFallback is used when an account has no explicit
	// QuotaResetAt. Five minutes mirrors the legacy cooldown for quota hits.
	AccountQuotaResetFallback = accounts.QuotaResetFallback
	// accountAuthCooldown is how long an account stays cooled after auth
	// failure. The runtime typically refreshes credentials before this
	// expires; otherwise the account re-enters the rotation.
	accountAuthCooldown = accounts.AuthCooldown
	// accountCooldownOnError is the base cooldown for non-quota, non-auth
	// failures. The pool doubles it per consecutive failure.
	accountCooldownOnError = accounts.CooldownOnError
	// transientCooldown is the base cooldown for transient (5xx, network)
	// failures. Always short — the pool never disables on transient errors.
	transientCooldown = accounts.TransientCooldown
	// AccountCooldownCap caps exponential backoff so an account cannot be
	// parked indefinitely.
	AccountCooldownCap = accounts.CooldownCap
)
