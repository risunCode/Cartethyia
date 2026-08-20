package accounts

import (
	"context"
	"sync"
	"time"
)

// AccountState is the deterministic runtime eligibility state of an account.
type AccountState string

const (
	StateHealthy     AccountState = "healthy"
	StateCoolingDown AccountState = "cooling_down"
	StateExhausted   AccountState = "exhausted"
	StateDisabled    AccountState = "disabled"
	StateError       AccountState = "error"
)

// AccountHealthState is the durable account-level health and quota snapshot.
type AccountHealthState struct {
	State         AccountState
	CooldownUntil time.Time
	QuotaResetAt  time.Time
	FailureCount  int
	LastFailure   time.Time
}

// ModelLockState is the durable per-account/model cooldown snapshot.
type ModelLockState struct {
	RetryAt      time.Time
	FailureCount int
}

// StatePersistence is the account-owned durable sidecar contract.
type StatePersistence interface {
	LoadAccount(context.Context, string) (AccountHealthState, error)
	SaveAccount(context.Context, string, AccountHealthState) error
	LoadModelLock(context.Context, string, string) (ModelLockState, error)
	SaveModelLock(context.Context, string, string, ModelLockState) error
	ClearModelLock(context.Context, string, string) error
}

type modelLockResetter interface {
	ClearModelLocks(context.Context, string) error
}

// ReadinessTier is bounded passive readiness evidence, not a health score.
type ReadinessTier uint8

const (
	ReadinessUnknown ReadinessTier = iota
	ReadinessStale
	ReadinessReady
	ReadinessUnavailable
)

func (t ReadinessTier) String() string {
	switch t {
	case ReadinessReady:
		return "ready"
	case ReadinessStale:
		return "stale"
	case ReadinessUnavailable:
		return "unavailable"
	default:
		return "unknown"
	}
}

// ReadinessRecord is immutable, credential-free account selection evidence.
type ReadinessRecord struct {
	AccountID        string
	ProviderID       string
	ModelID          string
	Surface          string
	PolicyGeneration uint64
	Tier             ReadinessTier
	Code             string
	CheckedAt        time.Time
	RetryAt          time.Time
}

// RuntimeSnapshot is an immutable health/quota snapshot for diagnostics and selection.
type RuntimeSnapshot struct {
	State         AccountState
	LastFailure   time.Time
	FailureCount  int
	CooldownUntil time.Time
	QuotaResetAt  time.Time
	InFlight      int
}

// AccountRuntimeSnapshot is the descriptive public name used by diagnostics.
type AccountRuntimeSnapshot = RuntimeSnapshot

type runtimeState struct {
	health       AccountHealthState
	localVersion uint64
	inFlight     int
}

// StateStore is the sole owner of account health, quota, cooldown, model-lock,
// and readiness transitions. Router selection may read snapshots but does not
// mutate these maps directly.
type StateStore struct {
	mu                sync.Mutex
	now               func() time.Time
	persistence       StatePersistence
	states            map[string]*runtimeState
	modelLocks        map[string]map[string]ModelLockState
	modelLockVersions map[string]map[string]uint64
	modelResetVersion map[string]uint64
	readiness         map[string]ReadinessRecord
	readinessLeases   map[string]time.Time
}

const (
	QuotaResetFallback = 5 * time.Minute
	AuthCooldown       = 5 * time.Minute
	CooldownOnError    = 30 * time.Second
	TransientCooldown  = 5 * time.Second
	CooldownCap        = 30 * time.Minute
	AccountQuotaResetFallback = QuotaResetFallback
	AccountCooldownCap = CooldownCap
)

func NewStateStore(now func() time.Time, persistence StatePersistence) *StateStore {
	if now == nil {
		now = time.Now
	}
	return &StateStore{
		now: now, persistence: persistence,
		states: make(map[string]*runtimeState),
		modelLocks: make(map[string]map[string]ModelLockState),
		modelLockVersions: make(map[string]map[string]uint64),
		modelResetVersion: make(map[string]uint64),
		readiness: make(map[string]ReadinessRecord),
		readinessLeases: make(map[string]time.Time),
	}
}

