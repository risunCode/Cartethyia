package tokenbudget

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability/usage"
)

func int64Ptr(v int64) *int64 { return &v }

func validRequest() ReservationRequest {
	return ReservationRequest{
		KeyID:     "key-1",
		RequestID: "req-1",
		Attempt:   1,
		WindowUTC: time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC),
		Estimate:  100,
	}
}

func validIdentity() Identity {
	return Identity{
		KeyID:     "key-1",
		RequestID: "req-1",
		WindowUTC: time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC),
	}
}

// memoryAuthority is an in-memory TokenBudgetAuthority for lifecycle tests.
type memoryAuthority struct {
	limit         int64
	reserved      map[string]int64
	reconciled    map[string]int64
	released      map[string]ReleaseReason
	reserveErr    error
	forceLimit    bool
	forceConflict bool
}

func newMemoryAuthority(limit int64) *memoryAuthority {
	return &memoryAuthority{
		limit:      limit,
		reserved:   make(map[string]int64),
		reconciled: make(map[string]int64),
		released:   make(map[string]ReleaseReason),
	}
}

func reservationKey(req ReservationRequest) string {
	return req.KeyID + "/" + req.RequestID + "/" + string(rune('0'+req.Attempt))
}

func (a *memoryAuthority) Reserve(ctx context.Context, req ReservationRequest) (TokenReservation, error) {
	if a == nil {
		return nil, ErrUnavailable
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	if a.reserveErr != nil {
		return nil, a.reserveErr
	}
	if a.forceLimit {
		return nil, ErrLimit
	}
	key := reservationKey(req)
	if existing, ok := a.reserved[key]; ok {
		if existing != req.Estimate || a.forceConflict {
			return nil, ErrConflict
		}
		return &memoryReservation{authority: a, key: key, estimate: req.Estimate}, nil
	}
	var used int64
	for _, v := range a.reserved {
		used += v
	}
	for k, v := range a.reconciled {
		if _, still := a.reserved[k]; !still {
			used += v
		}
	}
	if used+req.Estimate > a.limit {
		return nil, ErrLimit
	}
	a.reserved[key] = req.Estimate
	return &memoryReservation{authority: a, key: key, estimate: req.Estimate}, nil
}

type memoryReservation struct {
	authority *memoryAuthority
	key       string
	estimate  int64
	done      bool
}

func (r *memoryReservation) Reconcile(ctx context.Context, tokens usage.Tokens) error {
	if r == nil || r.authority == nil {
		return ErrUnavailable
	}
	if r.done {
		return nil
	}
	actual, err := AccountedTokens(tokens)
	if err != nil {
		return err
	}
	delete(r.authority.reserved, r.key)
	r.authority.reconciled[r.key] = actual
	r.done = true
	return nil
}

func (r *memoryReservation) Release(ctx context.Context, reason ReleaseReason) error {
	if r == nil || r.authority == nil {
		return ErrUnavailable
	}
	if err := reason.Validate(); err != nil {
		return err
	}
	if r.done {
		return nil
	}
	delete(r.authority.reserved, r.key)
	r.authority.released[r.key] = reason
	r.done = true
	return nil
}

func TestReservationRequestValidate(t *testing.T) {
	t.Parallel()

	base := validRequest()
	if err := base.Validate(); err != nil {
		t.Fatalf("valid request: %v", err)
	}

	cases := []struct {
		name string
		mut  func(*ReservationRequest)
	}{
		{"empty key", func(r *ReservationRequest) { r.KeyID = "" }},
		{"whitespace key", func(r *ReservationRequest) { r.KeyID = "   " }},
		{"long key", func(r *ReservationRequest) { r.KeyID = strings.Repeat("k", MaxIdentifierLength+1) }},
		{"empty request id", func(r *ReservationRequest) { r.RequestID = "" }},
		{"long request id", func(r *ReservationRequest) { r.RequestID = strings.Repeat("r", MaxIdentifierLength+1) }},
		{"attempt zero", func(r *ReservationRequest) { r.Attempt = 0 }},
		{"attempt too high", func(r *ReservationRequest) { r.Attempt = MaxAttempt + 1 }},
		{"zero window", func(r *ReservationRequest) { r.WindowUTC = time.Time{} }},
		{"estimate zero", func(r *ReservationRequest) { r.Estimate = 0 }},
		{"estimate too high", func(r *ReservationRequest) { r.Estimate = MaxTokenCount + 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := validRequest()
			tc.mut(&req)
			if err := req.Validate(); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v, want ErrInvalid", err)
			}
		})
	}

	t.Run("boundary attempt and estimate", func(t *testing.T) {
		t.Parallel()
		req := validRequest()
		req.Attempt = MaxAttempt
		req.Estimate = MaxTokenCount
		req.KeyID = strings.Repeat("k", MaxIdentifierLength)
		req.RequestID = strings.Repeat("r", MaxIdentifierLength)
		if err := req.Validate(); err != nil {
			t.Fatalf("boundary valid: %v", err)
		}
	})
}

