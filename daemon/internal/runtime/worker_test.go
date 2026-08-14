package runtime

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryGroupCoalescesProbeAndRestarts(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	startupRelease := make(chan struct{})
	manualStarted := make(chan struct{})
	manualRelease := make(chan struct{})
	g := NewRecoveryGroup(RecoveryWorker{
		Name: "cache",
		Probe: func(context.Context) error {
			n := calls.Add(1)
			if n == 1 {
				close(started)
				<-startupRelease
			} else {
				select {
				case <-manualStarted:
				default:
					close(manualStarted)
				}
				<-manualRelease
			}
			return nil
		},
		Interval: time.Hour,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := g.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("startup probe did not run")
	}
	close(startupRelease)
	time.Sleep(10 * time.Millisecond)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = g.ProbeNow(context.Background(), "cache")
		}(i)
	}
	select {
	case <-manualStarted:
	case <-time.After(time.Second):
		t.Fatal("manual probe did not start")
	}
	time.Sleep(20 * time.Millisecond)
	close(manualRelease)
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatalf("probe calls=%d, want startup plus one coalesced probe", calls.Load())
	}
	for _, err := range errs {
		if err != nil {
			t.Fatalf("coalesced probe: %v", err)
		}
	}
	closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
	defer closeCancel()
	if err := g.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	if err := g.Start(context.Background()); err != nil {
		t.Fatalf("restart: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for calls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	closeCtx, closeCancel = context.WithTimeout(context.Background(), time.Second)
	defer closeCancel()
	if err := g.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	if calls.Load() < 3 {
		t.Fatalf("restart did not probe, calls=%d", calls.Load())
	}
}

func TestRecoveryGroupPreservesQuarantine(t *testing.T) {
	var calls atomic.Int32
	g := NewRecoveryGroup(RecoveryWorker{
		Name:     "account",
		Probe:    func(context.Context) error { calls.Add(1); return nil },
		Interval: time.Millisecond,
		Eligible: func() bool { return false },
	})
	if err := g.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatalf("quarantined worker probed %d times", calls.Load())
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := g.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeStartupOrderAndOptionalDegradation(t *testing.T) {
	var mu sync.Mutex
	order := make([]string, 0, 2)
	probe := func(name string, err error) Probe {
		return func(context.Context) error {
			mu.Lock()
			order = append(order, name)
			mu.Unlock()
			return err
		}
	}
	r, err := NewWithOptions(Config{ListenAddress: "127.0.0.1:0"}, RuntimeOptions{
		Dependencies: []RuntimeDependency{
			{Name: "auth", Required: true, Probe: probe("auth", nil)},
			{Name: "redis", Required: false, Probe: probe("redis", errors.New("offline"))},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan error, 1)
	go func() { started <- r.Start(ctx) }()
	deadline := time.Now().Add(time.Second)
	for r.Readiness().State == StateStarting && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := r.Readiness(); got.State != StateDegraded || got.Ready {
		t.Fatalf("optional degradation readiness=%#v", got)
	}
	mu.Lock()
	gotOrder := append([]string(nil), order...)
	mu.Unlock()
	if len(gotOrder) < 2 || gotOrder[0] != "auth" || gotOrder[1] != "redis" {
		t.Fatalf("probe order=%v", gotOrder)
	}
	cancel()
	if err := <-started; err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeShutdownDeadlineIsCoded(t *testing.T) {
	closeStarted := make(chan struct{})
	r, err := NewWithOptions(Config{ListenAddress: "127.0.0.1:0", ShutdownTimeout: 10 * time.Millisecond}, RuntimeOptions{
		Dependencies: []RuntimeDependency{{Name: "slow", Required: false, Probe: func(context.Context) error { return nil }, Close: func(ctx context.Context) error {
			close(closeStarted)
			<-ctx.Done()
			return ctx.Err()
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan error, 1)
	go func() { started <- r.Start(ctx) }()
	deadline := time.Now().Add(time.Second)
	for r.Readiness().State == StateStarting && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-closeStarted
	err = <-started
	if !errors.Is(err, context.DeadlineExceeded) || CodeOf(err) != CodeShutdownDeadline {
		t.Fatalf("shutdown error=%v code=%q", err, CodeOf(err))
	}
}