func (s *StateStore) AcquireReadinessLease(accountID string, ttl time.Duration) bool {
	if s == nil || accountID == "" { return false }
	s.mu.Lock(); defer s.mu.Unlock()
	now := s.now()
	if until := s.readinessLeases[accountID]; until.After(now) { return false }
	s.readinessLeases[accountID] = now.Add(ttl)
	return true
}

func (s *StateStore) ReleaseReadinessLease(accountID string) {
	if s == nil { return }
	s.mu.Lock(); delete(s.readinessLeases, accountID); s.mu.Unlock()
}

// Ensure registers an account and updates its durable quota reset input.
func (s *StateStore) Ensure(accountID string, quotaResetAt time.Time) {
	if s == nil || accountID == "" { return }
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	if state == nil {
		state = &runtimeState{health: AccountHealthState{State: StateHealthy}}
		s.states[accountID] = state
	}
	state.health.QuotaResetAt = quotaResetAt
	state.inFlight = state.inFlight
}

func (s *StateStore) SetInFlight(accountID string, count int) {
	if s == nil || accountID == "" { return }
	s.mu.Lock(); defer s.mu.Unlock()
	state := s.states[accountID]
	if state == nil { state = &runtimeState{health: AccountHealthState{State: StateHealthy}}; s.states[accountID] = state }
	state.inFlight = count
}

func (s *StateStore) Snapshot(accountID string) (AccountState, *RuntimeSnapshot) {
	if s == nil { return StateDisabled, nil }
	s.mu.Lock(); defer s.mu.Unlock()
	state, ok := s.states[accountID]
	if !ok { return StateDisabled, nil }
	snapshot := runtimeSnapshot(state)
	return state.health.State, &snapshot
}

func (s *StateStore) Health(accountID string) (AccountHealthState, bool) {
	if s == nil { return AccountHealthState{}, false }
	s.mu.Lock(); defer s.mu.Unlock()
	state, ok := s.states[accountID]
	if !ok { return AccountHealthState{}, false }
	return state.health, true
}

// Hydrate loads durable state only if no local transition won the race.
func (s *StateStore) Hydrate(ctx context.Context, accountID string, quotaResetAt time.Time) {
	if s == nil || s.persistence == nil || accountID == "" { return }
	s.mu.Lock()
	state := s.states[accountID]
	if state == nil { state = &runtimeState{health: AccountHealthState{State: StateHealthy, QuotaResetAt: quotaResetAt}}; s.states[accountID] = state }
	version := state.localVersion
	s.mu.Unlock()
	loaded, err := s.persistence.LoadAccount(ctx, accountID)
	if err != nil || loaded.State == "" { return }
	s.mu.Lock(); defer s.mu.Unlock()
	state = s.states[accountID]
	if state == nil || state.localVersion != version { return }
	if loaded.QuotaResetAt.IsZero() { loaded.QuotaResetAt = quotaResetAt }
	state.health = loaded
}

func (s *StateStore) transition(accountID string, kind AccountState, cooldown time.Duration, quota bool) {
	if s == nil { return }
	s.mu.Lock()
	state := s.states[accountID]
	if state == nil { s.mu.Unlock(); return }
	now := s.now()
	state.localVersion++
	state.health.FailureCount++
	state.health.LastFailure = now
	switch {
	case quota:
		state.health.State = StateExhausted
		state.health.CooldownUntil = state.health.QuotaResetAt
		if !state.health.CooldownUntil.After(now) { state.health.CooldownUntil = now.Add(QuotaResetFallback) }
		state.health.FailureCount = 0
	case kind == StateError:
		state.health.State = StateError
		state.health.CooldownUntil = now.Add(backoff(cooldown, state.health.FailureCount))
	default:
		state.health.State = kind
		state.health.CooldownUntil = now.Add(backoff(cooldown, state.health.FailureCount))
	}
	health := state.health
	s.mu.Unlock()
	s.persistAccount(accountID, health)
}

func (s *StateStore) MarkError(accountID string) { s.transition(accountID, StateError, CooldownOnError, false) }
func (s *StateStore) MarkTransient(accountID string) { s.transition(accountID, StateCoolingDown, TransientCooldown, false) }
func (s *StateStore) MarkExhausted(accountID string) { s.transition(accountID, StateExhausted, QuotaResetFallback, true) }
func (s *StateStore) MarkAuthentication(accountID string) { s.transition(accountID, StateError, AuthCooldown, false) }

