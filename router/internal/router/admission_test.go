package router

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLimiterBlocksAndReleasesExactlyOnce(t *testing.T) {
	l, err := NewAdmissionLimiter(Layer{Name: "global", Limit: 1}, Layer{Name: "key", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	first, err := l.Acquire(context.Background(), map[string]string{"global": "g", "key": "k"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := l.Acquire(ctx, map[string]string{"global": "g2", "key": "k2"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait err=%v", err)
	}
	first.Release()
	first.Release()
	second, err := l.Acquire(context.Background(), map[string]string{"global": "g2", "key": "k2"})
	if err != nil {
		t.Fatal(err)
	}
	if got := l.Usage()["global"]; got != 1 {
		t.Fatalf("usage=%d", got)
	}
	second.Release()
}
func TestLimiterCloseWakesWaiter(t *testing.T) {
	l, _ := NewAdmissionLimiter(Layer{Name: "global", Limit: 1})
	lease, _ := l.Acquire(context.Background(), map[string]string{"global": "g"})
	done := make(chan error, 1)
	go func() { _, err := l.Acquire(context.Background(), map[string]string{"global": "other"}); done <- err }()
	time.Sleep(time.Millisecond)
	l.Close()
	select {
	case err := <-done:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("err=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiter not woken")
	}
	lease.Release()
}

func TestLayeredModelKeysAreIndependent(t *testing.T) {
	l, err := NewAdmissionLimiter(
		Layer{Name: "global", Limit: 2},
		Layer{Name: "provider", Limit: 2},
		Layer{Name: "account", Limit: 2},
		Layer{Name: "model", Limit: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	first, err := l.Acquire(context.Background(), map[string]string{
		"global": "g", "provider": "p", "account": "a", "model": "model-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	second, err := l.Acquire(context.Background(), map[string]string{
		"global": "g", "provider": "p", "account": "a", "model": "model-b",
	})
	if err != nil {
		t.Fatalf("independent model blocked: %v", err)
	}
	second.Release()
}

func TestTokenReservationReconcileRetryAndRelease(t *testing.T) {
	l, err := NewAdmissionLimiter(
		Layer{Name: "global", Limit: 2},
		Layer{Name: "model", Limit: 2},
		Layer{Name: "tokens", Limit: 10},
	)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireWithTokens(context.Background(), map[string]string{
		"global": "g", "model": "m", "tokens": "m",
	}, 6)
	if err != nil {
		t.Fatal(err)
	}
	if got := l.Usage()["tokens"]; got != 6 {
		t.Fatalf("reserved tokens=%d", got)
	}
	if err := lease.Reconcile(3); err != nil {
		t.Fatal(err)
	}
	if got := l.Usage()["tokens"]; got != 3 {
		t.Fatalf("reconciled tokens=%d", got)
	}
	if err := lease.ReserveRetry(4); err != nil {
		t.Fatal(err)
	}
	if got := l.Usage()["tokens"]; got != 7 {
		t.Fatalf("retry tokens=%d", got)
	}
	lease.Release()
	lease.Release()
	if got := l.Usage()["tokens"]; got != 0 {
		t.Fatalf("released tokens=%d", got)
	}
	if err := lease.Reconcile(1); !errors.Is(err, ErrReleased) {
		t.Fatalf("reconcile after release=%v", err)
	}
}

func TestWaiterLimitAndFairness(t *testing.T) {
	l, err := NewWithOptions(Options{MaxWaiters: 1}, Layer{Name: "global", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	first, err := l.Acquire(context.Background(), map[string]string{"global": "g"})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	granted := make(chan *Lease, 1)
	go func() {
		lease, _ := l.Acquire(ctx, map[string]string{"global": "first"})
		granted <- lease
	}()
	time.Sleep(time.Millisecond)
	if _, err := l.Acquire(context.Background(), map[string]string{"global": "second"}); !errors.Is(err, AdmissionErrLimit) && AdmissionCodeOf(err) != string(CodeWaiterLimit) {
		t.Fatalf("waiter limit err=%v code=%s", err, AdmissionCodeOf(err))
	}
	first.Release()
	select {
	case lease := <-granted:
		if lease == nil {
			t.Fatal("fair waiter did not acquire")
		}
		lease.Release()
	case <-time.After(time.Second):
		t.Fatal("fair waiter did not wake")
	}
}

func TestBoundedWaiterTimeoutHasStableCode(t *testing.T) {
	l, err := NewWithOptions(Options{MaxWait: 5 * time.Millisecond}, Layer{Name: "global", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.Acquire(context.Background(), map[string]string{"global": "g"})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	_, err = l.Acquire(context.Background(), map[string]string{"global": "other"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error=%v", err)
	}
	if got := AdmissionCodeOf(err); got != string(CodeCanceled) {
		t.Fatalf("timeout code=%q", got)
	}
}

func TestAdmissionStatsTrackActiveWaitersAndCancellation(t *testing.T) {
	l, err := NewWithOptions(Options{MaxWait: 5 * time.Millisecond}, Layer{Name: "global", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.Acquire(context.Background(), map[string]string{"global": "g"})
	if err != nil {
		t.Fatal(err)
	}
	if stats := l.Stats(); stats.Active != 1 || stats.Grants != 1 {
		t.Fatalf("active stats = %+v", stats)
	}
	_, _ = l.Acquire(context.Background(), map[string]string{"global": "other"})
	lease.Release()
	stats := l.Stats()
	if stats.Active != 0 || stats.Canceled == 0 || stats.Waiters != 0 {
		t.Fatalf("final stats = %+v", stats)
	}
}

func TestAdmissionEvidenceSeparatesConcurrencyAndScope(t *testing.T) {
	err := &Error{Code: CodeLimit, Layer: "provider-concurrency"}
	ev := err.Evidence()
	if ev.Source != "local_concurrency_limit" || ev.Scope != "provider" || ev.Phase != "pre_dispatch" {
		t.Fatalf("evidence=%+v", ev)
	}
	if !ev.Retryable {
		t.Fatal("admission limit should carry retryability")
	}
	if code, _, _, _, source, scope, phase := err.LifecycleEvidence(); code != string(CodeLimit) || source != ev.Source || scope != ev.Scope || phase != ev.Phase {
		t.Fatalf("lifecycle evidence mismatch code=%q source=%q scope=%q phase=%q", code, source, scope, phase)
	}
}
