package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestLifecycleStateTransitionsAndReadiness(t *testing.T) {
	lifecycle := NewLifecycle()
	if got := lifecycle.Snapshot(); got.State != StateStarting || !got.Live || got.Ready {
		t.Fatalf("starting snapshot = %#v", got)
	}
	if err := lifecycle.Transition(StateReady, ""); err != nil {
		t.Fatalf("starting -> ready: %v", err)
	}
	if got := lifecycle.Snapshot(); got.State != StateReady || !got.Live || !got.Ready {
		t.Fatalf("ready snapshot = %#v", got)
	}
	if err := lifecycle.Transition(StateDegraded, "dependency unavailable"); err != nil {
		t.Fatalf("ready -> degraded: %v", err)
	}
	if got := lifecycle.Snapshot(); got.State != StateDegraded || got.Ready || !got.Live {
		t.Fatalf("degraded snapshot = %#v", got)
	}
	if err := lifecycle.Transition(StateReady, "dependency recovered"); err != nil {
		t.Fatalf("degraded -> ready: %v", err)
	}
	if err := lifecycle.Transition(StateDraining, strings.Repeat("x", maxDiagnosticBytes+20)); err != nil {
		t.Fatalf("ready -> draining: %v", err)
	}
	if got := lifecycle.Snapshot(); len(got.Diagnostic) != maxDiagnosticBytes || got.Ready {
		t.Fatalf("bounded draining snapshot = %#v", got)
	}
	if err := lifecycle.Transition(StateStopped, ""); err != nil {
		t.Fatalf("draining -> stopped: %v", err)
	}
	if got := lifecycle.Snapshot(); got.Live || got.Ready || got.State != StateStopped {
		t.Fatalf("stopped snapshot = %#v", got)
	}
	if err := lifecycle.Transition(StateReady, ""); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("stopped -> ready error = %v, want ErrInvalidTransition", err)
	}
}

func TestRuntimeStartCancellationStopsExactlyOnce(t *testing.T) {
	runtime, err := New(Config{ListenAddress: ":0"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runtime.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := runtime.Readiness(); got.State != StateStopped || got.Live || got.Ready {
		t.Fatalf("after cancellation = %#v", got)
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestRuntimeRejectsExplicitInvalidConfiguration(t *testing.T) {
	if _, err := New(Config{ListenAddress: ":12800", RequestTimeout: -1}); err == nil {
		t.Fatal("expected invalid timeout error")
	}
}
