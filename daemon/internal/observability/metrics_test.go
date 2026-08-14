package observability

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRegistryRecordEventCountsLabels(t *testing.T) {
	reg := NewRegistry()
	ctx := context.Background()
	ev := RequestEvent{
		Stage:    StageRouteAttempt,
		Surface:  SurfaceHTTP,
		Provider: "openai",
		Model:    "gpt-4o-mini",
	}
	if err := reg.RecordEvent(ctx, ev); err != nil {
		t.Fatalf("RecordEvent: %v", err)
	}
	labels := []Label{{Key: "provider", Value: "openai"}, {Key: "model", Value: "gpt-4o-mini"}, {Key: "surface", Value: "http"}, {Key: "stage", Value: string(StageRouteAttempt)}}
	if n := reg.EventCount(StageRouteAttempt, labels); n != 1 {
		t.Errorf("EventCount: got %d want 1", n)
	}
	if n := reg.EventCount(StageRouteAttempt, []Label{{Key: "provider", Value: "anthropic"}, {Key: "model", Value: "x"}, {Key: "surface", Value: "http"}, {Key: "stage", Value: string(StageRouteAttempt)}}); n != 0 {
		t.Errorf("EventCount for distinct series: got %d want 0", n)
	}
}

func TestRegistryRecordEventRejectsReservedLabels(t *testing.T) {
	reg := NewRegistry()
	ctx := context.Background()
	// Build an event whose MetricLabels are normally allowed, then smuggle a
	// reserved key through RecordEvent's validation path by extending labels
	// manually via a registry-only validation path. RecordEvent itself does
	// not accept caller-supplied labels, but Normalize must reject reserved
	// keys so registry-level label smuggling is impossible.
	_, err := reg.validator.Normalize([]Label{{Key: "request_id", Value: "abc"}})
	if err == nil {
		t.Fatalf("Normalize should reject request_id")
	}
	// Direct RecordEvent of a clean event must still succeed.
	if err := reg.RecordEvent(ctx, RequestEvent{Stage: StageRouteAttempt, Surface: SurfaceHTTP, Provider: "openai"}); err != nil {
		t.Fatalf("RecordEvent clean: %v", err)
	}
}

func TestRegistryServeHTTPRendersBoundedCounters(t *testing.T) {
	reg := NewRegistry()
	ctx := context.Background()
	_ = reg.RecordEvent(ctx, RequestEvent{Stage: StageTerminal, Surface: SurfaceHTTP, Outcome: OutcomeSuccess, Provider: "openai"})
	_ = reg.RecordEvent(ctx, RequestEvent{Stage: StageTerminal, Surface: SurfaceHTTP, Outcome: OutcomeSuccess, Provider: "openai"})
	_ = reg.RecordEvent(ctx, RequestEvent{Stage: StageCacheLookup, Surface: SurfaceHTTP, CacheKind: CacheKindResolutionMemory, CacheHit: true})

	rr := httptest.NewRecorder()
	reg.ServeHTTP(rr)
	body := rr.Body.String()
	if !strings.Contains(body, "cartethyia_request_outcomes_total") {
		t.Errorf("missing terminal metric: %s", body)
	}
	if !strings.Contains(body, "cartethyia_cache_lookups_total") {
		t.Errorf("missing cache metric: %s", body)
	}
	if strings.Contains(body, "request_id=") || strings.Contains(body, "trace_id=") {
		t.Errorf("metric output must not contain request_id or trace_id labels: %s", body)
	}
	if !strings.Contains(body, "cache_kind=\"resolution_memory\"") {
		t.Errorf("expected cache_kind label in output: %s", body)
	}
}

func TestRegistryConcurrentRecordEvent(t *testing.T) {
	reg := NewRegistry()
	ctx := context.Background()
	var wg sync.WaitGroup
	const n = 64
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = reg.RecordEvent(ctx, RequestEvent{Stage: StageRouteAttempt, Surface: SurfaceHTTP, Provider: "openai"})
		}()
	}
	wg.Wait()
	labels := []Label{{Key: "provider", Value: "openai"}, {Key: "surface", Value: "http"}, {Key: "stage", Value: string(StageRouteAttempt)}}
	if got := reg.EventCount(StageRouteAttempt, labels); got != n {
		t.Errorf("concurrent count: got %d want %d", got, n)
	}
}

func TestRegistryWithRecorderForwards(t *testing.T) {
	reg := NewRegistry()
	ctx := context.Background()
	sink := &CountingSink{}
	rec := NewRecorder(ctx, sink, WithCapacity(8))
	defer rec.Close(ctx)
	reg.WithRecorder(rec)

	if err := reg.RecordEvent(ctx, RequestEvent{Stage: StageRouteAttempt, Surface: SurfaceHTTP, Provider: "openai"}); err != nil {
		t.Fatalf("RecordEvent: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(sink.Events()) > 0 {
			break
		}
		sleepALittle()
	}
	if len(sink.Events()) != 1 {
		t.Errorf("recorder did not receive event: %d", len(sink.Events()))
	}
}

func sleepALittle() {
	time.Sleep(time.Millisecond)
}

func TestEscapeLabelValue(t *testing.T) {
	cases := map[string]string{
		"plain":      "plain",
		"with\\":     "with\\\\",
		"a\"b":       "a\\\"b",
		"line\nfeed": "line\\nfeed",
	}
	for in, want := range cases {
		if got := escapeLabelValue(in); got != want {
			t.Errorf("escapeLabelValue(%q)=%q want %q", in, got, want)
		}
	}
}
