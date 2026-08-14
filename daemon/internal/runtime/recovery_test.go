package runtime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryGroupStartsProbesAndCloses(t *testing.T) {
	var calls atomic.Int32
	g := NewRecoveryGroup(RecoveryWorker{Name: "health", Interval: time.Millisecond, Probe: func(context.Context) error { calls.Add(1); return nil }})
	ctx, cancel := context.WithCancel(context.Background())
	if err := g.Start(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	closeCtx, cancelClose := context.WithTimeout(context.Background(), time.Second)
	defer cancelClose()
	if err := g.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	if calls.Load() == 0 {
		t.Fatal("probe not called")
	}
}
func TestRecoveryGroupRejectsInvalidWorker(t *testing.T) {
	g := NewRecoveryGroup(RecoveryWorker{Name: "missing"})
	if err := g.Start(context.Background()); err == nil || errors.Is(err, ErrWorkerClosed) {
		t.Fatalf("err=%v", err)
	}
}
