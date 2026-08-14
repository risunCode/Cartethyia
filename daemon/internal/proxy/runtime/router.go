// File: router.go
// AD-3 retry loop. The Router drives the per-attempt failover between
// accounts. It depends only on provider/transport interfaces and the pool;
// concrete HTTP providers, transforms, and middleware live outside this
// package.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Transport executes one provider call against an account. It is the
// integration point between the router and the transport package; the
// transport is expected to surface ClassifyInput-friendly signals when it
// returns an error.
type Transport interface {
	// Call performs the request. On a non-nil error, the router treats
	// it as a classified failure. On success the response is forwarded
	// to the caller.
	Call(ctx context.Context, acct Account, req contracts.Request) (*contracts.Response, error)
}

// StreamTransport is the streaming variant of Transport. It returns an
// iterator the router can drain until completion or cancellation. The
// router never assumes the iterator is safe for concurrent access; it
// always drains on the calling goroutine.
type StreamTransport interface {
	CallStream(ctx context.Context, acct Account, req contracts.Request) (*Stream, error)
}

// CredentialRefresher is consulted when the router decides an account
// needs a credential refresh. Implementations are responsible for throttling
// concurrent refreshes per account.
type CredentialRefresher interface {
	Refresh(ctx context.Context, accountID string) error
}

// RetryAction is the only action the bounded coordinator can execute after
// classifying an attempt.
type RetryAction string

const (
	RetryStop               RetryAction = "stop"
	RetryRefreshSameAccount RetryAction = "refresh-and-retry-same-account"
	RetryNextAccount        RetryAction = "retry-next-account"
	RetryBackoffNextAccount RetryAction = "backoff-and-retry"
)

// AttemptDecision contains typed, bounded retry metadata.
type AttemptDecision struct {
	Action           RetryAction
	Code             string
	Phase            FailurePhase
	Scope            FailureScope
	RetryAfter       time.Duration
	AlternateAccount bool
	RefreshAllowed   bool
}

// RouterConfig configures the Router.
type RouterConfig struct {
	Pool        *AccountPool
	MaxAttempts int
	// MaxRefreshAttempts bounds same-account refresh retries. Non-positive
	// defaults to one refresh per request/account.
	MaxRefreshAttempts int
	Refresher          CredentialRefresher
	Now                func() time.Time
	// BackoffBase is the fallback delay when a provider supplies no
	// Retry-After. Zero keeps retries immediate for backwards compatibility.
	BackoffBase time.Duration
}

const (
	DefaultMaxAttempts        = 3
	DefaultMaxRefreshAttempts = 1
)

// Router drives one bounded coordinator per request.
type Router struct {
	pool        *AccountPool
	max         int
	maxRefresh  int
	refresher   CredentialRefresher
	now         func() time.Time
	backoffBase time.Duration
}

