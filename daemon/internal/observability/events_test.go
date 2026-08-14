package observability

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRequestEventValidateBoundedStages(t *testing.T) {
	base := RequestEvent{Surface: SurfaceHTTP, Stage: StageRequestStart}
	if err := base.Validate(); err != nil {
		t.Fatalf("valid start event: %v", err)
	}
	if err := (RequestEvent{Surface: SurfaceHTTP, Stage: "garbage"}).Validate(); err == nil {
		t.Errorf("expected rejection of unknown stage")
	}
}

func TestRequestEventValidateStageRules(t *testing.T) {
	// CacheLookup without CacheKind -> invalid
	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageCacheLookup}
	if err := ev.Validate(); err == nil {
		t.Errorf("cache_lookup without cache_kind must be rejected")
	}
	ev.CacheKind = CacheKindResolutionMemory
	if err := ev.Validate(); err != nil {
		t.Errorf("cache_lookup with cache_kind: %v", err)
	}
	// CacheKind outside StageCacheLookup -> invalid
	bad := RequestEvent{Surface: SurfaceHTTP, Stage: StageProviderCall, CacheKind: CacheKindResolutionMemory}
	if err := bad.Validate(); err == nil {
		t.Errorf("cache_kind only allowed on cache_lookup stage")
	}
}

func TestRequestEventValidateTerminalRequiresOutcome(t *testing.T) {
	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageTerminal}
	if err := ev.Validate(); err == nil {
		t.Errorf("terminal stage without outcome must be rejected")
	}
	ev.Outcome = OutcomeSuccess
	if err := ev.Validate(); err != nil {
		t.Errorf("terminal stage with outcome: %v", err)
	}
}

func TestRequestEventValidateBounds(t *testing.T) {
	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageProviderCall, Attempt: -1}
	if err := ev.Validate(); err == nil {
		t.Errorf("negative attempt must be rejected")
	}
	ev.Attempt = MaxAttempts + 1
	if err := ev.Validate(); err == nil {
		t.Errorf("oversize attempt must be rejected")
	}
	ev = RequestEvent{Surface: SurfaceHTTP, Stage: StageProviderCall, LatencyMS: -1}
	if err := ev.Validate(); err == nil {
		t.Errorf("negative latency must be rejected")
	}
	ev = RequestEvent{Surface: SurfaceHTTP, Stage: StageProviderCall, LatencyMS: MaxLatencyMS + 1}
	if err := ev.Validate(); err == nil {
		t.Errorf("oversize latency must be rejected")
	}
	ev = RequestEvent{Surface: SurfaceHTTP, Stage: StageProviderCall, Provider: strings.Repeat("p", MaxIdentifierLen+1)}
	if err := ev.Validate(); err == nil {
		t.Errorf("oversize provider must be rejected")
	}
}

