package observability

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const evidenceSecretSentinel = "authorization=Bearer evidence-secret-sentinel"

func TestAttemptEvidenceIsOneBoundedSecretFreeRecord(t *testing.T) {
	sink := &CountingSink{}
	recorder := NewRecorder(context.Background(), sink, WithCapacity(8))
	registry := NewRegistry().WithRecorder(recorder)
	started := time.Now().UTC()
	registry.ObserveAttempt(AttemptEvidence{
		RequestID: evidenceSecretSentinel, CatalogGeneration: 7, Attempt: 2, RouteMember: 1,
		Provider: "provider-a", Model: "model-a", AccountID: evidenceSecretSentinel,
		NetworkMode: "proxy", ProxyID: "password=evidence-secret-sentinel", Surface: "stream",
		Result: AttemptSucceeded, RetryAction: "stop", RepairRule: "grok.invalid_encrypted_content",
		StartedAt: started, EndedAt: started.Add(9 * time.Millisecond), LatencyMS: 9,
		Usage: TokenUsage{Known: UsageInput | UsageOutput, Input: 3, Output: 5}, Failover: true,
	})
	registry.ObserveRequestAttempts(2)
	if err := recorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := sink.Events()
	if len(events) != 1 || events[0].Stage != StageProviderCall || events[0].Attempt != 2 {
		t.Fatalf("events=%#v, want one provider call", events)
	}
	if events[0].RequestID != "[redacted]" || events[0].AccountID != "[redacted]" || events[0].ProxyID != "[redacted]" {
		t.Fatalf("identities were not redacted: %#v", events[0])
	}
	if strings.Contains(strings.ToLower(fmt.Sprintf("%#v", events)), "evidence-secret-sentinel") {
		t.Fatalf("evidence leaked sentinel: %#v", events)
	}
	metrics := httptest.NewRecorder()
	registry.ServeHTTP(metrics)
	body := metrics.Body.String()
	for _, name := range []string{
		"cartethyia_upstream_attempts_total 1", "cartethyia_failover_success_total 1",
		"cartethyia_repair_success_total 1", "cartethyia_attempts_per_request_count",
	} {
		if !strings.Contains(body, name) {
			t.Fatalf("metric %q missing from %s", name, body)
		}
	}
	if strings.Contains(strings.ToLower(body), "evidence-secret-sentinel") {
		t.Fatalf("metrics leaked sentinel: %s", body)
	}
}

func TestStreamFinalizationEvidenceEveryOutcomeExactlyOnce(t *testing.T) {
	outcomes := []StreamOutcome{
		StreamClean, StreamFailed, StreamCanceled, StreamStalled, StreamTruncated, StreamDownstreamWrite,
	}
	sink := &CountingSink{}
	recorder := NewRecorder(context.Background(), sink, WithCapacity(32))
	registry := NewRegistry().WithRecorder(recorder)
	for i, outcome := range outcomes {
		base := StreamFinalizationEvidence{
			RequestID: fmt.Sprintf("request-%d", i), CatalogGeneration: 11, Attempt: 1,
			Provider: "provider", Model: "model", AccountID: evidenceSecretSentinel,
			ProxyID: "proxy", NetworkMode: "proxy", Surface: "stream", Outcome: outcome,
			Code: "proxy/stream.outcome", StartedAt: time.Now().Add(-time.Millisecond),
			EndedAt: time.Now(), DurationMS: 1,
		}
		registry.ObserveStreamFinalization(base)
	}
	if err := recorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := sink.Events()
	if len(events) != len(outcomes) {
		t.Fatalf("finalization events=%d want=%d: %#v", len(events), len(outcomes), events)
	}
	seen := make(map[StreamOutcome]int, len(outcomes))
	for _, event := range events {
		if event.Stage != StageStreamFinalization {
			t.Fatalf("unexpected event stage: %#v", event)
		}
		seen[event.StreamOutcome]++
	}
	for _, outcome := range outcomes {
		if seen[outcome] != 1 {
			t.Fatalf("outcome %q count=%d", outcome, seen[outcome])
		}
	}
	if strings.Contains(strings.ToLower(fmt.Sprintf("%#v", events)), "evidence-secret-sentinel") {
		t.Fatalf("finalization evidence leaked sentinel: %#v", events)
	}
}

func TestCandidateAndRepairEvidenceAreBoundedAndPayloadFree(t *testing.T) {
	sink := &CountingSink{}
	recorder := NewRecorder(context.Background(), sink, WithCapacity(4))
	registry := NewRegistry().WithRecorder(recorder)
	registry.ObserveCandidateExclusion(CandidateExclusionEvidence{
		RequestID: "request", Provider: "provider", Model: "model",
		AccountID: evidenceSecretSentinel, Reason: "cooling", RetryAfterMS: 5,
	})
	registry.ObserveRepair(RepairEvidence{
		RequestID: "request", Provider: "provider", Rule: "grok.invalid_encrypted_content",
		Attempt: 1, Changed: true, Applied: true,
	})
	if err := recorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := sink.Events()
	if len(events) != 2 || events[0].Stage != StageCandidateExclusion || events[1].Stage != StageRepair {
		t.Fatalf("events=%#v", events)
	}
	if strings.Contains(strings.ToLower(fmt.Sprintf("%#v", events)), "evidence-secret-sentinel") {
		t.Fatalf("bounded evidence leaked sentinel: %#v", events)
	}
}

type blockingEvidenceSink struct{ release <-chan struct{} }

func (s blockingEvidenceSink) Emit(context.Context, RequestEvent) error {
	<-s.release
	return nil
}

func TestEvidenceCapacityDropsAndTerminalMapStayBounded(t *testing.T) {
	release := make(chan struct{})
	recorder := NewRecorder(context.Background(), blockingEvidenceSink{release: release}, WithCapacity(1))
	registry := NewRegistry().WithRecorder(recorder)
	for range 32 {
		registry.ObserveAttempt(AttemptEvidence{Attempt: 1, Result: AttemptSucceeded, Surface: "http"})
	}
	if registry.EventDrops() == 0 {
		t.Fatal("saturated evidence queue did not increment dropped evidence")
	}
	close(release)
	if err := recorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	terminalRecorder := NewRecorder(context.Background(), NoopSink{}, WithCapacity(1))
	for i := range MaxTerminalKeys + 128 {
		_ = terminalRecorder.Record(context.Background(), RequestEvent{
			RequestID: fmt.Sprintf("request-%d", i), Stage: StageTerminal,
			Surface: SurfaceHTTP, Outcome: OutcomeSuccess,
		})
	}
	terminalRecorder.terminalsMu.Lock()
	terminalCount := len(terminalRecorder.terminals)
	terminalRecorder.terminalsMu.Unlock()
	if terminalCount > MaxTerminalKeys {
		t.Fatalf("terminal map size=%d max=%d", terminalCount, MaxTerminalKeys)
	}
	if err := terminalRecorder.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