func (s *StateStore) Reset(accountID string) {
	if s == nil { return }
	s.mu.Lock()
	state := s.states[accountID]
	if state == nil { s.mu.Unlock(); return }
	state.health.State = StateHealthy; state.health.LastFailure = time.Time{}; state.health.FailureCount = 0; state.health.CooldownUntil = time.Time{}; state.health.QuotaResetAt = time.Time{}; state.localVersion++
	health := state.health
	delete(s.modelLocks, accountID); s.modelResetVersion[accountID]++
	s.mu.Unlock()
	s.persistAccount(accountID, health)
	if resetter, ok := s.persistence.(modelLockResetter); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond); _ = resetter.ClearModelLocks(ctx, accountID); cancel()
	}
}

func (s *StateStore) CheckAndResetDailyQuota(now time.Time) int {
	if s == nil { return 0 }
	s.mu.Lock()
	updates := make(map[string]AccountHealthState)
	for id, state := range s.states {
		if state.health.State != StateExhausted || (!state.health.CooldownUntil.IsZero() && state.health.CooldownUntil.After(now)) { continue }
		state.health.State = StateHealthy; state.health.CooldownUntil = time.Time{}; state.health.QuotaResetAt = time.Time{}; state.health.FailureCount = 0; state.localVersion++
		updates[id] = state.health
	}
	s.mu.Unlock()
	for id, health := range updates { s.persistAccount(id, health) }
	return len(updates)
}

func readinessKey(accountID, providerID, modelID, surface string, generation uint64) string {
	return accountID + "\x00" + providerID + "\x00" + modelID + "\x00" + surface + "\x00" + formatGeneration(generation)
}

func formatGeneration(generation uint64) string {
	if generation == 0 { return "0" }
	var b [20]byte; i := len(b)
	for generation > 0 { i--; b[i] = byte('0' + generation%10); generation /= 10 }
	return string(b[i:])
}

func (s *StateStore) MarkReadiness(record ReadinessRecord) {
	if s == nil || record.AccountID == "" || record.ProviderID == "" || record.ModelID == "" { return }
	s.mu.Lock(); s.readiness[readinessKey(record.AccountID, record.ProviderID, record.ModelID, record.Surface, record.PolicyGeneration)] = record; s.mu.Unlock()
}
func (s *StateStore) ReadinessSnapshot() []ReadinessRecord {
	if s == nil { return nil }
	s.mu.Lock(); defer s.mu.Unlock()
	out := make([]ReadinessRecord, 0, len(s.readiness)); for _, record := range s.readiness { out = append(out, record) }; return out
}
func (s *StateStore) Readiness(accountID, providerID, modelID, surface string, generation uint64) (ReadinessRecord, bool) {
	if s == nil { return ReadinessRecord{}, false }
	s.mu.Lock(); defer s.mu.Unlock(); record, ok := s.readiness[readinessKey(accountID, providerID, modelID, surface, generation)]; return record, ok
}
func (s *StateStore) ReadinessTier(accountID, providerID, modelID, surface string, generation uint64) ReadinessTier {
	record, ok := s.Readiness(accountID, providerID, modelID, surface, generation); if !ok { return ReadinessUnknown }
	if record.Tier == ReadinessReady && !record.RetryAt.IsZero() && record.RetryAt.After(s.now()) { return ReadinessStale }; return record.Tier
}

