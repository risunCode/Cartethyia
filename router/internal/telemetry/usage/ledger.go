package usage

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrorCode is the stable machine-readable code carried by every usage error.
type ErrorCode string

const (
	CodeInvalid              ErrorCode = "usage.invalid"
	CodeDuplicate            ErrorCode = "usage.duplicate"
	CodeMissing              ErrorCode = "usage.missing"
	CodeConflict             ErrorCode = "usage.conflict"
	CodePriceUnavailable     ErrorCode = "usage.price_unavailable"
	CodePersistence          ErrorCode = "usage.persistence"
	CodeReconciliation       ErrorCode = "usage.reconciliation"
	CodeCancelled            ErrorCode = "usage.cancelled"
	CodeTelemetryUnavailable ErrorCode = "usage.telemetry_unavailable"
)

type sentinel struct {
	code ErrorCode
	text string
}

func (e *sentinel) Error() string        { return e.text }
func (e *sentinel) UsageCode() ErrorCode { return e.code }

var (
	ErrDuplicate            = &sentinel{CodeDuplicate, "usage: duplicate record"}
	ErrMissing              = &sentinel{CodeMissing, "usage: missing record"}
	ErrInvalid              = &sentinel{CodeInvalid, "usage: invalid record"}
	ErrConflict             = &sentinel{CodeConflict, "usage: conflicting idempotent operation"}
	ErrPriceUnavailable     = &sentinel{CodePriceUnavailable, "usage: pricing generation unavailable"}
	ErrPersistence          = &sentinel{CodePersistence, "usage: persistence failed"}
	ErrReconciliation       = &sentinel{CodeReconciliation, "usage: reconciliation failed"}
	ErrCancelled            = &sentinel{CodeCancelled, "usage: operation cancelled"}
	ErrTelemetryUnavailable = &sentinel{CodeTelemetryUnavailable, "usage: telemetry persistence unavailable"}
)

// Code returns the stable package-owned code for err. Unknown errors are
// classified as usage.invalid rather than leaking a driver or implementation
// error into a machine-facing response.
func Code(err error) ErrorCode {
	if err == nil {
		return ""
	}
	var coded interface{ UsageCode() ErrorCode }
	if errors.As(err, &coded) {
		return coded.UsageCode()
	}
	return CodeInvalid
}

func usageError(base error, format string, args ...any) error {
	if format == "" {
		return base
	}
	return fmt.Errorf("%w: %s", base, fmt.Sprintf(format, args...))
}

const (
	MaxAttempts      = 8
	MaxIdentifierLen = 96
	MaxTransformLen  = 64
)

// Tokens intentionally uses pointers: nil means the provider did not report a
// value. It is never converted to zero, since zero is valid provider evidence.
type Tokens struct {
	Input       *int64
	Output      *int64
	CachedRead  *int64
	CachedWrite *int64
	Reasoning   *int64
	Total       *int64
}

func (t Tokens) validate() error {
	for name, value := range map[string]*int64{
		"input": t.Input, "output": t.Output, "cached_read": t.CachedRead,
		"cached_write": t.CachedWrite, "reasoning": t.Reasoning, "total": t.Total,
	} {
		if value != nil && *value < 0 {
			return usageError(ErrInvalid, "%s tokens cannot be negative", name)
		}
	}
	return nil
}

func cloneInt(v *int64) *int64 {
	if v == nil {
		return nil
	}
	n := *v
	return &n
}

func (t Tokens) clone() Tokens {
	return Tokens{Input: cloneInt(t.Input), Output: cloneInt(t.Output), CachedRead: cloneInt(t.CachedRead), CachedWrite: cloneInt(t.CachedWrite), Reasoning: cloneInt(t.Reasoning), Total: cloneInt(t.Total)}
}

