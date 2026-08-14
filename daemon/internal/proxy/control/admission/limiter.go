package admission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Code is the stable machine-readable classification for an admission error.
type Code string

const (
	CodeInvalidLayer       Code = "admission.invalid_layer"
	CodeDuplicateLayer     Code = "admission.duplicate_layer"
	CodeInvalidLimit       Code = "admission.invalid_limit"
	CodeClosed             Code = "admission.closed"
	CodeLimit              Code = "admission.limit_reached"
	CodeCanceled           Code = "admission.canceled"
	CodeWaiterLimit        Code = "admission.waiter_limit"
	CodeInvalidReservation Code = "admission.invalid_reservation"
	CodeReleased           Code = "admission.released"
	CodeReconciled         Code = "admission.already_reconciled"
)

type Error struct {
	Code                     Code
	Op                       string
	Layer                    string
	Retryable                bool
	RetryAfterMS             int64
	AlternateAccountEligible bool
	RateSource               string
	RateScope                string
	RatePhase                string
	Err                      error
}

// AdmissionError is retained as a descriptive alias for callers that prefer
// an explicit package-owned error name.
type AdmissionError = Error

func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	msg := string(e.Code)
	if e.Op != "" {
		msg += ": " + e.Op
	}
	if e.Layer != "" {
		msg += " " + e.Layer
	}
	if e.Err != nil {
		msg += ": " + e.Err.Error()
	}
	return msg
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

// CodeOf returns the package-owned code from err, or "" for unrelated errors.
func CodeOf(err error) string {
	var admissionErr *Error
	if errors.As(err, &admissionErr) && admissionErr != nil {
		return string(admissionErr.Code)
	}
	return ""
}

// RateEvidence is the operator-safe allowance decision attached to an
// admission error. It contains no request body, credentials, or caller text.
type RateEvidence struct {
	Source                   string
	Scope                    string
	Phase                    string
	Retryable                bool
	RetryAfterMS             int64
	AlternateAccountEligible bool
	Code                     string
}

// Evidence returns stable source/scope/phase metadata. Explicit fields win;
// legacy CodeLimit errors are classified from their bounded layer name.
func (e *Error) Evidence() RateEvidence {
	if e == nil {
		return RateEvidence{}
	}
	source, scope, phase := e.RateSource, e.RateScope, e.RatePhase
	code := string(e.Code)
	if source == "" && e.Code == CodeLimit {
		source = "local_rate_limit"
		if strings.Contains(strings.ToLower(e.Layer), "concurr") {
			source = "local_concurrency_limit"
		}
	}
	if scope == "" {
		scope = "global_daemon"
		lower := strings.ToLower(e.Layer)
		for _, candidate := range []string{"client", "route", "provider", "model", "account", "api_key", "organization"} {
			if strings.Contains(lower, candidate) {
				scope = candidate
				break
			}
		}
	}
	if phase == "" {
		phase = "pre_dispatch"
	}
	retryable := e.Retryable
	if e.Code == CodeLimit && !retryable {
		retryable = true
	}
	return RateEvidence{Source: source, Scope: scope, Phase: phase, Retryable: retryable, RetryAfterMS: e.RetryAfterMS, AlternateAccountEligible: e.AlternateAccountEligible, Code: code}
}

// LifecycleEvidence exposes stable admission metadata without the underlying
// error, which may contain untrusted transport text.
func (e *Error) LifecycleEvidence() (code string, retryable bool, retryAfterMS int64, alternate bool, source, scope, phase string) {
	ev := e.Evidence()
	return ev.Code, ev.Retryable, ev.RetryAfterMS, ev.AlternateAccountEligible, ev.Source, ev.Scope, ev.Phase
}

var (
	ErrClosed    = &Error{Code: CodeClosed}
	ErrLimit     = &Error{Code: CodeLimit}
	ErrCanceled  = &Error{Code: CodeCanceled}
	ErrReleased  = &Error{Code: CodeReleased}
	ErrWaiterCap = &Error{Code: CodeWaiterLimit}
)

// LayerUnit identifies what a layer counts. Request is the default and
// preserves the original Limiter behavior. Token layers count weighted
// estimated-token reservations instead.
type LayerUnit string