func (s *StateStore) ModelLock(accountID, modelID string) (ModelLockState, bool) {
	if s == nil { return ModelLockState{}, false }
	s.mu.Lock(); defer s.mu.Unlock(); lock, ok := s.modelLocks[accountID][modelID]; return lock, ok
}
func (s *StateStore) ModelLocks(accountID string) map[string]ModelLockState {
	if s == nil { return nil }
	s.mu.Lock(); defer s.mu.Unlock()
	source := s.modelLocks[accountID]
	if len(source) == 0 { return nil }
	out := make(map[string]ModelLockState, len(source))
	for modelID, lock := range source { out[modelID] = lock }
	return out
}
func (s *StateStore) HydrateModelLock(ctx context.Context, accountID, modelID string) {
	if s == nil || s.persistence == nil || modelID == "" { return }
	s.mu.Lock(); version := s.modelLockVersions[accountID][modelID]; reset := s.modelResetVersion[accountID]; s.mu.Unlock()
	lock, err := s.persistence.LoadModelLock(ctx, accountID, modelID); if err != nil || lock.RetryAt.IsZero() { return }
	s.mu.Lock(); defer s.mu.Unlock()
	if s.modelLockVersions[accountID][modelID] != version || s.modelResetVersion[accountID] != reset { return }
	locks := s.modelLocks[accountID]; if locks == nil { locks = make(map[string]ModelLockState); s.modelLocks[accountID] = locks }
	if current, exists := locks[modelID]; !exists || !current.RetryAt.After(lock.RetryAt) { locks[modelID] = lock }
}
func (s *StateStore) MarkModelLock(accountID, modelID string, retryAt time.Time, failureCount int) {
	if s == nil || accountID == "" || modelID == "" { return }
	s.mu.Lock(); if s.modelLocks[accountID] == nil { s.modelLocks[accountID] = make(map[string]ModelLockState) }; if s.modelLockVersions[accountID] == nil { s.modelLockVersions[accountID] = make(map[string]uint64) }; s.modelLockVersions[accountID][modelID]++; lock := ModelLockState{RetryAt: retryAt, FailureCount: failureCount}; s.modelLocks[accountID][modelID] = lock; s.mu.Unlock(); s.persistModelLock(accountID, modelID, lock)
}
func (s *StateStore) ClearModelLock(accountID, modelID string) {
	if s == nil { return }
	s.mu.Lock(); if locks := s.modelLocks[accountID]; locks != nil { delete(locks, modelID) }; if s.modelLockVersions[accountID] == nil { s.modelLockVersions[accountID] = make(map[string]uint64) }; s.modelLockVersions[accountID][modelID]++; s.mu.Unlock()
	if s.persistence != nil { ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond); _ = s.persistence.ClearModelLock(ctx, accountID, modelID); cancel() }
}
func (s *StateStore) MarkErrorForModel(accountID, modelID string) { s.markModel(accountID, modelID, CooldownOnError) }
func (s *StateStore) MarkTransientForModel(accountID, modelID string) { s.markModel(accountID, modelID, TransientCooldown) }
func (s *StateStore) MarkExhaustedForModel(accountID, modelID string) { s.markModel(accountID, modelID, QuotaResetFallback) }
func (s *StateStore) MarkAuthenticationForModel(accountID, modelID string) { s.markModel(accountID, modelID, AuthCooldown) }
func (s *StateStore) markModel(accountID, modelID string, base time.Duration) { if modelID == "" { return }; s.mu.Lock(); failures := s.modelLocks[accountID][modelID].FailureCount + 1; s.mu.Unlock(); s.MarkModelLock(accountID, modelID, s.now().Add(backoff(base, failures)), failures) }

func (s *StateStore) persistAccount(accountID string, health AccountHealthState) { if s.persistence == nil { return }; ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond); _ = s.persistence.SaveAccount(ctx, accountID, health); cancel() }
func (s *StateStore) persistModelLock(accountID, modelID string, lock ModelLockState) { if s.persistence == nil { return }; ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond); _ = s.persistence.SaveModelLock(ctx, accountID, modelID, lock); cancel() }
func runtimeSnapshot(state *runtimeState) RuntimeSnapshot { return RuntimeSnapshot{State: state.health.State, LastFailure: state.health.LastFailure, FailureCount: state.health.FailureCount, CooldownUntil: state.health.CooldownUntil, QuotaResetAt: state.health.QuotaResetAt, InFlight: state.inFlight} }
func backoff(base time.Duration, attempt int) time.Duration { if attempt < 1 { attempt = 1 }; d := base; for i := 1; i < attempt; i++ { d *= 2; if d >= CooldownCap { return CooldownCap } }; if d > CooldownCap { return CooldownCap }; return d }
