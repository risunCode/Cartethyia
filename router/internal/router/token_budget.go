// Package tokenbudget defines redacted durable hard-token admission contracts.
package router

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry/usage"
)

const (
	MaxIdentifierLength = 96
	MaxTokenCount       = int64(1_000_000_000)
	MaxAttempt          = 8
)

var (
	ErrUnavailable = errors.New("token budget authority unavailable")
	ErrInvalid     = errors.New("invalid token reservation")
	ErrLimit       = errors.New("token budget exceeded")
	ErrConflict    = errors.New("token reservation conflict")
)

// TokenBudgetAuthority is the durable admission boundary. Implementations must
// make Reserve idempotent by (key ID, request ID, attempt) across processes.
type TokenBudgetAuthority interface {
	Reserve(context.Context, ReservationRequest) (TokenReservation, error)
}

// TokenReservation owns one upstream attempt's durable estimate.
type TokenReservation interface {
	Reconcile(context.Context, usage.Tokens) error
	Release(context.Context, ReleaseReason) error
}

// ExpiredReservationRecoverer is the optional bounded maintenance boundary
// used by runtime recovery workers. HTTP and routing code do not depend on it.
type ExpiredReservationRecoverer interface {
	RecoverExpired(context.Context, time.Time, int) (int, error)
}

type ReservationRequest struct {
	KeyID     string
	RequestID string
	Attempt   int
	WindowUTC time.Time
	Estimate  int64
}

func (r ReservationRequest) Validate() error {
	if err := validateID("key ID", r.KeyID); err != nil {
		return err
	}
	if err := validateID("request ID", r.RequestID); err != nil {
		return err
	}
	if r.Attempt < 1 || r.Attempt > MaxAttempt {
		return fmt.Errorf("%w: attempt is outside 1..%d", ErrInvalid, MaxAttempt)
	}
	if r.WindowUTC.IsZero() {
		return fmt.Errorf("%w: UTC window is required", ErrInvalid)
	}
	if r.Estimate < 1 || r.Estimate > MaxTokenCount {
		return fmt.Errorf("%w: estimate is outside 1..%d", ErrInvalid, MaxTokenCount)
	}
	return nil
}

func validateID(name, value string) error {
	if strings.TrimSpace(value) == "" || len(value) > MaxIdentifierLength {
		return fmt.Errorf("%w: %s must be non-empty and at most %d bytes", ErrInvalid, name, MaxIdentifierLength)
	}
	return nil
}

type ReleaseReason string

const ReleaseUnaccepted ReleaseReason = "unaccepted"

func (r ReleaseReason) Validate() error {
	if r != ReleaseUnaccepted {
		return fmt.Errorf("%w: unsupported release reason", ErrInvalid)
	}
	return nil
}

// Identity is the redacted, request-scoped information needed to reserve a
// later upstream attempt. It deliberately contains no credential or content.
type Identity struct {
	KeyID     string
	RequestID string
	WindowUTC time.Time
}

func (i Identity) Validate() error {
	if err := validateID("key ID", i.KeyID); err != nil {
		return err
	}
	if err := validateID("request ID", i.RequestID); err != nil {
		return err
	}
	if i.WindowUTC.IsZero() {
		return fmt.Errorf("%w: UTC window is required", ErrInvalid)
	}
	return nil
}

type authorityContextKey struct{}
type reservationContextKey struct{}

type authorityContextValue struct {
	authority TokenBudgetAuthority
	identity  Identity
}

func WithAuthority(ctx context.Context, authority TokenBudgetAuthority, identity Identity) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, authorityContextKey{}, authorityContextValue{authority: authority, identity: identity})
}

func AuthorityFromContext(ctx context.Context) (TokenBudgetAuthority, Identity, bool) {
	if ctx == nil {
		return nil, Identity{}, false
	}
	value, ok := ctx.Value(authorityContextKey{}).(authorityContextValue)
	// Preserve an invalid identity so Reserve validation fails closed. Treating
	// it as an absent authority would silently bypass a configured hard limit.
	return value.authority, value.identity, ok && value.authority != nil
}

func WithReservation(ctx context.Context, reservation TokenReservation) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, reservationContextKey{}, reservation)
}

func ReservationFromContext(ctx context.Context) (TokenReservation, bool) {
	if ctx == nil {
		return nil, false
	}
	reservation, ok := ctx.Value(reservationContextKey{}).(TokenReservation)
	return reservation, ok && reservation != nil
}

// AccountedTokens validates canonical provider usage and returns the amount
// charged against limits. Provider total is authoritative when reported;
// otherwise input plus output is used. Cache and reasoning dimensions are
// persisted as evidence but are not added again because providers report them
// as subsets of input/output.
func AccountedTokens(tokens usage.Tokens) (int64, error) {
	values := []*int64{tokens.Input, tokens.Output, tokens.CachedRead, tokens.CachedWrite, tokens.Reasoning, tokens.Total}
	for _, value := range values {
		if value != nil && (*value < 0 || *value > MaxTokenCount) {
			return 0, fmt.Errorf("%w: actual token count is outside the bounded range", ErrInvalid)
		}
	}
	if tokens.Total != nil {
		return *tokens.Total, nil
	}
	var total int64
	for _, value := range []*int64{tokens.Input, tokens.Output} {
		if value == nil {
			continue
		}
		if total > MaxTokenCount-*value {
			return 0, fmt.Errorf("%w: actual token total exceeds %d", ErrInvalid, MaxTokenCount)
		}
		total += *value
	}
	return total, nil
}