const (
	UnitRequest LayerUnit = "request"
	UnitTokens  LayerUnit = "tokens"
)

// LayerScope controls whether a limit is shared by all keys or independently
// enforced per key. Global/stream layers default to Shared; API-key/provider/
// account/model layers default to Keyed.
type LayerScope string

const (
	ScopeShared LayerScope = "shared"
	ScopeKeyed  LayerScope = "keyed"
)

type Layer struct {
	Name  string
	Limit int
	Unit  LayerUnit
	Scope LayerScope
}

// Options bounds queued waiters. A non-positive MaxWaiters uses the safe
// default. MaxWaiters includes only callers currently waiting, not granted
// leases. MaxWait, when positive, bounds time spent in the queue.
type Options struct {
	MaxWaiters int
	MaxWait    time.Duration
}

const defaultMaxWaiters = 1024

type Limiter struct {
	mu         sync.Mutex
	closed     bool
	layers     map[string]*semaphore
	notify     chan struct{}
	waiters    []*waiter
	maxWaiters int
	maxWait    time.Duration
	active     atomic.Int64
	grants     atomic.Uint64
	canceled   atomic.Uint64
	rejected   atomic.Uint64
}

// Stats is a point-in-time, lock-free admission lifecycle snapshot.
type Stats struct {
	Active   int64
	Waiters  int
	Grants   uint64
	Canceled uint64
	Rejected uint64
}

type semaphore struct {
	limit int
	used  int
	unit  LayerUnit
	scope LayerScope
	byKey map[string]int
}

type waiter struct {
	keys    map[string]string
	weights map[string]int
	ready   chan struct{}
	lease   *Lease
	err     error
}

// Lease owns all request and token reservations acquired together. Release
// and Close are aliases and are safe to call any number of times.
type Lease struct {
	once   sync.Once
	owner  *Limiter
	keys   map[string]string
	usage  map[string]int
	tokens *Reservation
}

// Reservation tracks a weighted token estimate. Reconcile adjusts the
// reservation exactly once; Release is idempotent even after reconciliation.
type Reservation struct {
	once       sync.Once
	owner      *Limiter
	keys       map[string]string
	usage      map[string]int
	amount     int
	done       bool
	reconciled bool
	mu         sync.Mutex
}

func New(layers ...Layer) (*Limiter, error) {
	return NewWithOptions(Options{}, layers...)
}

func NewWithOptions(opts Options, layers ...Layer) (*Limiter, error) {
	if opts.MaxWaiters <= 0 {
		opts.MaxWaiters = defaultMaxWaiters
	}
	l := &Limiter{
		layers:     map[string]*semaphore{},
		notify:     make(chan struct{}),
		maxWaiters: opts.MaxWaiters,
		maxWait:    opts.MaxWait,
	}
	for _, layer := range layers {
		if strings.TrimSpace(layer.Name) == "" {
			return nil, &Error{Code: CodeInvalidLayer, Op: "new", Err: errors.New("name is required")}
		}
		if layer.Limit <= 0 {
			return nil, &Error{Code: CodeInvalidLimit, Op: "new", Layer: layer.Name}
		}
		if _, ok := l.layers[layer.Name]; ok {
			return nil, &Error{Code: CodeDuplicateLayer, Op: "new", Layer: layer.Name}
		}
		unit := layer.Unit
		if unit == "" {
			if isTokenLayer(layer.Name) {
				unit = UnitTokens
			} else {
				unit = UnitRequest
			}
		}
		if unit != UnitRequest && unit != UnitTokens {
			return nil, &Error{Code: CodeInvalidLayer, Op: "new", Layer: layer.Name}
		}
		scope := layer.Scope
		if scope == "" {
			scope = defaultScope(layer.Name)
		}
		if scope != ScopeShared && scope != ScopeKeyed {
			return nil, &Error{Code: CodeInvalidLayer, Op: "new", Layer: layer.Name}
		}
		l.layers[layer.Name] = &semaphore{limit: layer.Limit, unit: unit, scope: scope, byKey: map[string]int{}}
	}
	return l, nil
}

// Acquire reserves one request slot in every configured layer selected by
// keys. Unknown layers are rejected rather than silently failing open.
func (l *Limiter) Acquire(ctx context.Context, keys map[string]string) (*Lease, error) {
	return l.acquire(ctx, keys, nil)
}

