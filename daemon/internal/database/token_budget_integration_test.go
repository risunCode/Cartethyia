package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
)

func TestPostgreSQLTokenBudgetIntegration(t *testing.T) {
	rawURL := os.Getenv("CARTETHYIA_POSTGRES_URL")
	if rawURL == "" {
		t.Skip("set CARTETHYIA_POSTGRES_URL to run PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	store, err := OpenRuntime(ctx, rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())

	sequence := atomic.Int64{}
	newKey := func(t *testing.T, daily, monthly, lifetime any) string {
		t.Helper()
		suffix := fmt.Sprintf("%d-%d", time.Now().UnixNano(), sequence.Add(1))
		id := "token-budget-" + suffix
		_, err := store.Database.Bun().NewRaw(`INSERT INTO api_keys
(id, name, key, key_prefix, active, daily_token_limit, monthly_token_limit, one_time_token_limit, created_at)
VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, NOW())`, id, id, "fixture-secret-"+suffix, "fixture", daily, monthly, lifetime).Exec(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = store.Database.Bun().NewRaw(`DELETE FROM api_keys WHERE id = ?`, id).Exec(context.Background())
		})
		return id
	}
	reserve := func(t *testing.T, keyID, requestID string, attempt int, window time.Time, estimate int64) tokenbudget.TokenReservation {
		t.Helper()
		reservation, err := store.TokenBudget.Reserve(ctx, tokenbudget.ReservationRequest{KeyID: keyID, RequestID: requestID, Attempt: attempt, WindowUTC: window, Estimate: estimate})
		if err != nil {
			t.Fatal(err)
		}
		return reservation
	}
	counter := func(t *testing.T, keyID string) (int64, int64) {
		t.Helper()
		var committed, reserved int64
		if err := store.Database.Bun().NewRaw(`SELECT one_time_tokens_used, one_time_tokens_reserved FROM api_keys WHERE id = ?`, keyID).Scan(ctx, &committed, &reserved); err != nil {
			t.Fatal(err)
		}
		return committed, reserved
	}
	now := time.Date(2026, time.January, 31, 23, 59, 0, 0, time.UTC)

	t.Run("competing reservations are atomic", func(t *testing.T) {
		keyID := newKey(t, nil, nil, int64(100))
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for attempt := 1; attempt <= 2; attempt++ {
			attempt := attempt
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, err := store.TokenBudget.Reserve(ctx, tokenbudget.ReservationRequest{KeyID: keyID, RequestID: "concurrent", Attempt: attempt, WindowUTC: now, Estimate: 60})
				errs <- err
			}()
		}
		close(start)
		wg.Wait()
		close(errs)
		var admitted, limited int
		for err := range errs {
			switch {
			case err == nil:
				admitted++
			case errors.Is(err, tokenbudget.ErrLimit):
				limited++
			default:
				t.Fatalf("reserve error = %v", err)
			}
		}
		if admitted != 1 || limited != 1 {
			t.Fatalf("admitted=%d limited=%d", admitted, limited)
		}
	})

	t.Run("duplicate reservation and reconciliation are idempotent", func(t *testing.T) {
		keyID := newKey(t, nil, nil, int64(100))
		first := reserve(t, keyID, "duplicate", 1, now, 40)
		second := reserve(t, keyID, "duplicate", 1, now, 40)
		actual := int64(25)
		tokens := usage.Tokens{Total: &actual}
		if err := first.Reconcile(ctx, tokens); err != nil {
			t.Fatal(err)
		}
		if err := second.Reconcile(ctx, tokens); err != nil {
			t.Fatal(err)
		}
		committed, reserved := counter(t, keyID)
		if committed != 25 || reserved != 0 {
			t.Fatalf("committed=%d reserved=%d", committed, reserved)
		}
	})

	t.Run("retry attempts account independently", func(t *testing.T) {
		keyID := newKey(t, nil, nil, int64(200))
		first := reserve(t, keyID, "retry", 1, now, 50)
		second := reserve(t, keyID, "retry", 2, now, 50)
		if err := first.Release(ctx, tokenbudget.ReleaseUnaccepted); err != nil {
			t.Fatal(err)
		}
		actual := int64(35)
		if err := second.Reconcile(ctx, usage.Tokens{Total: &actual}); err != nil {
			t.Fatal(err)
		}
		committed, reserved := counter(t, keyID)
		if committed != 35 || reserved != 0 {
			t.Fatalf("committed=%d reserved=%d", committed, reserved)
		}
	})

	t.Run("expired reservations recover conservatively in bounded batches", func(t *testing.T) {
		keyID := newKey(t, nil, nil, int64(100))
		reserve(t, keyID, "expired", 1, now, 70)
		recovered, err := store.TokenBudget.RecoverExpired(ctx, time.Now().UTC().Add(time.Hour), 1)
		if err != nil {
			t.Fatal(err)
		}
		if recovered != 1 {
			t.Fatalf("recovered=%d", recovered)
		}
		committed, reserved := counter(t, keyID)
		if committed != 70 || reserved != 0 {
			t.Fatalf("committed=%d reserved=%d", committed, reserved)
		}
	})

	t.Run("over estimate refunds and under estimate commits", func(t *testing.T) {
		overKey := newKey(t, nil, nil, int64(200))
		over := reserve(t, overKey, "over", 1, now, 100)
		actualForty := int64(40)
		if err := over.Reconcile(ctx, usage.Tokens{Total: &actualForty}); err != nil {
			t.Fatal(err)
		}
		committed, reserved := counter(t, overKey)
		if committed != 40 || reserved != 0 {
			t.Fatalf("over-estimate committed=%d reserved=%d", committed, reserved)
		}

		underKey := newKey(t, nil, nil, int64(100))
		under := reserve(t, underKey, "under", 1, now, 80)
		actualHundredTwenty := int64(120)
		if err := under.Reconcile(ctx, usage.Tokens{Total: &actualHundredTwenty}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.TokenBudget.Reserve(ctx, tokenbudget.ReservationRequest{KeyID: underKey, RequestID: "after-under", Attempt: 1, WindowUTC: now, Estimate: 1}); !errors.Is(err, tokenbudget.ErrLimit) {
			t.Fatalf("later reserve error=%v", err)
		}
		committed, reserved = counter(t, underKey)
		if committed != 120 || reserved != 0 {
			t.Fatalf("under-estimate committed=%d reserved=%d", committed, reserved)
		}
	})

	t.Run("unknown accepted usage retains estimate", func(t *testing.T) {
		keyID := newKey(t, nil, nil, int64(100))
		reservation := reserve(t, keyID, "unknown", 1, now, 55)
		if err := reservation.Reconcile(ctx, usage.Tokens{}); err != nil {
			t.Fatal(err)
		}
		committed, reserved := counter(t, keyID)
		if committed != 55 || reserved != 0 {
			t.Fatalf("committed=%d reserved=%d", committed, reserved)
		}
	})

	t.Run("UTC daily and monthly windows roll over", func(t *testing.T) {
		dailyKey := newKey(t, int64(100), nil, nil)
		firstDay := reserve(t, dailyKey, "daily-one", 1, now, 80)
		actual := int64(80)
		if err := firstDay.Reconcile(ctx, usage.Tokens{Total: &actual}); err != nil {
			t.Fatal(err)
		}
		secondDay := now.Add(2 * time.Minute)
		reserve(t, dailyKey, "daily-two", 1, secondDay, 80)

		monthlyKey := newKey(t, nil, int64(100), nil)
		firstMonth := reserve(t, monthlyKey, "month-one", 1, now, 80)
		if err := firstMonth.Reconcile(ctx, usage.Tokens{Total: &actual}); err != nil {
			t.Fatal(err)
		}
		secondMonth := time.Date(2026, time.February, 1, 0, 1, 0, 0, time.UTC)
		reserve(t, monthlyKey, "month-two", 1, secondMonth, 80)
	})
}