func TestIdentityValidate(t *testing.T) {
	t.Parallel()

	if err := validIdentity().Validate(); err != nil {
		t.Fatalf("valid identity: %v", err)
	}

	cases := []struct {
		name string
		mut  func(*Identity)
	}{
		{"empty key", func(i *Identity) { i.KeyID = "" }},
		{"long request id", func(i *Identity) { i.RequestID = strings.Repeat("r", MaxIdentifierLength+1) }},
		{"zero window", func(i *Identity) { i.WindowUTC = time.Time{} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			id := validIdentity()
			tc.mut(&id)
			if err := id.Validate(); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v, want ErrInvalid", err)
			}
		})
	}
}

func TestReleaseReasonValidate(t *testing.T) {
	t.Parallel()

	if err := ReleaseUnaccepted.Validate(); err != nil {
		t.Fatalf("ReleaseUnaccepted: %v", err)
	}
	if err := ReleaseReason("accepted").Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unsupported reason: got %v", err)
	}
	if err := ReleaseReason("").Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty reason: got %v", err)
	}
}

func TestAuthorityContextHelpers(t *testing.T) {
	t.Parallel()

	auth, id, ok := AuthorityFromContext(nil)
	if ok || auth != nil || id != (Identity{}) {
		t.Fatalf("nil ctx: auth=%v id=%v ok=%v", auth, id, ok)
	}

	auth, id, ok = AuthorityFromContext(context.Background())
	if ok || auth != nil {
		t.Fatalf("missing authority: ok=%v auth=%v", ok, auth)
	}

	mem := newMemoryAuthority(1000)
	identity := validIdentity()

	ctx := WithAuthority(nil, mem, identity)
	gotAuth, gotID, ok := AuthorityFromContext(ctx)
	if !ok || gotAuth != mem || gotID != identity {
		t.Fatalf("WithAuthority(nil): ok=%v auth=%v id=%v", ok, gotAuth, gotID)
	}

	ctx = WithAuthority(context.Background(), mem, identity)
	gotAuth, gotID, ok = AuthorityFromContext(ctx)
	if !ok || gotAuth != mem || gotID != identity {
		t.Fatalf("WithAuthority: ok=%v auth=%v id=%v", ok, gotAuth, gotID)
	}

	// Nil authority must report absent even when identity is present.
	ctx = WithAuthority(context.Background(), nil, identity)
	gotAuth, gotID, ok = AuthorityFromContext(ctx)
	if ok || gotAuth != nil {
		t.Fatalf("nil authority should be absent: ok=%v auth=%v", ok, gotAuth)
	}
	if gotID != identity {
		t.Fatalf("identity should still be returned: got %#v", gotID)
	}

	// Invalid identity is preserved so Reserve fails closed.
	badID := Identity{KeyID: "key", RequestID: "req"} // zero WindowUTC
	ctx = WithAuthority(context.Background(), mem, badID)
	gotAuth, gotID, ok = AuthorityFromContext(ctx)
	if !ok || gotAuth != mem || gotID != badID {
		t.Fatalf("invalid identity not preserved: ok=%v auth=%v id=%v", ok, gotAuth, gotID)
	}
	if err := gotID.Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected invalid identity, got %v", err)
	}
}

