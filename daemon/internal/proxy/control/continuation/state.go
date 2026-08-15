package continuation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Code is the machine-readable continuation failure code. Error text is
// diagnostic only; callers should branch on CodeOf or errors.Is.
type Code string

const (
	CodeNotFound     Code = "continuation.not_found"
	CodeExpired      Code = "continuation.expired"
	CodeScope        Code = "continuation.scope_mismatch"
	CodeUnauthorized Code = "continuation.unauthorized"
	CodeProvider     Code = "continuation.provider_mismatch"
	CodeModel        Code = "continuation.model_mismatch"
	CodeGeneration   Code = "continuation.stale_generation"
	CodeInvalid      Code = "continuation.invalid"
	CodePersistence  Code = "continuation.persistence"
	CodeCanceled     Code = "continuation.canceled"
	CodeClosed       Code = "continuation.closed"
	CodeRepair       Code = "continuation.repair_exhausted"
)

// Error is the package-owned error contract for continuation operations.
type Error struct {
	Code    Code
	Op      string
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && e != nil && other != nil && e.Code != "" && e.Code == other.Code
}

// CodeOf returns a stable continuation code. It returns an empty code for
// unrelated errors and maps context cancellation to the continuation contract.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var ce *Error
	if errors.As(err, &ce) {
		return ce.Code
	}
	if errors.Is(err, context.Canceled) {
		return CodeCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return CodeCanceled
	}
	return ""
}

var (
	ErrNotFound     = &Error{Code: CodeNotFound, Message: "continuation: not found"}
	ErrExpired      = &Error{Code: CodeExpired, Message: "continuation: expired"}
	ErrScope        = &Error{Code: CodeScope, Message: "continuation: scope mismatch"}
	ErrUnauthorized = &Error{Code: CodeUnauthorized, Message: "continuation: unauthorized"}
	ErrProvider     = &Error{Code: CodeProvider, Message: "continuation: provider mismatch"}
	ErrModel        = &Error{Code: CodeModel, Message: "continuation: model mismatch"}
	ErrGeneration   = &Error{Code: CodeGeneration, Message: "continuation: stale generation"}
	ErrInvalid      = &Error{Code: CodeInvalid, Message: "continuation: invalid state"}
	ErrPersistence  = &Error{Code: CodePersistence, Message: "continuation: persistence failure"}
	ErrCanceled     = &Error{Code: CodeCanceled, Message: "continuation: canceled"}
	ErrClosed       = &Error{Code: CodeClosed, Message: "continuation: store closed"}
	ErrRepair       = &Error{Code: CodeRepair, Message: "continuation: repair policy exhausted"}
)

const (
	defaultTTL        = 30 * time.Minute
	defaultSweepLimit = 256
	maxRepairAttempts = 3
	maxFieldBytes     = 256
)

// State is the server-side binding for an opaque previous_response_id.
// ResponseID is retained separately so persistence never has to infer the
// provider response from unrelated history.
type State struct {
	ID         string
	Provider   string
	Model      string
	Scope      string // authorization scope; callers must present the same value
	ResponseID string
	Generation uint64
	CreatedAt  time.Time
	ExpiresAt  time.Time
}

// Binding is the request identity used during resolution. Generation zero
// means the caller has no catalog generation to bind (legacy compatibility).
type Binding struct {
	Scope      string
	Provider   string
	Model      string
	Generation uint64
}

func (b Binding) validate() error {
	if strings.TrimSpace(b.Scope) == "" {
		return ErrUnauthorized
	}
	if err := validField("scope", b.Scope, true); err != nil {
		return err
	}
	if err := validField("provider", b.Provider, true); err != nil {
		return err
	}
	if b.Model != "" {
		if err := validField("model", b.Model, true); err != nil {
			return err
		}
	}
	return nil
}

// RepairPolicy permits bounded repair only when the caller supplies a
// replacement for the exact same continuation identity. No history lookup or
// unrelated substitution is performed by this package.
type RepairPolicy struct {
	MaxAttempts int
	Repair      func(context.Context, State, Binding) (State, error)
}

// Persistence is the restart boundary for continuation state. Implementations
// must persist the complete State atomically. Load returns ErrNotFound for an
// absent key; Sweep must delete at most limit records (or all records when
// limit <= 0 is explicitly requested by the implementation).
type Persistence interface {
	Put(context.Context, State) error
	Load(context.Context, string) (State, error)
	Delete(context.Context, string) error
	Sweep(context.Context, time.Time, int) (int, error)
}

// MemoryPersistence is a bounded, concurrency-safe persistence adapter useful
// for tests and single-process operation. A caller can share one instance
// between Store values to model restart without losing records.
type MemoryPersistence struct {
	mu     sync.Mutex
	values map[string]State
}