func sameInt(a, b *int64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func sameTokens(a, b Tokens) bool {
	return sameInt(a.Input, b.Input) && sameInt(a.Output, b.Output) && sameInt(a.CachedRead, b.CachedRead) && sameInt(a.CachedWrite, b.CachedWrite) && sameInt(a.Reasoning, b.Reasoning) && sameInt(a.Total, b.Total)
}

func subtractInt(actual, reserved *int64) *int64 {
	if actual == nil || reserved == nil {
		return nil
	}
	n := *actual - *reserved
	return &n
}

// Transform records bounded semantic work applied to an attempt. It contains
// no payload data or diagnostics that could become an unbounded log channel.
type Transform struct {
	Name    string
	Lossy   bool
	Applied bool
}

// QuotaReconciliation records reservation versus provider evidence. Delta
// fields remain nil whenever either side is unknown.
type QuotaReconciliation struct {
	Reserved    Tokens
	ReservedSet bool
	Actual      Tokens
	Delta       Tokens
	Reconciled  bool
	Idempotency string
}

// Event is one deterministic route attempt. All attempts for one RequestID are
// retained, including retries and cancelled attempts; callers can aggregate
// them without confusing a retry with a second logical request.
type Event struct {
	RequestID        string
	LogicalRequestID string
	Attempt          int
	IdempotencyKey   string
	Provider         string
	Model            string
	Tokens           Tokens
	UsageSource      string
	PriceGeneration  uint64
	Transforms       []Transform
	LatencyMS        int64
	LatencyKnown     bool
	TTFBMS           *int64
	StartedAt        time.Time
	EndedAt          time.Time
	Outcome          string
	ErrorCode        string
	Cancelled        bool
	Quota            QuotaReconciliation
	Reconciled       bool
}

// Price is an immutable pricing generation. Rates are per million tokens.
type Price struct {
	InputPerMillion       float64
	OutputPerMillion      float64
	CachedReadPerMillion  float64
	CachedWritePerMillion float64
}

// CostBreakdown keeps unknown token dimensions explicit while still exposing a
// partial cost for dashboards that need a best-effort total.
type CostBreakdown struct {
	Amount          float64
	Known           bool
	Unknown         []string
	PriceGeneration uint64
}

// Reconciliation is the durable idempotency payload sent to a repository.
type Reconciliation struct {
	RequestID      string
	Attempt        int
	IdempotencyKey string
	Tokens         Tokens
	Cost           CostBreakdown
	Quota          QuotaReconciliation
	Cancelled      bool
}

// Repository is the narrow optional durable boundary. Implementations must
// make Append and Reconcile idempotent using the supplied keys. A failing
// optional telemetry repository is observable but never requires callers to
// stop an already-running stream.
type Repository interface {
	Append(context.Context, Event) error
	Reconcile(context.Context, Reconciliation) error
}

type Option func(*Ledger)

// Redacted returns an operator-safe copy. Correlation and idempotency values
// are deliberately omitted; usage records must not become a second logging
// channel. Provider/model and bounded error codes remain available for
// aggregate diagnostics.
func (e Event) Redacted() Event {
	e.RequestID, e.LogicalRequestID, e.IdempotencyKey = "", "", ""
	e.Tokens = Tokens{}
	e.Quota = QuotaReconciliation{}
	e.Transforms = append([]Transform(nil), e.Transforms...)
	return e
}

func WithRepository(repo Repository) Option  { return func(l *Ledger) { l.repo = repo } }
func WithPersistence(repo Repository) Option { return WithRepository(repo) }

// Ledger stores local evidence and optionally mirrors it to durable storage.
type Ledger struct {
	mu                     sync.RWMutex
	events                 map[eventKey]Event
	requests               map[string]LogicalRequest
	prices                 map[uint64]Price
	pendingEvents          map[eventKey]bool
	pendingReconciliations map[eventKey]bool
	repo                   Repository
	persistenceFailures    uint64
}

type eventKey struct {
	requestID string
	attempt   int
}

// LogicalRequest represents one client-visible request independently of its
// route attempts.
type LogicalRequest struct {
	RequestID      string
	IdempotencyKey string
	StartedAt      time.Time
	EndedAt        time.Time
	Outcome        string
	Cancelled      bool
	Completed      bool
}

func New(options ...Option) *Ledger {
	l := &Ledger{events: map[eventKey]Event{}, requests: map[string]LogicalRequest{}, prices: map[uint64]Price{}, pendingEvents: map[eventKey]bool{}, pendingReconciliations: map[eventKey]bool{}}
	for _, option := range options {
		if option != nil {
			option(l)
		}
	}
	return l
}

func validateID(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return usageError(ErrInvalid, "%s is required", name)
	}
	if len(value) > MaxIdentifierLen {
		return usageError(ErrInvalid, "%s exceeds %d bytes", name, MaxIdentifierLen)
	}
	return nil
}