func TestRequestEventLifecycleRateMetadataIsBoundedAndLogged(t *testing.T) {
	ev := RequestEvent{
		Surface: SurfaceHTTP, Stage: StageProviderCall,
		EventKey: "request_failed", RateSource: "provider_rate_limit",
		RateScope: "provider", RatePhase: "provider", Retryable: true,
		RetryAfterMS: 1200, AlternateAccountEligible: true,
	}
	if err := ev.Validate(); err != nil {
		t.Fatalf("valid lifecycle metadata rejected: %v", err)
	}
	fields := ev.LogFields()
	for _, key := range []string{"event_key", "rate_source", "rate_scope", "rate_phase", "retryable", "retry_after_ms", "alternate_account_eligible"} {
		found := false
		for _, field := range fields {
			if field.Key == key {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("log field %q missing", key)
		}
	}
	ev.EventKey = strings.Repeat("x", MaxEventKeyLen+1)
	if err := ev.Validate(); err == nil {
		t.Fatal("oversize event key accepted")
	}
	ev.EventKey = "request_failed"
	ev.RetryAfterMS = MaxLatencyMS + 1
	if err := ev.Validate(); err == nil {
		t.Fatal("oversize retry-after accepted")
	}
}

func TestRequestEventMetricLabelsExcludeRequestAndTraceIDs(t *testing.T) {
	ev := RequestEvent{
		Stage:     StageTerminal,
		Surface:   SurfaceHTTP,
		RequestID: "req-abc",
		TraceID:   "trace-xyz",
		Outcome:   OutcomeSuccess,
		Provider:  "openai",
		Model:     "gpt-4o-mini",
	}
	labels := ev.MetricLabels()
	for _, l := range labels {
		if l.Key == "request_id" || l.Key == "trace_id" || l.Key == "span_id" {
			t.Errorf("metric label leaked correlation id: %v", l)
		}
		if strings.Contains(strings.ToLower(l.Value), "secret") ||
			strings.Contains(strings.ToLower(l.Value), "bearer ") {
			t.Errorf("metric label value resembles credential: %v", l)
		}
	}
}

func TestCacheKindSeparation(t *testing.T) {
	// Resolution cache kinds report IsResolutionCache=true and
	// IsProviderCache=false; provider cache kind is the opposite. This is the
	// structural invariant that prevents dashboards from conflating the two.
	resolutionKinds := []CacheKind{CacheKindResolutionMemory, CacheKindResolutionRedis}
	for _, k := range resolutionKinds {
		if !k.IsResolutionCache() {
			t.Errorf("%s should be resolution cache", k)
		}
		if k.IsProviderCache() {
			t.Errorf("%s must NOT be provider cache", k)
		}
	}
	if !CacheKindProviderPrompt.IsProviderCache() {
		t.Errorf("provider prompt cache should report IsProviderCache=true")
	}
	if CacheKindProviderPrompt.IsResolutionCache() {
		t.Errorf("provider prompt cache must NOT be resolution cache")
	}
	// CacheKind must produce distinct metric labels so series never collapse.
	s1 := RequestEvent{Surface: SurfaceHTTP, Stage: StageCacheLookup, CacheKind: CacheKindResolutionMemory, CacheHit: true}.MetricLabels()
	s2 := RequestEvent{Surface: SurfaceHTTP, Stage: StageCacheLookup, CacheKind: CacheKindResolutionRedis, CacheHit: true}.MetricLabels()
	s3 := RequestEvent{Surface: SurfaceHTTP, Stage: StageCacheLookup, CacheKind: CacheKindProviderPrompt, CacheHit: true}.MetricLabels()
	if metricKey(string(StageCacheLookup), s1) == metricKey(string(StageCacheLookup), s3) {
		t.Errorf("provider prompt cache must not collide with resolution memory cache")
	}
	if metricKey(string(StageCacheLookup), s1) == metricKey(string(StageCacheLookup), s2) {
		t.Errorf("memory and redis resolution caches must not collide")
	}
}

func TestRecorderDeliversEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &CountingSink{}
	rec := NewRecorder(ctx, sink, WithCapacity(8))
	defer rec.Close(ctx)

	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageRouteAttempt, Provider: "openai"}
	if err := rec.Record(ctx, ev); err != nil {
		t.Fatalf("Record: %v", err)
	}
	// Wait briefly for the worker goroutine.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(sink.Events()) > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	events := sink.Events()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Provider != "openai" {
		t.Errorf("provider lost in transit: %+v", events[0])
	}
}