func NewMemoryPersistence() *MemoryPersistence {
	return &MemoryPersistence{values: make(map[string]State)}
}
func (m *MemoryPersistence) Put(ctx context.Context, state State) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.values == nil {
		m.values = make(map[string]State)
	}
	m.values[state.ID] = state
	m.mu.Unlock()
	return nil
}

func (m *MemoryPersistence) Load(ctx context.Context, id string) (State, error) {
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	m.mu.Lock()
	state, ok := m.values[id]
	m.mu.Unlock()
	if !ok {
		return State{}, ErrNotFound
	}
	return state, nil
}

func (m *MemoryPersistence) Delete(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.values, id)
	m.mu.Unlock()
	return nil
}

func (m *MemoryPersistence) Sweep(ctx context.Context, now time.Time, limit int) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = defaultSweepLimit
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for id, state := range m.values {
		if !state.ExpiresAt.After(now) {
			delete(m.values, id)
			n++
			if n >= limit {
				break
			}
		}
	}
	return n, nil
}

type Store struct {
	mu         sync.Mutex
	values     map[string]State // retained as an inspection-compatible alias for default memory storage
	persist    Persistence
	ttl        time.Duration
	maxEntries int
	now        func() time.Time
	repair     RepairPolicy
	closed     bool
}

func New(ttl time.Duration) *Store {
	p := NewMemoryPersistence()
	return newStore(ttl, p, p.values)
}

// NewWithPersistence constructs a store whose records survive Store
// recreation when the supplied persistence implementation is durable.
// A nil persistence uses an isolated in-memory adapter.
func NewWithPersistence(ttl time.Duration, persistence Persistence) *Store {
	if persistence == nil {
		persistence = NewMemoryPersistence()
	}
	var values map[string]State
	if p, ok := persistence.(*MemoryPersistence); ok {
		values = p.values
	}
	return newStore(ttl, persistence, values)
}

// NewPersistent is an explicit alias for NewWithPersistence.
func NewPersistent(ttl time.Duration, persistence Persistence) *Store {
	return NewWithPersistence(ttl, persistence)
}

func newStore(ttl time.Duration, persistence Persistence, values map[string]State) *Store {
	if ttl <= 0 {
		ttl = defaultTTL
	}
	return &Store{
		values: values, persist: persistence, ttl: ttl, maxEntries: defaultSweepLimit,
		now: time.Now,
	}
}

func (s *Store) Put(ctx context.Context, state State) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if err := validateState(state); err != nil {
		return err
	}
	now := s.now()
	if state.CreatedAt.IsZero() {
		state.CreatedAt = now
	}
	if state.ExpiresAt.IsZero() {
		state.ExpiresAt = now.Add(s.ttl)
	}
	if err := s.persist.Put(ctx, state); err != nil {
		return persistenceError("put", err)
	}
	return nil
}

func (s *Store) Resolve(ctx context.Context, id, scope, provider string) (State, error) {
	return s.ResolveFor(ctx, id, Binding{Scope: scope, Provider: provider})
}
func (s *Store) ResolveFor(ctx context.Context, id string, binding Binding) (State, error) {
	s.mu.Lock()
	policy := s.repair
	s.mu.Unlock()
	return s.ResolveWithPolicy(ctx, id, binding, policy)
}

func (s *Store) ResolveWithPolicy(ctx context.Context, id string, binding Binding, policy RepairPolicy) (State, error) {
	if err := s.check(ctx); err != nil {
		return State{}, err
	}
	if err := validField("id", id, true); err != nil {
		return State{}, err
	}
	if err := binding.validate(); err != nil {
		return State{}, err
	}
	maxAttempts := policy.MaxAttempts
	if maxAttempts < 0 {
		maxAttempts = 0
	}
	if maxAttempts > maxRepairAttempts {
		maxAttempts = maxRepairAttempts
	}
	for attempt := 0; ; attempt++ {
		state, err := s.persist.Load(ctx, id)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return State{}, ErrNotFound
			}
			return State{}, persistenceError("load", err)
		}
		if !state.ExpiresAt.After(s.now()) {
			if deleteErr := s.persist.Delete(ctx, id); deleteErr != nil && !errors.Is(deleteErr, ErrNotFound) {
				return State{}, persistenceError("delete expired", deleteErr)
			}
			return State{}, ErrExpired
		}
		if err := state.matches(binding); err == nil {
			return state, nil
		} else if attempt >= maxAttempts || policy.Repair == nil {
			return State{}, err
		} else if !errors.Is(err, ErrGeneration) {
			return State{}, err
		}
		repaired, repairErr := policy.Repair(ctx, state, binding)
		if repairErr != nil {
			if CodeOf(repairErr) != "" {
				return State{}, repairErr
			}
			return State{}, &Error{Code: CodeRepair, Op: "repair", Message: "continuation repair failed", Err: repairErr}
		}
		if repaired.ID != state.ID || repaired.ResponseID != state.ResponseID ||
			repaired.Scope != binding.Scope || repaired.Provider != binding.Provider ||
			repaired.Model != binding.Model ||
			(repaired.Generation != binding.Generation && binding.Generation != 0) {
			return State{}, ErrRepair
		}
		if repaired.ExpiresAt.IsZero() || !repaired.ExpiresAt.After(s.now()) {
			return State{}, ErrExpired
		}
		if err := s.persist.Put(ctx, repaired); err != nil {
			return State{}, persistenceError("repair put", err)
		}
	}
}