func validateAttempt(attempt int) error {
	if attempt < 0 || attempt > MaxAttempts {
		return usageError(ErrInvalid, "attempt=%d outside [0,%d]", attempt, MaxAttempts)
	}
	return nil
}

func (l *Ledger) ensureLocked() {
	if l.events == nil {
		l.events = map[eventKey]Event{}
	}
	if l.requests == nil {
		l.requests = map[string]LogicalRequest{}
	}
	if l.prices == nil {
		l.prices = map[uint64]Price{}
	}
	if l.pendingEvents == nil {
		l.pendingEvents = map[eventKey]bool{}
	}
	if l.pendingReconciliations == nil {
		l.pendingReconciliations = map[eventKey]bool{}
	}
}

func validateEvent(e Event) error {
	if err := validateID("request_id", e.RequestID); err != nil {
		return err
	}
	if err := validateAttempt(e.Attempt); err != nil {
		return err
	}
	if e.LogicalRequestID != "" {
		if err := validateID("logical_request_id", e.LogicalRequestID); err != nil {
			return err
		}
	}
	for name, value := range map[string]string{"provider": e.Provider, "model": e.Model, "idempotency_key": e.IdempotencyKey, "outcome": e.Outcome, "error_code": e.ErrorCode} {
		if len(value) > MaxIdentifierLen {
			return usageError(ErrInvalid, "%s exceeds %d bytes", name, MaxIdentifierLen)
		}
	}
	if err := e.Tokens.validate(); err != nil {
		return err
	}
	if e.LatencyMS < 0 || e.TTFBMS != nil && *e.TTFBMS < 0 {
		return usageError(ErrInvalid, "latency cannot be negative")
	}
	if !e.StartedAt.IsZero() && !e.EndedAt.IsZero() && e.EndedAt.Before(e.StartedAt) {
		return usageError(ErrInvalid, "ended_at precedes started_at")
	}
	if len(e.Transforms) > 64 {
		return usageError(ErrInvalid, "too many transforms")
	}
	for _, transform := range e.Transforms {
		if strings.TrimSpace(transform.Name) == "" || len(transform.Name) > MaxTransformLen {
			return usageError(ErrInvalid, "invalid transform name")
		}
	}
	if err := e.Quota.Reserved.validate(); err != nil {
		return err
	}
	if err := e.Quota.Actual.validate(); err != nil {
		return err
	}
	return nil
}

func (l *Ledger) Register(e Event) error { return l.RegisterContext(context.Background(), e) }

func (l *Ledger) RegisterContext(ctx context.Context, e Event) error {
	if err := ctx.Err(); err != nil {
		return usageError(ErrCancelled, "context cancelled")
	}
	if err := validateEvent(e); err != nil {
		return err
	}
	if !e.LatencyKnown && !e.StartedAt.IsZero() && !e.EndedAt.IsZero() {
		e.LatencyMS = e.EndedAt.Sub(e.StartedAt).Milliseconds()
		e.LatencyKnown = true
	}
	if e.IdempotencyKey == "" {
		e.IdempotencyKey = e.RequestID + ":" + itoa(e.Attempt)
	}
	if e.LogicalRequestID == "" {
		e.LogicalRequestID = e.RequestID
	}
	key := eventKey{e.RequestID, e.Attempt}
	l.mu.Lock()
	l.ensureLocked()
	if existing, ok := l.events[key]; ok {
		if l.pendingEvents[key] && sameEvent(existing, e) {
			l.mu.Unlock()
			return l.persistEvent(ctx, key, existing)
		}
		l.mu.Unlock()
		return ErrDuplicate
	}
	for otherKey, existing := range l.events {
		if otherKey != key && existing.IdempotencyKey == e.IdempotencyKey {
			l.mu.Unlock()
			return ErrConflict
		}
	}
	l.events[key] = cloneEvent(e)
	l.requests[e.LogicalRequestID] = ensureLogical(l.requests[e.LogicalRequestID], e)
	l.mu.Unlock()
	return l.persistEvent(ctx, key, e)
}

