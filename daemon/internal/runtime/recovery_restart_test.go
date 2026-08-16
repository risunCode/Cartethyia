package runtime

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryGroupRestart(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	g := NewRecoveryGroup(RecoveryWorker{
		Name:     "restart-worker",
		Interval: time.Hour,
		Probe: func(context.Context) error {
			n := calls.Add(1)
			if n == 1 {
				close(started)
			}
			return nil
		},
	})
	ctx := context.Background()
	if err := g.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("expected startup probe")
	}
	if err := g.Restart(ctx); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if calls.Load() < 2 {
		t.Fatalf("Restart did not re-probe, calls=%d", calls.Load())
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := g.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
}