func (s *Store) Delete(ctx context.Context, id string) error {
	if err := s.check(ctx); err != nil {
		return err
	}
	if err := validField("id", id, true); err != nil {
		return err
	}
	if err := s.persist.Delete(ctx, id); err != nil && !errors.Is(err, ErrNotFound) {
		return persistenceError("delete", err)
	}
	return nil
}

// Sweep is the compatibility, best-effort cleanup API. Cleanup errors cannot
// be returned by its historical signature; new callers should use Cleanup.
func (s *Store) Sweep(now time.Time) int {
	n, _ := s.sweep(context.Background(), now, s.cleanupLimit())
	return n
}

// Cleanup removes at most limit expired entries and reports persistence or
// cancellation failures. A non-positive limit uses the configured bound.
func (s *Store) Cleanup(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = s.cleanupLimit()
	}
	return s.sweep(ctx, s.now(), limit)
}

func (s *Store) cleanupLimit() int {
	s.mu.Lock()
	limit := s.maxEntries
	s.mu.Unlock()
	return limit
}

func (s *Store) sweep(ctx context.Context, now time.Time, limit int) (int, error) {
	if err := s.check(ctx); err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = defaultSweepLimit
	}
	n, err := s.persist.Sweep(ctx, now, limit)
	if err != nil {
		return 0, persistenceError("sweep", err)
	}
	return n, nil
}

// Close prevents new operations. Persisted records remain available to a new
// Store using the same Persistence, which is the restart-safe boundary.
func (s *Store) Close(ctx context.Context) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

func (s *Store) SetMaxCleanup(limit int) {
	if limit > 0 {
		s.mu.Lock()
		s.maxEntries = limit
		s.mu.Unlock()
	}
}

func (s *Store) SetRepairPolicy(policy RepairPolicy) {
	if policy.MaxAttempts > maxRepairAttempts {
		policy.MaxAttempts = maxRepairAttempts
	}
	if policy.MaxAttempts < 0 {
		policy.MaxAttempts = 0
	}
	s.mu.Lock()
	s.repair = policy
	s.mu.Unlock()
}

func (s *Store) check(ctx context.Context) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return ErrClosed
	}
	return nil
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return &Error{Code: CodeCanceled, Op: "context", Message: "continuation context is nil"}
	}
	if err := ctx.Err(); err != nil {
		return &Error{Code: CodeCanceled, Op: "context", Message: "continuation operation canceled", Err: err}
	}
	return nil
}

func validateState(state State) error {
	for name, value := range map[string]string{
		"id": state.ID, "provider": state.Provider, "model": state.Model,
		"scope": state.Scope, "response id": state.ResponseID,
	} {
		required := name != "model"
		if err := validField(name, value, required); err != nil {
			return err
		}
	}
	return nil
}

func validField(name, value string, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return &Error{Code: CodeInvalid, Op: "validate", Message: "continuation " + name + " is required"}
	}
	if len(value) > maxFieldBytes {
		return &Error{Code: CodeInvalid, Op: "validate", Message: "continuation " + name + " exceeds bound"}
	}
	return nil
}

func (state State) matches(binding Binding) error {
	if state.Scope != binding.Scope {
		return ErrScope
	}
	if state.Provider != binding.Provider {
		return ErrProvider
	}
	if binding.Model != "" && state.Model != binding.Model {
		return ErrModel
	}
	if binding.Generation != 0 && state.Generation != binding.Generation {
		return ErrGeneration
	}
	return nil
}

func persistenceError(op string, err error) error {
	if CodeOf(err) != "" {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: CodeCanceled, Op: op, Message: "continuation operation canceled", Err: err}
	}
	return &Error{Code: CodePersistence, Op: op, Message: "continuation persistence failed", Err: err}
}

// NewID returns a bounded opaque continuation identifier for persistence
// adapters that need to mint an id instead of forwarding an upstream id.
func NewID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", &Error{Code: CodePersistence, Op: "id", Message: "continuation id generation failed", Err: err}
	}
	return "cr_" + hex.EncodeToString(raw[:]), nil
}