func ensureLogical(existing LogicalRequest, e Event) LogicalRequest {
	if existing.RequestID == "" {
		existing = LogicalRequest{RequestID: e.LogicalRequestID, IdempotencyKey: e.LogicalRequestID, StartedAt: e.StartedAt}
	}
	if existing.StartedAt.IsZero() || (!e.StartedAt.IsZero() && e.StartedAt.Before(existing.StartedAt)) {
		existing.StartedAt = e.StartedAt
	}
	return existing
}

func sameEvent(a, b Event) bool {
	return reflect.DeepEqual(cloneEvent(a), cloneEvent(b))
}

func cloneEvent(e Event) Event {
	e.Tokens = e.Tokens.clone()
	e.Quota.Reserved = e.Quota.Reserved.clone()
	e.Quota.Actual = e.Quota.Actual.clone()
	e.Quota.Delta = e.Quota.Delta.clone()
	e.Transforms = append([]Transform(nil), e.Transforms...)
	e.TTFBMS = cloneInt(e.TTFBMS)
	return e
}

func (l *Ledger) persistEvent(ctx context.Context, key eventKey, e Event) error {
	if l.repo == nil {
		return nil
	}
	if err := l.repo.Append(ctx, cloneEvent(e)); err != nil {
		l.mu.Lock()
		l.ensureLocked()
		l.pendingEvents[key] = true
		l.persistenceFailures++
		l.mu.Unlock()
		return usageError(ErrPersistence, "repository append failed")
	}
	l.mu.Lock()
	l.ensureLocked()
	delete(l.pendingEvents, key)
	l.mu.Unlock()
	return nil
}

// RegisterRequest is optional when callers want a logical row before routing.
func (l *Ledger) RegisterRequest(ctx context.Context, request LogicalRequest) error {
	if err := ctx.Err(); err != nil {
		return usageError(ErrCancelled, "context cancelled")
	}
	if err := validateID("request_id", request.RequestID); err != nil {
		return err
	}
	if request.IdempotencyKey == "" {
		request.IdempotencyKey = request.RequestID
	}
	if len(request.IdempotencyKey) > MaxIdentifierLen {
		return usageError(ErrInvalid, "idempotency_key exceeds %d bytes", MaxIdentifierLen)
	}
	l.mu.Lock()
	l.ensureLocked()
	defer l.mu.Unlock()
	if existing, ok := l.requests[request.RequestID]; ok {
		if existing == request {
			return nil
		}
		return ErrDuplicate
	}
	l.requests[request.RequestID] = request
	return nil
}
func (l *Ledger) RegisterLogical(ctx context.Context, request LogicalRequest) error {
	return l.RegisterRequest(ctx, request)
}

func (l *Ledger) Reconcile(requestID string, attempt int, tokens Tokens) error {
	return l.ReconcileContext(context.Background(), requestID, attempt, tokens)
}