// Stats returns active leases, queued waiters, and bounded lifecycle counters.
func (l *Limiter) Stats() Stats {
	if l == nil {
		return Stats{}
	}
	l.mu.Lock()
	waiters := len(l.waiters)
	l.mu.Unlock()
	return Stats{Active: l.active.Load(), Waiters: waiters, Grants: l.grants.Load(), Canceled: l.canceled.Load(), Rejected: l.rejected.Load()}
}

// AcquireWithTokens reserves request slots and an estimated token amount in
// token-unit layers. It is a convenience for orchestration that wants one
// idempotent owner for both resources.
func (l *Limiter) AcquireWithTokens(ctx context.Context, keys map[string]string, estimatedTokens int) (*Lease, error) {
	if estimatedTokens <= 0 {
		return nil, &Error{Code: CodeInvalidReservation, Op: "acquire-with-tokens"}
	}
	return l.acquire(ctx, keys, &estimatedTokens)
}

func (l *Limiter) acquire(ctx context.Context, keys map[string]string, estimatedTokens *int) (*Lease, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		l.canceled.Add(1)
		return nil, &Error{Code: CodeCanceled, Op: "acquire", Err: err}
	}
	weights, err := l.weights(keys, estimatedTokens)
	if err != nil {
		return nil, err
	}
	w := &waiter{keys: cloneKeys(keys), weights: weights, ready: make(chan struct{})}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, ErrClosed
	}
	if len(l.waiters) == 0 && l.canGrantLocked(weights, keys) {
		lease := l.grantLocked(weights, keys)
		l.mu.Unlock()
		return lease, nil
	}
	if len(l.waiters) >= l.maxWaiters {
		l.rejected.Add(1)
		l.mu.Unlock()
		return nil, &Error{Code: CodeWaiterLimit, Op: "acquire"}
	}
	l.waiters = append(l.waiters, w)
	l.processLocked()
	l.mu.Unlock()
	waitCtx := ctx
	cancel := func() {}
	if l.maxWait > 0 {
		waitCtx, cancel = context.WithTimeout(ctx, l.maxWait)
	}
	defer cancel()
	select {
	case <-w.ready:
		if w.err != nil {
			return nil, w.err
		}
		return w.lease, nil
	case <-waitCtx.Done():
		l.mu.Lock()
		for i, queued := range l.waiters {
			if queued == w {
				l.waiters = append(l.waiters[:i], l.waiters[i+1:]...)
				l.processLocked()
				break
			}
		}
		lease := w.lease
		l.mu.Unlock()
		if lease != nil {
			return lease, nil
		}
		l.canceled.Add(1)
		return nil, &Error{Code: CodeCanceled, Op: "acquire", Err: waitCtx.Err()}
	}
}

func (l *Limiter) weights(keys map[string]string, estimatedTokens *int) (map[string]int, error) {
	weights := make(map[string]int, len(keys))
	for layer, key := range keys {
		if key == "" {
			continue
		}
		sem, ok := l.layers[layer]
		if !ok {
			return nil, &Error{Code: CodeInvalidLayer, Op: "acquire", Layer: layer}
		}
		weight := 1
		if sem.unit == UnitTokens {
			if estimatedTokens == nil {
				continue
			}
			weight = *estimatedTokens
		}
		weights[layer] = weight
	}
	if estimatedTokens != nil {
		hasToken := false
		for layer, weight := range weights {
			if l.layers[layer].unit == UnitTokens && weight > 0 {
				hasToken = true
			}
		}
		if !hasToken {
			return nil, &Error{Code: CodeInvalidReservation, Op: "acquire-with-tokens"}
		}
	}
	return weights, nil
}

func (l *Limiter) canGrantLocked(weights map[string]int, keys map[string]string) bool {
	for layer, weight := range weights {
		sem := l.layers[layer]
		if sem == nil || weight <= 0 {
			return false
		}
		used := sem.used
		if sem.scope == ScopeKeyed {
			used = sem.byKey[keys[layer]]
		}
		if used > sem.limit-weight {
			return false
		}
	}
	return true
}