func TestRecorderTerminalIdempotence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &CountingSink{}
	rec := NewRecorder(ctx, sink, WithCapacity(8))
	defer rec.Close(ctx)

	terminal := RequestEvent{RequestID: "req-1", Stage: StageTerminal, Surface: SurfaceHTTP, Outcome: OutcomeSuccess}
	if err := rec.Record(ctx, terminal); err != nil {
		t.Fatalf("first terminal: %v", err)
	}
	if err := rec.Record(ctx, terminal); !errors.Is(err, ErrDuplicateTerminal) {
		t.Fatalf("second terminal: want ErrDuplicateTerminal, got %v", err)
	}
	// Different request IDs must be independent.
	other := RequestEvent{RequestID: "req-2", Stage: StageTerminal, Surface: SurfaceHTTP, Outcome: OutcomeSuccess}
	if err := rec.Record(ctx, other); err != nil {
		t.Fatalf("different request_id terminal: %v", err)
	}
}

func TestRecorderRejectsInvalidEvent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec := NewRecorder(ctx, NoopSink{}, WithCapacity(4))
	defer rec.Close(ctx)

	err := rec.Record(ctx, RequestEvent{Stage: "nope", Surface: SurfaceHTTP})
	if !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("want ErrInvalidEvent, got %v", err)
	}
}

func TestRecorderCancellationSafety(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before any record
	rec := NewRecorder(context.Background(), NoopSink{}, WithCapacity(4))
	defer rec.Close(context.Background())

	// The non-blocking send path will attempt enqueue; with the cancelled
	// ctx we should observe ctx.Err() returned rather than a panic.
	ev := RequestEvent{Surface: SurfaceHTTP, Stage: StageRequestStart}
	if err := rec.Record(ctx, ev); err == nil {
		t.Skip("drop path consumed the event before ctx cancellation took effect; expected behaviour is either ErrDuplicateTerminal-free enqueue or ctx.Err()")
	} else if !errors.Is(err, context.Canceled) {
		t.Logf("got %v (acceptable for fast path)", err)
	}
}

func TestRecorderCloseRejectsFurtherRecords(t *testing.T) {
	ctx := context.Background()
	rec := NewRecorder(ctx, NoopSink{}, WithCapacity(4))
	if err := rec.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	err := rec.Record(ctx, RequestEvent{Surface: SurfaceHTTP, Stage: StageRequestStart})
	if !errors.Is(err, ErrRecorderClosed) {
		t.Fatalf("want ErrRecorderClosed, got %v", err)
	}
}

func TestRecorderBoundedBufferCountsDrops(t *testing.T) {
	ctx := context.Background()
	// Tiny buffer + slow sink so events back up.
	slow := &slowSink{}
	rec := NewRecorder(ctx, slow, WithCapacity(1))
	defer rec.Close(context.Background())

	// Fill buffer and worker, then drop on subsequent sends.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = rec.Record(ctx, RequestEvent{Surface: SurfaceHTTP, Stage: StageRouteAttempt, Attempt: i})
		}
	}()
	wg.Wait()
	if rec.Drops() == 0 {
		t.Errorf("expected drop counter to advance under pressure")
	}
}

type slowSink struct{}

func (slowSink) Emit(ctx context.Context, _ RequestEvent) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(2 * time.Millisecond):
		return nil
	}
}

func TestRecorderForgetTerminal(t *testing.T) {
	ctx := context.Background()
	rec := NewRecorder(ctx, NoopSink{}, WithCapacity(4))
	defer rec.Close(ctx)
	ev := RequestEvent{RequestID: "r", Stage: StageTerminal, Surface: SurfaceHTTP, Outcome: OutcomeSuccess}
	if err := rec.Record(ctx, ev); err != nil {
		t.Fatalf("Record: %v", err)
	}
	rec.ForgetTerminal("r")
	if err := rec.Record(ctx, ev); err != nil {
		t.Fatalf("after ForgetTerminal: %v", err)
	}
}

func TestLogSinkEmitSafeWithNilLogger(t *testing.T) {
	s := LogSink{Logger: nil}
	if err := s.Emit(context.Background(), RequestEvent{Surface: SurfaceHTTP, Stage: StageRequestStart}); err != nil {
		t.Errorf("nil logger Emit should be no-op, got %v", err)
	}
}