func NewRouter(cfg RouterConfig) (*Router, error) {
	if cfg.Pool == nil {
		return nil, errors.New("proxy: router account pool is required")
	}
	max := cfg.MaxAttempts
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	maxRefresh := cfg.MaxRefreshAttempts
	if maxRefresh <= 0 {
		maxRefresh = DefaultMaxRefreshAttempts
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Router{
		pool: cfg.Pool, max: max, maxRefresh: maxRefresh,
		refresher: cfg.Refresher, now: now, backoffBase: cfg.BackoffBase,
	}, nil
}

type AttemptOutcome struct {
	AccountID string
	Failure   *Failure
	Refreshed bool
	Attempts  int
}

// Route executes one global-deadline, bounded non-streaming attempt state
// machine. Account selection excludes every prior account except an explicit
// refresh retry of the same account.
func (r *Router) Route(ctx context.Context, transport Transport, req contracts.Request) (*contracts.Response, *Failure, error) {
	if transport == nil {
		return nil, nil, errors.New("proxy: nil transport")
	}
	if ctx == nil {
		return nil, nil, errors.New("proxy: nil context")
	}
	provider := providerFromRequest(req)
	attempted := make(map[string]struct{})
	refreshes := make(map[string]int)
	refreshBudget := 0
	var retrySame *Account
	var lastFailure *Failure

	for attempts := 0; attempts < r.max; {
		if err := ctx.Err(); err != nil {
			return nil, Classify(ClassifyInput{Err: err}), nil
		}
		var acct *Account
		var err error
		if retrySame != nil {
			acct = retrySame
			retrySame = nil
		} else {
			acct, err = r.pool.GetNextExcluding(ctx, provider, attempted)
			if err != nil {
				if errors.Is(err, ErrNoAccount) {
					break
				}
				return nil, nil, err
			}
		}
		if err := r.pool.Start(acct.ID); err != nil {
			return nil, nil, err
		}
		resp, callErr := transport.Call(ctx, *acct, req)
		r.pool.End(acct.ID)
		attempts++
		if callErr == nil {
			return resp, nil, nil
		}
		attempted[acct.ID] = struct{}{}
		failure := r.classifyFailure(callErr, acct)
		lastFailure = failure
		r.applyFailure(failure, acct)
		decision := r.decision(failure, refreshBudget < r.maxRefresh && refreshes[acct.ID] == 0, attempts)
		if decision.Action == RetryStop {
			break
		}
		if decision.Action == RetryRefreshSameAccount {
			refreshes[acct.ID]++
			refreshBudget++
			if err := r.tryRefresh(ctx, acct.ID); err == nil {
				r.pool.Reset(acct.ID)
				_ = r.pool.Refresh(ctx, provider)
				retrySame = acct
				continue
			} else {
				// A failed refresh is classified as a credential failure and
				// may still use a different account when policy allows it.
				lastFailure = r.classifyFailure(err, acct)
				r.applyFailure(lastFailure, acct)
			}
		}
		if !decision.AlternateAccount && !lastFailure.AlternateAccountEligible {
			break
		}
		if !r.waitBackoff(ctx, decision.RetryAfter, attempts) {
			return nil, Classify(ClassifyInput{Err: ctx.Err()}), nil
		}
	}
	if lastFailure == nil {
		return nil, nil, ErrNoAccount
	}
	return nil, lastFailure, nil
}

func (r *Router) RouteStream(ctx context.Context, transport StreamTransport, req contracts.Request) (*Stream, string, *Failure, error) {
	if transport == nil {
		return nil, "", nil, errors.New("proxy: nil stream transport")
	}
	if ctx == nil {
		return nil, "", nil, errors.New("proxy: nil context")
	}
	provider := providerFromRequest(req)
	attempted := make(map[string]struct{})
	refreshes := make(map[string]int)
	refreshBudget := 0
	encryptedRetry := false
	var retrySame *Account
	var lastFailure *Failure
	currentReq := req
	for attempts := 0; attempts < r.max; {
		if err := ctx.Err(); err != nil {
			return nil, "", Classify(ClassifyInput{Err: err}), nil
		}
		var acct *Account
		var err error
		if retrySame != nil {
			acct, retrySame = retrySame, nil
		} else {
			acct, err = r.pool.GetNextExcluding(ctx, provider, attempted)
			if err != nil {
				if errors.Is(err, ErrNoAccount) {
					break
				}
				return nil, "", nil, err
			}
		}
		if err := r.pool.Start(acct.ID); err != nil {
			return nil, "", nil, err
		}
		stream, callErr := transport.CallStream(ctx, *acct, currentReq)
		preflightFailed := false
		if callErr == nil {
			if stream == nil {
				r.pool.End(acct.ID)
				return nil, "", nil, errors.New("proxy: transport returned nil stream without error")
			}
			stream.AttachAccount(acct.ID, r.pool)
			if preflightErr := stream.Preflight(ctx); preflightErr != nil {
				preflightFailed = true
				_ = stream.Close()
				attempts++
				if !encryptedRetry && strings.EqualFold(acct.Provider, "grok-build") {
					if sanitized, changed := stripGrokEncryptedReasoning(currentReq.Body); changed {
						currentReq.Body = sanitized
						encryptedRetry = true
						retrySame = acct
						continue
					}
				}
				callErr = preflightErr
			} else {
				return stream, acct.ID, nil, nil
			}
		}
		if !preflightFailed {
			r.pool.End(acct.ID)
			attempts++
		}
		attempted[acct.ID] = struct{}{}
		failure := r.classifyFailure(callErr, acct)
		lastFailure = failure
		r.applyFailure(failure, acct)
		decision := r.decision(failure, refreshBudget < r.maxRefresh && refreshes[acct.ID] == 0, attempts)
		if decision.Action == RetryStop {
			break
		}
		if decision.Action == RetryRefreshSameAccount {
			refreshes[acct.ID]++
			refreshBudget++
			if err := r.tryRefresh(ctx, acct.ID); err == nil {
				r.pool.Reset(acct.ID)
				_ = r.pool.Refresh(ctx, provider)
				retrySame = acct
				continue
			}
		}
		if !decision.AlternateAccount && !lastFailure.AlternateAccountEligible {
			break
		}
		if !r.waitBackoff(ctx, decision.RetryAfter, attempts) {
			return nil, "", Classify(ClassifyInput{Err: ctx.Err()}), nil
		}
	}
	if lastFailure == nil {
		return nil, "", nil, ErrNoAccount
	}
	return nil, "", lastFailure, nil
}

func (r *Router) classifyFailure(callErr error, acct *Account) *Failure {
	var f *Failure
	var re *contracts.RouteError
	if errors.Is(callErr, ErrInvalidEncryptedContent) {
		f = Classify(ClassifyInput{Kind: FailureInvalidRequest, Err: callErr})
	} else if errors.As(callErr, &re) {
		f = FromContracts(re)
	} else {
		f = Classify(ClassifyInput{Err: callErr})
	}
	f.Provider = acct.Provider
	f.Model = acct.Model
	return f
}

// handleFailure remains a compatibility helper for package-local callers.
func (r *Router) handleFailure(callErr error, acct *Account, _ int) *Failure {
	if callErr == nil {
		return nil
	}
	f := r.classifyFailure(callErr, acct)
	r.applyFailure(f, acct)
	return f
}

func (r *Router) applyFailure(f *Failure, acct *Account) {
	if f == nil || acct == nil {
		return
	}
	switch f.Kind {
	case FailureAuthentication, FailureReauthenticationRequired:
		r.pool.MarkAuthentication(acct.ID)
	case FailureQuota:
		r.pool.MarkExhausted(acct.ID)
	case FailureCapacity:
		r.pool.MarkTransient(acct.ID)
	case FailureFatal, FailureUnknown:
		r.pool.MarkError(acct.ID)
	case FailureTransient, FailureRateLimit:
		r.pool.MarkTransient(acct.ID)
	}
}

func (r *Router) decision(f *Failure, refreshAllowed bool, attempt int) AttemptDecision {
	if f == nil {
		return AttemptDecision{Action: RetryStop}
	}
	d := AttemptDecision{
		Action: RetryStop, Code: f.Code, Phase: f.Phase, Scope: f.Scope,
		RetryAfter:       time.Duration(f.RetryAfterMS) * time.Millisecond,
		AlternateAccount: f.AlternateAccountEligible,
		RefreshAllowed:   refreshAllowed,
	}
	if f.Kind == FailureAuthentication && refreshAllowed && r.refresher != nil {
		d.Action = RetryRefreshSameAccount
		d.AlternateAccount = true
		return d
	}
	if !f.AlternateAccountEligible {
		return d
	}
	if f.Policy == RetryBackoff || d.RetryAfter > 0 {
		d.Action = RetryBackoffNextAccount
	} else {
		d.Action = RetryNextAccount
	}
	if r.max <= attempt {
		d.Action = RetryStop
	}
	return d
}

func (r *Router) waitBackoff(ctx context.Context, retryAfter time.Duration, attempt int) bool {
	delay := retryAfter
	if delay <= 0 && r.backoffBase > 0 {
		delay = r.backoffBase * time.Duration(attempt)
	}
	if delay <= 0 {
		return true
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}
		if delay > remaining {
			delay = remaining
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *Router) tryRefresh(ctx context.Context, accountID string) error {
	if r.refresher == nil {
		return errors.New("proxy: credential refresher is not configured")
	}
	return r.refresher.Refresh(ctx, accountID)
}

func stripGrokEncryptedReasoning(body []byte) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, false
	}
	items, ok := payload["input"].([]any)
	if !ok {
		return nil, false
	}
	changed := false
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := item["type"].(string)
		if kind != "reasoning" && kind != "compaction" && kind != "compaction_summary" {
			continue
		}
		if _, exists := item["encrypted_content"]; exists {
			delete(item, "encrypted_content")
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	payload["input"] = items
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

// providerFromRequest maps the canonical client surface to the provider wire
// family when the caller has not supplied an explicit route hint. Explicit
// metadata remains authoritative; protocol families are the fallback rather
// than a provider-id registry duplicate.
func providerFromRequest(req contracts.Request) string {
	if req.Headers != nil {
		if v := req.Headers.Get("X-Cartethyia-Provider"); v != "" {
			return v
		}
	}
	switch req.Protocol {
	case contracts.SurfaceOpenAIChat, contracts.SurfaceOpenAIResponses, contracts.SurfaceImages:
		return "openai"
	case contracts.SurfaceAnthropic:
		return "anthropic"
	default:
		return "default"
	}
}

// NewAccountOutcomeSink is a helper used by the observability layer to
// convert router outcomes into deterministic structured events. The sink is
// concurrency-safe and may be shared across goroutines.
type AccountOutcomeSink struct {
	mu       sync.Mutex
	outcomes []AttemptOutcome
}

// NewAccountOutcomeSink constructs an empty sink.
func NewAccountOutcomeSink() *AccountOutcomeSink {
	return &AccountOutcomeSink{}
}

// Record appends an outcome. Older outcomes are dropped once the buffer
// exceeds 1024 entries to bound memory.
func (s *AccountOutcomeSink) Record(o AttemptOutcome) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.outcomes = append(s.outcomes, o)
	if len(s.outcomes) > 1024 {
		drop := len(s.outcomes) - 1024
		s.outcomes = append(s.outcomes[:0], s.outcomes[drop:]...)
	}
}

// Snapshot returns a copy of the buffered outcomes.
func (s *AccountOutcomeSink) Snapshot() []AttemptOutcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AttemptOutcome, len(s.outcomes))
	copy(out, s.outcomes)
	return out
}