func (l *Limiter) grantLocked(weights map[string]int, keys map[string]string) *Lease {
	usage := make(map[string]int, len(weights))
	leaseKeys := make(map[string]string, len(weights))
	for layer, weight := range weights {
		sem := l.layers[layer]
		sem.used += weight
		if sem.scope == ScopeKeyed {
			sem.byKey[keys[layer]] += weight
		}
		usage[layer] = weight
		leaseKeys[layer] = keys[layer]
	}
	lease := &Lease{owner: l, keys: leaseKeys, usage: usage}
	l.active.Add(1)
	l.grants.Add(1)
	if amount := tokenAmount(usage, l.layers); amount > 0 {
		lease.tokens = &Reservation{owner: l, keys: leaseKeys, usage: usage, amount: amount}
	}
	return lease
}

func (l *Limiter) processLocked() {
	for len(l.waiters) > 0 {
		granted := false
		for i, w := range l.waiters {
			if !l.canGrantLocked(w.weights, w.keys) || l.blockedByEarlierLocked(i, w) {
				continue
			}
			l.waiters = append(l.waiters[:i], l.waiters[i+1:]...)
			w.lease = l.grantLocked(w.weights, w.keys)
			close(w.ready)
			granted = true
			break
		}
		if !granted {
			return
		}
	}
}

func (l *Limiter) blockedByEarlierLocked(index int, candidate *waiter) bool {
	for i := 0; i < index; i++ {
		earlier := l.waiters[i]
		for layer := range candidate.weights {
			if _, ok := earlier.weights[layer]; !ok {
				continue
			}
			sem := l.layers[layer]
			if sem.scope == ScopeShared || earlier.keys[layer] == candidate.keys[layer] {
				return true
			}
		}
	}
	return false
}

func (l *Limiter) signalLocked() {
	close(l.notify)
	l.notify = make(chan struct{})
}

func (l *Limiter) release(usage map[string]int, keys map[string]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for name, amount := range usage {
		if sem := l.layers[name]; sem != nil {
			sem.used -= amount
			if sem.scope == ScopeKeyed {
				key := keys[name]
				sem.byKey[key] -= amount
				if sem.byKey[key] <= 0 {
					delete(sem.byKey, key)
				}
			}
			if sem.used < 0 {
				sem.used = 0
			}
		}
	}
	l.processLocked()
	l.signalLocked()
	l.active.Add(-1)
}

func (s *Lease) Release() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		if s.tokens != nil {
			s.tokens.release()
			return
		}
		if s.owner != nil {
			s.owner.release(s.usage, s.keys)
		}
	})
}

func (s *Lease) Close() error {
	s.Release()
	return nil
}

// Reconcile adjusts a token-bearing lease's estimate exactly once.
func (s *Lease) Reconcile(actualTokens int) error {
	if s == nil || s.tokens == nil {
		return &Error{Code: CodeInvalidReservation, Op: "reconcile"}
	}
	return s.tokens.Reconcile(actualTokens)
}

// ReserveRetry adds a second bounded token reservation for a retry attempt.
// It is released together with the original lease.
func (s *Lease) ReserveRetry(tokens int) error {
	if s == nil || s.tokens == nil || tokens <= 0 {
		return &Error{Code: CodeInvalidReservation, Op: "retry"}
	}
	return s.tokens.retry(tokens)
}

func (l *Limiter) Reserve(ctx context.Context, keys map[string]string, estimatedTokens int) (*Reservation, error) {
	lease, err := l.AcquireWithTokens(ctx, keys, estimatedTokens)
	if err != nil {
		return nil, err
	}
	return lease.tokens, nil
}

// ReserveRetry is an explicit alias for callers that model retries as a new
// reservation. It preserves the same layered token accounting and fairness.
func (l *Limiter) ReserveRetry(ctx context.Context, keys map[string]string, estimatedTokens int) (*Reservation, error) {
	return l.Reserve(ctx, keys, estimatedTokens)
}

