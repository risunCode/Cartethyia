package proxy

import (
	"context"
	"errors"
	"testing"

	"github.com/cartethyia/daemon/internal/observability/usage"
)

// recordingUsageRepository captures Append calls so tests can prove the
// dispatch service records per-request token usage once the ledger is wired.
type recordingUsageRepository struct {
	events []usage.Event
	fail   bool
}

func (r *recordingUsageRepository) Append(_ context.Context, e usage.Event) error {
	if r.fail {
		return errors.New("usage: fixture persistence failure")
	}
	r.events = append(r.events, e)
	return nil
}

func (r *recordingUsageRepository) Reconcile(_ context.Context, _ usage.Reconciliation) error {
	return nil
}

// TestDispatchRecordsUsageTokensWithWiredLedger proves a buffered dispatch
// with usage tokens in the provider response reaches the usage ledger: the
// ledger registers exactly one event carrying the parsed tokens.
func TestDispatchRecordsUsageTokensWithWiredLedger(t *testing.T) {
	repo := &recordingUsageRepository{}
	service := newCountingService(t, &countingTransport{})
	service.Usage = usage.New(usage.WithRepository(repo))
	if _, err := service.DispatchContext(context.Background(), countingRequest()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(repo.events) != 1 {
		t.Fatalf("usage events=%d, want 1", len(repo.events))
	}
	event := repo.events[0]
	if event.RequestID != "cache-test-1" || event.Attempt != 1 || event.Model != "model" {
		t.Fatalf("event identity={%s %d %s}", event.RequestID, event.Attempt, event.Model)
	}
	if event.Tokens.Input == nil || *event.Tokens.Input != 1 || event.Tokens.Output == nil || *event.Tokens.Output != 1 || event.Tokens.Total == nil || *event.Tokens.Total != 2 {
		t.Fatalf("event tokens=%+v, want input=1 output=1 total=2", event.Tokens)
	}
	if service.SideEffectFailureCount() != 0 {
		t.Fatalf("side-effect failures=%d, want 0", service.SideEffectFailureCount())
	}
}

// TestDispatchUsageRecordingIsFailOpen proves a failing usage repository never
// fails the client response: the dispatch still succeeds and the failure is
// only counted as bounded side-effect evidence.
func TestDispatchUsageRecordingIsFailOpen(t *testing.T) {
	repo := &recordingUsageRepository{fail: true}
	service := newCountingService(t, &countingTransport{})
	service.Usage = usage.New(usage.WithRepository(repo))
	result, err := service.DispatchContext(context.Background(), countingRequest())
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if result == nil || result.StatusCode() != 200 {
		t.Fatalf("result=%v, want successful buffered response", result)
	}
	if service.SideEffectFailureCount() != 1 {
		t.Fatalf("side-effect failures=%d, want 1", service.SideEffectFailureCount())
	}
}