func (l *Ledger) ReconcileContext(ctx context.Context, requestID string, attempt int, tokens Tokens) error {
	if err := ctx.Err(); err != nil {
		return usageError(ErrCancelled, "context cancelled")
	}
	if err := validateID("request_id", requestID); err != nil {
		return err
	}
	if err := validateAttempt(attempt); err != nil {
		return err
	}
	if err := tokens.validate(); err != nil {
		return err
	}
	key := eventKey{requestID, attempt}
	l.mu.Lock()
	l.ensureLocked()
	e, ok := l.events[key]
	if !ok {
		l.mu.Unlock()
		return ErrMissing
	}
	if e.Reconciled {
		if !sameTokens(e.Tokens, tokens) {
			l.mu.Unlock()
			return ErrConflict
		}
		if !l.pendingReconciliations[key] {
			l.mu.Unlock()
			return nil
		}
	} else {
		e.Tokens = tokens.clone()
		e.Reconciled = true
		e.Quota.Actual = tokens.clone()
		e.Quota.Delta = QuotaDelta(e.Quota.Reserved, e.Quota.Actual)
		e.Quota.Reconciled = true
		l.events[key] = cloneEvent(e)
	}
	l.mu.Unlock()
	result := Reconciliation{RequestID: requestID, Attempt: attempt, IdempotencyKey: e.IdempotencyKey + ":reconcile", Tokens: tokens.clone(), Quota: e.Quota, Cancelled: e.Cancelled}
	if cost, err := l.costForEvent(e); err == nil {
		result.Cost = cost
	} else if !errors.Is(err, ErrPriceUnavailable) {
		return err
	}
	if l.repo != nil {
		if err := l.repo.Reconcile(ctx, result); err != nil {
			l.mu.Lock()
			l.pendingReconciliations[key] = true
			l.persistenceFailures++
			l.mu.Unlock()
			return usageError(ErrPersistence, "repository reconciliation failed")
		}
	}
	l.mu.Lock()
	delete(l.pendingReconciliations, key)
	l.mu.Unlock()
	return nil
}

func QuotaDelta(reserved, actual Tokens) Tokens {
	return Tokens{Input: subtractInt(actual.Input, reserved.Input), Output: subtractInt(actual.Output, reserved.Output), CachedRead: subtractInt(actual.CachedRead, reserved.CachedRead), CachedWrite: subtractInt(actual.CachedWrite, reserved.CachedWrite), Reasoning: subtractInt(actual.Reasoning, reserved.Reasoning), Total: subtractInt(actual.Total, reserved.Total)}
}

func (l *Ledger) Reserve(requestID string, attempt int, reserved Tokens) error {
	if err := validateID("request_id", requestID); err != nil {
		return err
	}
	if err := validateAttempt(attempt); err != nil {
		return err
	}
	if err := reserved.validate(); err != nil {
		return err
	}
	key := eventKey{requestID, attempt}
	l.mu.Lock()
	l.ensureLocked()
	defer l.mu.Unlock()
	e, ok := l.events[key]
	if !ok {
		return ErrMissing
	}
	if e.Quota.ReservedSet {
		if sameTokens(e.Quota.Reserved, reserved) {
			return nil
		}
		return ErrConflict
	}
	e.Quota.Reserved = reserved.clone()
	e.Quota.ReservedSet = true
	e.Quota.Idempotency = e.IdempotencyKey + ":quota"
	l.events[key] = e
	return nil
}

func (l *Ledger) ReconcileQuota(requestID string, attempt int, actual Tokens) error {
	return l.Reconcile(requestID, attempt, actual)
}

func (l *Ledger) Cancel(requestID string, attempt int) error {
	return l.CancelContext(context.Background(), requestID, attempt)
}

func (l *Ledger) CancelContext(ctx context.Context, requestID string, attempt int) error {
	if err := ctx.Err(); err != nil {
		return usageError(ErrCancelled, "context cancelled")
	}
	if err := validateID("request_id", requestID); err != nil {
		return err
	}
	if err := validateAttempt(attempt); err != nil {
		return err
	}
	key := eventKey{requestID, attempt}
	l.mu.Lock()
	l.ensureLocked()
	e, ok := l.events[key]
	if !ok {
		l.mu.Unlock()
		return ErrMissing
	}
	if e.Cancelled {
		pending := l.pendingEvents[key]
		l.mu.Unlock()
		if pending {
			return l.persistEvent(ctx, key, e)
		}
		return nil
	}
	e.Cancelled = true
	if e.Outcome == "" {
		e.Outcome = "cancelled"
	}
	l.events[key] = cloneEvent(e)
	l.mu.Unlock()
	return l.persistEvent(ctx, key, e)
}