func TestReservationContextHelpers(t *testing.T) {
	t.Parallel()

	res, ok := ReservationFromContext(nil)
	if ok || res != nil {
		t.Fatalf("nil ctx: res=%v ok=%v", res, ok)
	}
	res, ok = ReservationFromContext(context.Background())
	if ok || res != nil {
		t.Fatalf("missing: res=%v ok=%v", res, ok)
	}

	fake := &memoryReservation{key: "k", estimate: 10}
	ctx := WithReservation(nil, fake)
	got, ok := ReservationFromContext(ctx)
	if !ok || got != fake {
		t.Fatalf("WithReservation(nil): ok=%v got=%v", ok, got)
	}

	ctx = WithReservation(context.Background(), fake)
	got, ok = ReservationFromContext(ctx)
	if !ok || got != fake {
		t.Fatalf("WithReservation: ok=%v got=%v", ok, got)
	}

	ctx = WithReservation(context.Background(), nil)
	got, ok = ReservationFromContext(ctx)
	if ok || got != nil {
		t.Fatalf("nil reservation should be absent: ok=%v got=%v", ok, got)
	}
}

func TestAccountedTokens(t *testing.T) {
	t.Parallel()

	t.Run("total is authoritative", func(t *testing.T) {
		t.Parallel()
		got, err := AccountedTokens(usage.Tokens{
			Input:  int64Ptr(10),
			Output: int64Ptr(20),
			Total:  int64Ptr(99),
		})
		if err != nil || got != 99 {
			t.Fatalf("got %d err=%v, want 99", got, err)
		}
	})

	t.Run("input plus output when total absent", func(t *testing.T) {
		t.Parallel()
		got, err := AccountedTokens(usage.Tokens{
			Input:       int64Ptr(10),
			Output:      int64Ptr(20),
			CachedRead:  int64Ptr(5),
			CachedWrite: int64Ptr(3),
			Reasoning:   int64Ptr(7),
		})
		if err != nil || got != 30 {
			t.Fatalf("got %d err=%v, want 30", got, err)
		}
	})

	t.Run("nil fields yield zero", func(t *testing.T) {
		t.Parallel()
		got, err := AccountedTokens(usage.Tokens{})
		if err != nil || got != 0 {
			t.Fatalf("got %d err=%v, want 0", got, err)
		}
	})

	t.Run("only input", func(t *testing.T) {
		t.Parallel()
		got, err := AccountedTokens(usage.Tokens{Input: int64Ptr(42)})
		if err != nil || got != 42 {
			t.Fatalf("got %d err=%v, want 42", got, err)
		}
	})

	t.Run("negative rejects", func(t *testing.T) {
		t.Parallel()
		_, err := AccountedTokens(usage.Tokens{Input: int64Ptr(-1)})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("above max rejects", func(t *testing.T) {
		t.Parallel()
		_, err := AccountedTokens(usage.Tokens{Output: int64Ptr(MaxTokenCount + 1)})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("total above max rejects", func(t *testing.T) {
		t.Parallel()
		_, err := AccountedTokens(usage.Tokens{Total: int64Ptr(MaxTokenCount + 1)})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("sum overflow rejects", func(t *testing.T) {
		t.Parallel()
		_, err := AccountedTokens(usage.Tokens{
			Input:  int64Ptr(MaxTokenCount),
			Output: int64Ptr(1),
		})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("boundary max accepted via total", func(t *testing.T) {
		t.Parallel()
		got, err := AccountedTokens(usage.Tokens{Total: int64Ptr(MaxTokenCount)})
		if err != nil || got != MaxTokenCount {
			t.Fatalf("got %d err=%v", got, err)
		}
	})
}

func TestReservationLifecycle(t *testing.T) {
	t.Parallel()

	auth := newMemoryAuthority(500)
	req := validRequest()
	req.Estimate = 100

	res, err := auth.Reserve(context.Background(), req)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}

	// Idempotent re-reserve with same estimate.
	again, err := auth.Reserve(context.Background(), req)
	if err != nil {
		t.Fatalf("idempotent reserve: %v", err)
	}
	_ = again

	// Conflict on estimate change.
	conflict := req
	conflict.Estimate = 150
	if _, err := auth.Reserve(context.Background(), conflict); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict: got %v", err)
	}

	// Release returns budget.
	if err := res.Release(context.Background(), ReleaseUnaccepted); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := res.Release(context.Background(), ReleaseUnaccepted); err != nil {
		t.Fatalf("idempotent release: %v", err)
	}
	if err := res.Release(context.Background(), ReleaseReason("nope")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad release reason: %v", err)
	}

	// Fresh reservation then reconcile.
	res2, err := auth.Reserve(context.Background(), req)
	if err != nil {
		t.Fatalf("re-reserve: %v", err)
	}
	if err := res2.Reconcile(context.Background(), usage.Tokens{
		Input:  int64Ptr(40),
		Output: int64Ptr(35),
	}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if err := res2.Reconcile(context.Background(), usage.Tokens{Total: int64Ptr(1)}); err != nil {
		t.Fatalf("idempotent reconcile: %v", err)
	}

	key := reservationKey(req)
	if got := auth.reconciled[key]; got != 75 {
		t.Fatalf("reconciled=%d, want 75", got)
	}
}

func TestReservationErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("invalid request", func(t *testing.T) {
		t.Parallel()
		auth := newMemoryAuthority(1000)
		_, err := auth.Reserve(context.Background(), ReservationRequest{})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("limit exceeded", func(t *testing.T) {
		t.Parallel()
		auth := newMemoryAuthority(50)
		req := validRequest()
		req.Estimate = 100
		_, err := auth.Reserve(context.Background(), req)
		if !errors.Is(err, ErrLimit) {
			t.Fatalf("got %v, want ErrLimit", err)
		}
	})

	t.Run("forced unavailable", func(t *testing.T) {
		t.Parallel()
		auth := newMemoryAuthority(1000)
		auth.reserveErr = ErrUnavailable
		_, err := auth.Reserve(context.Background(), validRequest())
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("got %v, want ErrUnavailable", err)
		}
	})

	t.Run("nil authority", func(t *testing.T) {
		t.Parallel()
		var auth *memoryAuthority
		_, err := auth.Reserve(context.Background(), validRequest())
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("got %v, want ErrUnavailable", err)
		}
	})

	t.Run("reconcile invalid tokens", func(t *testing.T) {
		t.Parallel()
		auth := newMemoryAuthority(1000)
		res, err := auth.Reserve(context.Background(), validRequest())
		if err != nil {
			t.Fatal(err)
		}
		if err := res.Reconcile(context.Background(), usage.Tokens{Input: int64Ptr(-5)}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("got %v, want ErrInvalid", err)
		}
	})

	t.Run("nil reservation methods", func(t *testing.T) {
		t.Parallel()
		var res *memoryReservation
		if err := res.Reconcile(context.Background(), usage.Tokens{}); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("reconcile: %v", err)
		}
		if err := res.Release(context.Background(), ReleaseUnaccepted); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("release: %v", err)
		}
	})
}

func TestContextReservationLifecycle(t *testing.T) {
	t.Parallel()

	auth := newMemoryAuthority(1000)
	identity := validIdentity()
	ctx := WithAuthority(context.Background(), auth, identity)

	gotAuth, gotID, ok := AuthorityFromContext(ctx)
	if !ok {
		t.Fatal("authority missing from context")
	}
	if err := gotID.Validate(); err != nil {
		t.Fatalf("identity: %v", err)
	}

	req := ReservationRequest{
		KeyID:     gotID.KeyID,
		RequestID: gotID.RequestID,
		Attempt:   2,
		WindowUTC: gotID.WindowUTC,
		Estimate:  200,
	}
	res, err := gotAuth.Reserve(ctx, req)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}

	ctx = WithReservation(ctx, res)
	stored, ok := ReservationFromContext(ctx)
	if !ok {
		t.Fatal("reservation missing from context")
	}
	if err := stored.Release(ctx, ReleaseUnaccepted); err != nil {
		t.Fatalf("release via context: %v", err)
	}
}
