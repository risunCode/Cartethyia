package repositories

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry/usage"
	router "github.com/cartethyia/daemon/internal/router"
)

func tokenReq() router.ReservationRequest {
	return router.ReservationRequest{
		KeyID: "key-1", RequestID: "req-1", Attempt: 1,
		WindowUTC: time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC), Estimate: 10,
	}
}

func TestTokenBudgetReserveHappy(t *testing.T) {
	db, mock := newFakeBun(t)
	r := NewBunTokenBudgetRepository(db)
	req := tokenReq()

	mock.ExpectBegin()
	expectAnyQueryRows(mock, []string{"a", "b", "c", "d", "e"}, []any{nil, nil, nil, int64(0), int64(0)})
	expectAnyQueryErr(mock, sql.ErrNoRows)
	expectAnyExec(mock, nil)
	expectAnyExec(mock, nil)
	expectAnyQueryRows(mock, []string{"committed", "reserved"}, []any{int64(0), int64(0)})
	expectAnyQueryRows(mock, []string{"committed", "reserved"}, []any{int64(0), int64(0)})
	expectAnyExec(mock, nil)
	expectAnyExec(mock, nil)
	expectAnyExec(mock, nil)
	expectAnyExec(mock, nil)
	mock.ExpectCommit()

	handle, err := r.Reserve(context.Background(), req)
	if err != nil || handle == nil {
		t.Fatalf("Reserve = %v err=%v", handle, err)
	}
}

func TestTokenBudgetReserveLimitExceeded(t *testing.T) {
	db, mock := newFakeBun(t)
	r := NewBunTokenBudgetRepository(db)
	req := tokenReq()
	limit := int64(5)

	mock.ExpectBegin()
	expectAnyQueryRows(mock, []string{"a", "b", "c", "d", "e"}, []any{nil, nil, limit, int64(0), int64(0)})
	expectAnyQueryErr(mock, sql.ErrNoRows)
	expectAnyExec(mock, nil)
	expectAnyExec(mock, nil)
	expectAnyQueryRows(mock, []string{"committed", "reserved"}, []any{int64(0), int64(0)})
	expectAnyQueryRows(mock, []string{"committed", "reserved"}, []any{int64(0), int64(0)})
	mock.ExpectRollback()

	_, err := r.Reserve(context.Background(), req)
	if !errors.Is(err, router.ErrLimit) {
		t.Fatalf("want ErrLimit got %v", err)
	}
}

func TestTokenBudgetRecoverExpired(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("empty", func(t *testing.T) {
		db, mock := newFakeBun(t)
		r := NewBunTokenBudgetRepository(db)
		expectAnyQueryRows(mock, []string{"key_id", "request_id", "attempt"})
		n, err := r.RecoverExpired(ctx, now, 10)
		if err != nil || n != 0 {
			t.Fatalf("RecoverExpired empty = %d err=%v", n, err)
		}
	})

	t.Run("one", func(t *testing.T) {
		db, mock := newFakeBun(t)
		r := NewBunTokenBudgetRepository(db)
		expectAnyQueryRows(mock, []string{"key_id", "request_id", "attempt"}, []any{"key-1", "req-1", 1})
		mock.ExpectBegin()
		expectAnyQueryRows(mock, []string{"a", "b", "c", "d", "e"}, []any{nil, nil, nil, int64(0), int64(0)})
		past := now.Add(-time.Minute)
		day := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
		month := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
		expectAnyQueryRows(mock, []string{"w", "d", "m", "est", "com", "status", "reason", "in", "out", "cr", "cw", "rs", "tot", "exp"},
			[]any{now, day, month, int64(10), int64(0), "reserved", nil, nil, nil, nil, nil, nil, nil, past})
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		mock.ExpectCommit()
		n, err := r.RecoverExpired(ctx, now, 10)
		if err != nil || n != 1 {
			t.Fatalf("RecoverExpired one = %d err=%v", n, err)
		}
	})
}

func TestTokenBudgetReleaseAndReconcile(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	day := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	month := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	db, mock := newFakeBun(t)
	r := NewBunTokenBudgetRepository(db)
	handle := &durableReservation{repository: r, keyID: "key-1", requestID: "req-1", attempt: 1}

	t.Run("release", func(t *testing.T) {
		mock.ExpectBegin()
		expectAnyQueryRows(mock, []string{"a", "b", "c", "d", "e"}, []any{nil, nil, nil, int64(0), int64(0)})
		expectAnyQueryRows(mock, []string{"w", "d", "m", "est", "com", "status", "reason", "in", "out", "cr", "cw", "rs", "tot", "exp"},
			[]any{now, day, month, int64(10), int64(0), "reserved", nil, nil, nil, nil, nil, nil, nil, now.Add(time.Minute)})
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		mock.ExpectCommit()
		if err := handle.Release(ctx, router.ReleaseUnaccepted); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("reconcile", func(t *testing.T) {
		mock.ExpectBegin()
		expectAnyQueryRows(mock, []string{"a", "b", "c", "d", "e"}, []any{nil, nil, nil, int64(0), int64(0)})
		expectAnyQueryRows(mock, []string{"w", "d", "m", "est", "com", "status", "reason", "in", "out", "cr", "cw", "rs", "tot", "exp"},
			[]any{now, day, month, int64(10), int64(0), "reserved", nil, nil, nil, nil, nil, nil, nil, now.Add(time.Minute)})
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		expectAnyExec(mock, nil)
		mock.ExpectCommit()
		total := int64(8)
		if err := handle.Reconcile(ctx, usage.Tokens{Total: &total}); err != nil {
			t.Fatal(err)
		}
	})
}