func (s *Reservation) retry(tokens int) error {
	if s == nil || tokens <= 0 {
		return &Error{Code: CodeInvalidReservation, Op: "retry"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return &Error{Code: CodeReleased, Op: "retry"}
	}
	s.owner.mu.Lock()
	defer s.owner.mu.Unlock()
	for layer := range s.usage {
		sem := s.owner.layers[layer]
		if sem.unit != UnitTokens {
			continue
		}
		used := sem.used
		if sem.scope == ScopeKeyed {
			used = sem.byKey[s.keys[layer]]
		}
		if used > sem.limit-tokens {
			return &Error{Code: CodeLimit, Op: "retry", Layer: layer}
		}
	}
	for layer := range s.usage {
		sem := s.owner.layers[layer]
		if sem.unit == UnitTokens {
			sem.used += tokens
			if sem.scope == ScopeKeyed {
				sem.byKey[s.keys[layer]] += tokens
			}
			s.usage[layer] += tokens
		}
	}
	s.amount += tokens
	s.owner.processLocked()
	s.owner.signalLocked()
	return nil
}
func (s *Reservation) Reconcile(actualTokens int) error {
	if s == nil || actualTokens < 0 {
		return &Error{Code: CodeInvalidReservation, Op: "reconcile"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return &Error{Code: CodeReleased, Op: "reconcile"}
	}
	if s.reconciled {
		return &Error{Code: CodeReconciled, Op: "reconcile"}
	}
	delta := actualTokens - s.amount
	if delta > 0 {
		s.owner.mu.Lock()
		for layer := range s.usage {
			sem := s.owner.layers[layer]
			if sem.unit != UnitTokens {
				continue
			}
			used := sem.used
			if sem.scope == ScopeKeyed {
				used = sem.byKey[s.keys[layer]]
			}
			if used > sem.limit-delta {
				s.owner.mu.Unlock()
				return &Error{Code: CodeLimit, Op: "reconcile", Layer: layer}
			}
		}
		for layer := range s.usage {
			sem := s.owner.layers[layer]
			if sem.unit == UnitTokens {
				sem.used += delta
				if sem.scope == ScopeKeyed {
					sem.byKey[s.keys[layer]] += delta
				}
				s.usage[layer] += delta
			}
		}
		s.owner.processLocked()
		s.owner.signalLocked()
		s.owner.mu.Unlock()
	} else if delta < 0 {
		s.owner.release(scaledTokenUsage(s.usage, -delta, s.owner.layers), s.keys)
		for layer, amount := range s.usage {
			if s.owner.layers[layer].unit == UnitTokens {
				s.usage[layer] = amount + delta
			}
		}
	}
	s.amount = actualTokens
	s.reconciled = true
	return nil
}

func (s *Reservation) release() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		s.mu.Lock()
		if s.done {
			s.mu.Unlock()
			return
		}
		s.done = true
		usage := cloneUsage(s.usage)
		keys := cloneKeys(s.keys)
		s.mu.Unlock()
		if s.owner != nil {
			s.owner.release(usage, keys)
		}
	})
}

func (s *Reservation) Release() { s.release() }
func (s *Reservation) Close() error {
	s.release()
	return nil
}

func (l *Limiter) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		for _, w := range l.waiters {
			w.err = ErrClosed
			close(w.ready)
		}
		l.waiters = nil
		l.signalLocked()
	}
}

func (l *Limiter) Shutdown() { l.Close() }

func (l *Limiter) Usage() map[string]int {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]int{}
	for name, sem := range l.layers {
		out[name] = sem.used
	}
	return out
}

func cloneUsage(in map[string]int) map[string]int {
	out := make(map[string]int, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
func cloneKeys(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func scaledTokenUsage(usage map[string]int, delta int, layers map[string]*semaphore) map[string]int {
	out := make(map[string]int)
	for layer := range usage {
		if layers[layer].unit == UnitTokens {
			out[layer] = delta
		}
	}
	return out
}
func defaultScope(name string) LayerScope {
	switch strings.ToLower(name) {
	case "global", "stream", "connection", "http":
		return ScopeShared
	default:
		return ScopeKeyed
	}
}

func tokenAmount(usage map[string]int, layers map[string]*semaphore) int {
	for layer, amount := range usage {
		if layers[layer].unit == UnitTokens {
			return amount
		}
	}
	return 0
}

func isTokenLayer(name string) bool {
	name = strings.ToLower(name)
	return strings.Contains(name, "token") || strings.Contains(name, "quota")
}
