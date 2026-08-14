// File: pool.go
// AD-1 in-memory account pool. Concurrency-safe selection, in-flight
// accounting, and TTL-driven quota reset. All persistence is delegated to a
// caller-supplied AccountStore so the package stays dependency-free.
package proxy

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// AccountState is the runtime health of a single account. Pool mutates the
// state through MarkError / MarkTransient / MarkExhausted; callers read it
// via Snapshot.
type AccountState string

const (
	StateHealthy     AccountState = "healthy"
	StateCoolingDown AccountState = "cooling_down"
	StateExhausted   AccountState = "exhausted"
	StateDisabled    AccountState = "disabled"
	StateError       AccountState = "error"
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

// ErrUnknownAccount is returned when a pool operation references an account
// the pool has never seen.
var ErrUnknownAccount = errors.New("proxy: unknown account")

// DefaultAccountSnapshotTTL bounds durable directory reads on the request
// path while keeping account enable/disable changes visible promptly.
const DefaultAccountSnapshotTTL = 5 * time.Second

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
type AccountStatePersistence interface {
	LoadAccount(ctx context.Context, accountID string) (AccountHealthState, error)
	SaveAccount(ctx context.Context, accountID string, state AccountHealthState) error
	LoadModelLock(ctx context.Context, accountID, modelID string) (ModelLockState, error)
	SaveModelLock(ctx context.Context, accountID, modelID string, state ModelLockState) error
	ClearModelLock(ctx context.Context, accountID, modelID string) error
}

type accountModelLockResetter interface {
	ClearModelLocks(ctx context.Context, accountID string) error
}

type AccountHealthState struct {
	State         AccountState
	CooldownUntil time.Time
	QuotaResetAt  time.Time
	FailureCount  int
	LastFailure   time.Time
}

type ModelLockState struct {
	RetryAt      time.Time
	FailureCount int
}

// PoolConfig configures the AccountPool.
type PoolConfig struct {
	// Store supplies accounts. Required.
	Store AccountStore
	// TTL is the cache lifetime for a provider's account snapshot. A
	// non-positive TTL disables the cache and forces a store hit on every
	// selection.
	TTL time.Duration
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
	store AccountStore
	ttl   time.Duration
	now   func() time.Time

	mu         sync.Mutex
	refreshMu  sync.Mutex
	cache      map[string]providerSnapshot // providerID → snapshot
	lastIndex  map[string]int              // round-robin cursor per provider
	inFlight   map[string]int              // accountID → active count
	states     map[string]*accountRuntime  // accountID → runtime state
	modelLocks map[string]map[string]ModelLockState
	stateStore AccountStatePersistence
}

type providerSnapshot struct {
	accounts  []Account
	fetchedAt time.Time
}

type accountRuntime struct {
	state         AccountState
	lastFailure   time.Time
	failureCount  int
	cooldownUntil time.Time
	inFlight      int
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
	return &AccountPool{
		store:      cfg.Store,
		ttl:        cfg.TTL,
		now:        now,
		cache:      make(map[string]providerSnapshot),
		lastIndex:  make(map[string]int),
		inFlight:   make(map[string]int),
		states:     make(map[string]*accountRuntime),
		modelLocks: make(map[string]map[string]ModelLockState),
		stateStore: cfg.StatePersistence,
	}, nil
}

// GetNext returns the next usable account for providerID using round-robin
// ordering. It refreshes the cache on TTL expiry. Accounts in cooldown or
// marked exhausted are skipped.
func (p *AccountPool) GetNext(ctx context.Context, providerID string) (*Account, error) {
	all, err := p.candidateSet(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, ErrNoAccount
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	cursor := p.lastIndex[providerID]
	for i := range len(all) {
		idx := (cursor + i) % len(all)
		acct := all[idx]
		if p.isSelectableLocked(acct.ID) {
			p.lastIndex[providerID] = (idx + 1) % len(all)
			return &acct, nil
		}
	}
	return nil, ErrNoAccount
}

// GetNextExcluding returns the next usable account for providerID while
// skipping account IDs in excluded. It preserves GetNext's deterministic
// round-robin cursor semantics and only advances the cursor when an account
// is selected.
func (p *AccountPool) GetNextExcluding(ctx context.Context, providerID string, excluded map[string]struct{}) (*Account, error) {
	return p.GetNextExcludingModel(ctx, providerID, "", excluded)
}

// GetNextExcludingModel also observes a durable per-account model lock.
func (p *AccountPool) GetNextExcludingModel(ctx context.Context, providerID, modelID string, excluded map[string]struct{}) (*Account, error) {
	all, err := p.candidateSet(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, ErrNoAccount
	}
	p.hydrateModelLocks(ctx, modelID, all)

	p.mu.Lock()
	defer p.mu.Unlock()

	cursor := p.lastIndex[providerID]
	for i := range len(all) {
		idx := (cursor + i) % len(all)
		acct := all[idx]
		if _, skip := excluded[acct.ID]; skip {
			continue
		}
		if p.isSelectableForModelLocked(acct.ID, modelID) {
			p.lastIndex[providerID] = (idx + 1) % len(all)
			return &acct, nil
		}
	}
	return nil, ErrNoAccount
}

func (p *AccountPool) hydrateModelLocks(ctx context.Context, modelID string, accounts []Account) {
	if p.stateStore == nil || modelID == "" {
		return
	}
	for _, account := range accounts {
		lock, err := p.stateStore.LoadModelLock(ctx, account.ID, modelID)
		if err != nil {
			continue
		}
		p.mu.Lock()
		locks := p.modelLocks[account.ID]
		if lock.RetryAt.IsZero() {
			if locks != nil {
				delete(locks, modelID)
			}
			p.mu.Unlock()
			continue
		}
		if locks == nil {
			locks = make(map[string]ModelLockState)
			p.modelLocks[account.ID] = locks
		}
		if current, exists := locks[modelID]; !exists || !current.RetryAt.After(lock.RetryAt) {
			locks[modelID] = lock
		}
		p.mu.Unlock()
	}
}

// GetByLeastLoad returns the account with the lowest in-flight count among
// usable candidates. Ties resolve by deterministic id ordering.
func (p *AccountPool) GetByLeastLoad(ctx context.Context, providerID string) (*Account, error) {
	all, err := p.candidateSet(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, ErrNoAccount
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	var best *Account
	bestInFlight := -1
	for i := range all {
		acct := &all[i]
		if !p.isSelectableLocked(acct.ID) {
			continue
		}
		load := p.inFlight[acct.ID]
		if best == nil || load < bestInFlight || (load == bestInFlight && acct.ID < best.ID) {
			best = acct
			bestInFlight = load
		}
	}
	if best == nil {
		return nil, ErrNoAccount
	}
	return best, nil
}

// Start records that accountID has begun serving a request. It increments
// the in-flight counter. Start on an unknown account returns ErrUnknownAccount.
func (p *AccountPool) Start(accountID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.states[accountID]; !ok {
		return ErrUnknownAccount
	}
	p.inFlight[accountID]++
	p.states[accountID].inFlight = p.inFlight[accountID]
	return nil
}

// End records that accountID has finished serving a request. It decrements
// the in-flight counter, clamped at zero. End on an unknown account is a
// no-op (callers can recover from panics without bookkeeping issues).
func (p *AccountPool) End(accountID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[accountID]
	if !ok {
		return
	}
	if p.inFlight[accountID] > 0 {
		p.inFlight[accountID]--
	}
	state.inFlight = p.inFlight[accountID]
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
	p.mu.Lock()
	delete(p.states, accountID)
	delete(p.inFlight, accountID)
	delete(p.modelLocks, accountID)
	p.mu.Unlock()
	if resetter, ok := p.stateStore.(accountModelLockResetter); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		_ = resetter.ClearModelLocks(ctx, accountID)
		cancel()
	}
}

// Refresh forces a reload of the provider snapshot, bypassing TTL.
func (p *AccountPool) Refresh(ctx context.Context, providerID string) error {
	p.mu.Lock()
	delete(p.cache, providerID)
	p.mu.Unlock()
	_, err := p.candidateSet(ctx, providerID)
	return err
}

// CheckAndResetDailyQuota walks every tracked account and clears exhaustion
// when QuotaResetAt has elapsed. Designed to be called periodically by the
// runtime; idempotent.
func (p *AccountPool) CheckAndResetDailyQuota(now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	reset := 0
	for id, state := range p.states {
		if state.state != StateExhausted {
			continue
		}
		if !state.cooldownUntil.IsZero() && state.cooldownUntil.After(now) {
			continue
		}
		state.state = StateHealthy
		state.cooldownUntil = time.Time{}
		state.failureCount = 0
		reset++
		_ = id
	}
	return reset
}

// InFlight returns the in-flight count for accountID. Used by metrics and
// tests.
func (p *AccountPool) InFlight(accountID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inFlight[accountID]
}

// Snapshot returns the runtime state of accountID. Returns (StateDisabled,
// nil) for unknown accounts so callers can distinguish "never seen" from
// "currently healthy".
func (p *AccountPool) Snapshot(accountID string) (AccountState, *accountRuntime) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[accountID]
	if !ok {
		return StateDisabled, nil
	}
	return state.state, state
}

// Close is a no-op for the in-memory pool; it exists so callers can write
// symmetric open/close logic without branching on the concrete type.
func (p *AccountPool) Close() error { return nil }

// candidateSet returns the cached or freshly-fetched list of usable
// accounts, sorted by id for determinism.
func (p *AccountPool) candidateSet(ctx context.Context, providerID string) ([]Account, error) {
	p.mu.Lock()
	snap, ok := p.cache[providerID]
	refresh := !ok || p.ttl <= 0 || (p.ttl > 0 && p.now().Sub(snap.fetchedAt) > p.ttl)
	p.mu.Unlock()
	if refresh {
		p.refreshMu.Lock()
		defer p.refreshMu.Unlock()
		p.mu.Lock()
		snap, ok = p.cache[providerID]
		refresh = !ok || p.ttl <= 0 || (p.ttl > 0 && p.now().Sub(snap.fetchedAt) > p.ttl)
		p.mu.Unlock()
		if !refresh {
			return p.selectable(snap.accounts), nil
		}
		fetched, err := p.store.ListAccounts(ctx, providerID)
		if err != nil {
			return nil, err
		}
		sort.Slice(fetched, func(i, j int) bool { return fetched[i].ID < fetched[j].ID })
		p.mu.Lock()
		p.cache[providerID] = providerSnapshot{accounts: append([]Account(nil), fetched...), fetchedAt: p.now()}
		p.mu.Unlock()
		// Register runtime state for newly-seen accounts.
		p.mu.Lock()
		for _, a := range fetched {
			if _, ok := p.states[a.ID]; !ok {
				p.states[a.ID] = &accountRuntime{state: StateHealthy}
			}
		}
		p.mu.Unlock()
		p.hydrateAccountStates(ctx, fetched)
		return p.selectable(fetched), nil
	}
	return p.selectable(snap.accounts), nil
}

func (p *AccountPool) hydrateAccountStates(ctx context.Context, accounts []Account) {
	if p.stateStore == nil {
		return
	}
	for _, account := range accounts {
		state, err := p.stateStore.LoadAccount(ctx, account.ID)
		if err != nil || state.State == "" {
			continue
		}
		p.mu.Lock()
		runtimeState := p.states[account.ID]
		if runtimeState == nil {
			runtimeState = &accountRuntime{}
			p.states[account.ID] = runtimeState
		}
		runtimeState.state = state.State
		runtimeState.cooldownUntil = state.CooldownUntil
		runtimeState.failureCount = state.FailureCount
		runtimeState.lastFailure = state.LastFailure
		p.mu.Unlock()
	}
}

func (p *AccountPool) selectable(in []Account) []Account {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	out := make([]Account, 0, len(in))
	for _, a := range in {
		if !a.Enabled {
			continue
		}
		state, ok := p.states[a.ID]
		if !ok {
			out = append(out, a)
			continue
		}
		if state.state == StateDisabled {
			continue
		}
		if state.state == StateExhausted && !a.QuotaResetAt.IsZero() && a.QuotaResetAt.After(now) {
			continue
		}
		if !state.cooldownUntil.IsZero() && state.cooldownUntil.After(now) {
			continue
		}
		out = append(out, a)
	}
	return out
}

func (p *AccountPool) isSelectableLocked(accountID string) bool {
	state, ok := p.states[accountID]
	if !ok {
		return true
	}
	if state.state == StateDisabled {
		return false
	}
	now := p.now()
	if !state.cooldownUntil.IsZero() && state.cooldownUntil.After(now) {
		return false
	}
	return true
}

func (p *AccountPool) isSelectableForModelLocked(accountID, modelID string) bool {
	if !p.isSelectableLocked(accountID) {
		return false
	}
	if modelID == "" {
		return true
	}
	lock, ok := p.modelLocks[accountID][modelID]
	return !ok || lock.RetryAt.IsZero() || !lock.RetryAt.After(p.now())
}

func (p *AccountPool) markFailure(accountID string, kind FailureKind, base time.Duration) {
	p.mu.Lock()
	state, ok := p.states[accountID]
	if !ok {
		p.mu.Unlock()
		return
	}
	now := p.now()
	state.failureCount++
	state.lastFailure = now
	switch kind {
	case FailureAuthentication:
		state.state = StateError
		state.cooldownUntil = now.Add(accountAuthCooldown)
	case FailureQuota:
		state.state = StateExhausted
		state.cooldownUntil = now.Add(AccountQuotaResetFallback)
		state.failureCount = 0
	case FailureFatal:
		state.state = StateError
		state.cooldownUntil = now.Add(backoff(base, state.failureCount))
	case FailureTransient:
		state.state = StateCoolingDown
		state.cooldownUntil = now.Add(backoff(transientCooldown, state.failureCount))
	default:
		state.state = StateCoolingDown
		state.cooldownUntil = now.Add(backoff(base, state.failureCount))
	}
	snapshot := accountHealthStateLocked(state)
	p.mu.Unlock()
	p.persistAccountState(accountID, snapshot)
}

func (p *AccountPool) markFailureForModel(accountID, modelID string, kind FailureKind, base time.Duration) {
	if modelID == "" {
		p.markFailure(accountID, kind, base)
		return
	}
	if p.stateStore == nil {
		// Development fixtures have no durable lock sidecar; retain the
		// historical process-local account cooldown semantics.
		p.markFailure(accountID, kind, base)
		return
	}
	if kind == FailureAuthentication || kind == FailureFatal || kind == FailureTransient {
		p.markFailure(accountID, kind, base)
		return
	}
	p.mu.Lock()
	if p.modelLocks[accountID] == nil {
		p.modelLocks[accountID] = make(map[string]ModelLockState)
	}
	previous := p.modelLocks[accountID][modelID]
	failures := previous.FailureCount + 1
	lock := ModelLockState{RetryAt: p.now().Add(backoff(base, failures)), FailureCount: failures}
	p.modelLocks[accountID][modelID] = lock
	p.mu.Unlock()
	p.persistModelLock(accountID, modelID, lock)
	_ = kind
}

func accountHealthStateLocked(state *accountRuntime) AccountHealthState {
	return AccountHealthState{State: state.state, CooldownUntil: state.cooldownUntil, FailureCount: state.failureCount, LastFailure: state.lastFailure}
}

func (p *AccountPool) persistAccountState(accountID string, state AccountHealthState) {
	if p.stateStore == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = p.stateStore.SaveAccount(ctx, accountID, state)
}

func (p *AccountPool) persistModelLock(accountID, modelID string, state ModelLockState) {
	if p.stateStore == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = p.stateStore.SaveModelLock(ctx, accountID, modelID, state)
}

func backoff(base time.Duration, attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := base
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= AccountCooldownCap {
			return AccountCooldownCap
		}
	}
	if d > AccountCooldownCap {
		return AccountCooldownCap
	}
	return d
}

// AccountPool tunables. These are exported so the central wiring layer can
// override them at construction time. They are intentionally conservative
// defaults matching the legacy TS traffic module.
const (
	// AccountQuotaResetFallback is used when an account has no explicit
	// QuotaResetAt. Five minutes mirrors the legacy cooldown for quota hits.
	AccountQuotaResetFallback = 5 * time.Minute
	// accountAuthCooldown is how long an account stays cooled after auth
	// failure. The runtime typically refreshes credentials before this
	// expires; otherwise the account re-enters the rotation.
	accountAuthCooldown = 5 * time.Minute
	// accountCooldownOnError is the base cooldown for non-quota, non-auth
	// failures. The pool doubles it per consecutive failure.
	accountCooldownOnError = 30 * time.Second
	// transientCooldown is the base cooldown for transient (5xx, network)
	// failures. Always short — the pool never disables on transient errors.
	transientCooldown = 5 * time.Second
	// AccountCooldownCap caps exponential backoff so an account cannot be
	// parked indefinitely.
	AccountCooldownCap = 30 * time.Minute
)