func (l *Ledger) CompleteRequest(requestID, outcome string, endedAt time.Time, cancelled bool) error {
	if err := validateID("request_id", requestID); err != nil {
		return err
	}
	if strings.TrimSpace(outcome) == "" || len(outcome) > MaxIdentifierLen {
		return usageError(ErrInvalid, "invalid outcome")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	r, ok := l.requests[requestID]
	if !ok {
		return ErrMissing
	}
	if r.Completed {
		if r.Outcome == outcome && r.Cancelled == cancelled {
			return nil
		}
		return ErrConflict
	}
	r.Outcome, r.EndedAt, r.Cancelled, r.Completed = outcome, endedAt, cancelled, true
	l.requests[requestID] = r
	return nil
}

func (l *Ledger) Get(requestID string, attempt int) (Event, error) {
	if err := validateID("request_id", requestID); err != nil {
		return Event{}, err
	}
	if err := validateAttempt(attempt); err != nil {
		return Event{}, err
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	e, ok := l.events[eventKey{requestID, attempt}]
	if !ok {
		return Event{}, ErrMissing
	}
	return cloneEvent(e), nil
}

func (l *Ledger) Attempts(requestID string) []Event {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]Event, 0)
	for key, event := range l.events {
		if key.requestID == requestID {
			out = append(out, cloneEvent(event))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Attempt < out[j].Attempt })
	return out
}

func (l *Ledger) GetRequest(requestID string) (LogicalRequest, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	request, ok := l.requests[requestID]
	if !ok {
		return LogicalRequest{}, ErrMissing
	}
	return request, nil
}

func (l *Ledger) PriceGeneration(gen uint64, p Price) error {
	if gen == 0 || math.IsNaN(p.InputPerMillion) || math.IsNaN(p.OutputPerMillion) || math.IsNaN(p.CachedReadPerMillion) || math.IsNaN(p.CachedWritePerMillion) || math.IsInf(p.InputPerMillion, 0) || math.IsInf(p.OutputPerMillion, 0) || math.IsInf(p.CachedReadPerMillion, 0) || math.IsInf(p.CachedWritePerMillion, 0) || p.InputPerMillion < 0 || p.OutputPerMillion < 0 || p.CachedReadPerMillion < 0 || p.CachedWritePerMillion < 0 {
		return usageError(ErrInvalid, "invalid pricing generation")
	}
	l.mu.Lock()
	l.ensureLocked()
	defer l.mu.Unlock()
	if old, ok := l.prices[gen]; ok && old != p {
		return ErrConflict
	}
	l.prices[gen] = p
	return nil
}

func (l *Ledger) costForEvent(e Event) (CostBreakdown, error) {
	l.mu.RLock()
	p, ok := l.prices[e.PriceGeneration]
	l.mu.RUnlock()
	if !ok {
		return CostBreakdown{}, ErrPriceUnavailable
	}
	result := CostBreakdown{PriceGeneration: e.PriceGeneration, Known: true}
	if e.Tokens.Input == nil {
		result.Known = false
		result.Unknown = append(result.Unknown, "input")
	} else {
		result.Amount += float64(*e.Tokens.Input) * p.InputPerMillion / 1e6
	}
	if e.Tokens.Output == nil {
		result.Known = false
		result.Unknown = append(result.Unknown, "output")
	} else {
		result.Amount += float64(*e.Tokens.Output) * p.OutputPerMillion / 1e6
	}
	if e.Tokens.CachedRead == nil {
		result.Known = false
		result.Unknown = append(result.Unknown, "cached_read")
	} else {
		result.Amount += float64(*e.Tokens.CachedRead) * p.CachedReadPerMillion / 1e6
	}
	if e.Tokens.CachedWrite == nil {
		result.Known = false
		result.Unknown = append(result.Unknown, "cached_write")
	} else {
		result.Amount += float64(*e.Tokens.CachedWrite) * p.CachedWritePerMillion / 1e6
	}
	return result, nil
}

func (l *Ledger) CostBreakdown(requestID string, attempt int) (CostBreakdown, error) {
	e, err := l.Get(requestID, attempt)
	if err != nil {
		return CostBreakdown{}, err
	}
	return l.costForEvent(e)
}
func (l *Ledger) Cost(requestID string, attempt int) (float64, error) {
	result, err := l.CostBreakdown(requestID, attempt)
	return result.Amount, err
}
func (l *Ledger) PersistenceFailures() uint64 {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.persistenceFailures
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
