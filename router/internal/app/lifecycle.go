package app

import (
	"errors"
	"strings"
	"sync"
	"time"
)

const maxDiagnosticBytes = 512

// State is the bounded process lifecycle state exposed by Runtime.Readiness.
type State string

const (
	StateStarting State = "starting"
	StateReady    State = "ready"
	StateDegraded State = "degraded"
	StateDraining State = "draining"
	StateStopped  State = "stopped"
)

var ErrInvalidTransition = &Error{Code: CodeInvalidTransition, Op: "transition", Err: errors.New("invalid lifecycle transition")}

// ReadinessSnapshot distinguishes process liveness from request-path readiness.
type ReadinessSnapshot struct {
	State      State
	Live       bool
	Ready      bool
	Diagnostic string
	ChangedAt  time.Time
}

// Lifecycle owns the runtime state transition rules. Diagnostics are bounded
// and are intended for operator-safe summaries, not raw dependency errors.
type Lifecycle struct {
	mu         sync.RWMutex
	state      State
	diagnostic string
	changedAt  time.Time
}

func NewLifecycle() *Lifecycle {
	return &Lifecycle{state: StateStarting, changedAt: time.Now()}
}

func (l *Lifecycle) Transition(next State, diagnostic string) error {
	if l == nil {
		return runtimeError(CodeInvalidTransition, "transition", errors.New("nil lifecycle"))
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == next {
		return nil
	}
	if !allowedTransition(l.state, next) {
		return ErrInvalidTransition
	}
	l.state = next
	l.diagnostic = boundDiagnostic(diagnostic)
	l.changedAt = time.Now()
	return nil
}

func (l *Lifecycle) Snapshot() ReadinessSnapshot {
	if l == nil {
		return ReadinessSnapshot{State: StateStopped}
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	return ReadinessSnapshot{
		State:      l.state,
		Live:       l.state != StateStopped,
		Ready:      l.state == StateReady,
		Diagnostic: l.diagnostic,
		ChangedAt:  l.changedAt,
	}
}

func allowedTransition(from, to State) bool {
	switch from {
	case StateStarting:
		return to == StateReady || to == StateDegraded || to == StateDraining
	case StateReady:
		return to == StateDegraded || to == StateDraining
	case StateDegraded:
		return to == StateReady || to == StateDraining
	case StateDraining:
		return to == StateStopped
	default:
		return false
	}
}

func boundDiagnostic(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxDiagnosticBytes {
		return value
	}
	return value[:maxDiagnosticBytes]
}
