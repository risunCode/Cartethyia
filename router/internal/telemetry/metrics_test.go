package telemetry

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
	labels := []Label{{Key: "surface", Value: "http"}, {Key: "stage", Value: string(StageRouteAttempt)}}
	if n := reg.EventCount(StageRouteAttempt, labels); n != 1 {
		t.Errorf("EventCount: got %d want 1", n)
	}
	if err := reg.RecordEvent(ctx, RequestEvent{Stage: StageRouteAttempt, Surface: SurfaceHTTP, Provider: "anthropic", Model: "other"}); err != nil {
		t.Fatal(err)
	}
	if n := reg.EventCount(StageRouteAttempt, labels); n != 2 {
		t.Errorf("provider/model values split stable series: got %d want 2", n)
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
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = reg.RecordEvent(ctx, RequestEvent{Stage: StageRouteAttempt, Surface: SurfaceHTTP, Provider: "openai"})
		}()
	}
	wg.Wait()
	labels := []Label{{Key: "surface", Value: "http"}, {Key: "stage", Value: string(StageRouteAttempt)}}
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

type metricsBatchWriter struct {
	stats MaintenanceBatchStats
}

func (w *metricsBatchWriter) Enqueue(Metadata) error { return nil }
func (w *metricsBatchWriter) Drops() uint64           { return w.stats.Drops }
func (w *metricsBatchWriter) Failures() uint64        { return w.stats.Failures }
func (w *metricsBatchWriter) Close(context.Context) error {
	w.stats.Draining = false
	w.stats.Drained = true
	return nil
}
func (w *metricsBatchWriter) QueueDepth() int                 { return w.stats.QueueDepth }
func (w *metricsBatchWriter) QueueSize() int                  { return w.stats.QueueSize }
func (w *metricsBatchWriter) FlushSize() int                  { return w.stats.FlushSize }
func (w *metricsBatchWriter) FlushInterval() time.Duration    { return w.stats.FlushInterval }
func (w *metricsBatchWriter) Flushes() uint64                 { return w.stats.Flushes }
func (w *metricsBatchWriter) FlushLatency() time.Duration     { return w.stats.FlushLatency }
func (w *metricsBatchWriter) Draining() bool                  { return w.stats.Draining }
func (w *metricsBatchWriter) Drained() bool                   { return w.stats.Drained }

func TestRegistryMaintenanceBatchMetricsReflectWriterLifecycle(t *testing.T) {
	writer := &metricsBatchWriter{stats: MaintenanceBatchStats{
		QueueDepth:    3,
		QueueSize:     64,
		FlushSize:     8,
		FlushInterval: 2 * time.Second,
		Drops:         2,
		Failures:      1,
		Flushes:       4,
		FlushLatency: 25 * time.Millisecond,
		Draining:      true,
	}}
	reg := NewRegistry().WithMaintenanceBatchWriter(writer)

	rr := httptest.NewRecorder()
	reg.ServeHTTP(rr)
	body := rr.Body.String()
	for _, metric := range []string{
		"cartethyia_metadata_batch_queue_depth 3",
		"cartethyia_metadata_batch_queue_size 64",
		"cartethyia_metadata_batch_flush_size 8",
		"cartethyia_metadata_batch_flush_interval_seconds 2",
		"cartethyia_metadata_batch_drops_total 2",
		"cartethyia_metadata_batch_failures_total 1",
		"cartethyia_metadata_batch_flush_total 4",
		"cartethyia_metadata_batch_flush_latency_ms 25",
		"cartethyia_metadata_batch_draining 1",
		"cartethyia_metadata_batch_drained 0",
	} {
		if !strings.Contains(body, metric) {
			t.Errorf("missing metric %q in output: %s", metric, body)
		}
	}

	if err := writer.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	rr = httptest.NewRecorder()
	reg.ServeHTTP(rr)
	if body = rr.Body.String(); !strings.Contains(body, "cartethyia_metadata_batch_draining 0") ||
		!strings.Contains(body, "cartethyia_metadata_batch_drained 1") {
		t.Errorf("missing completed drain metrics: %s", body)
	}
}

func TestRegistryMaintenanceBatchObservationsAccountLifecycle(t *testing.T) {
	reg := NewRegistry()
	reg.ObserveMaintenanceBatchQueue(5, 16, 500*time.Millisecond)
	reg.ObserveMaintenanceBatchFlush(16, 12*time.Millisecond, false)
	reg.ObserveMaintenanceBatchDrop()
	reg.ObserveMaintenanceBatchDrain(true, false)
	reg.ObserveMaintenanceBatchDrain(false, true)

	rr := httptest.NewRecorder()
	reg.ServeHTTP(rr)
	body := rr.Body.String()
	for _, metric := range []string{
		"cartethyia_metadata_batch_queue_depth 5",
		"cartethyia_metadata_batch_flush_size 16",
		"cartethyia_metadata_batch_flush_interval_seconds 0.5",
		"cartethyia_metadata_batch_drops_total 1",
		"cartethyia_metadata_batch_flush_total 1",
		"cartethyia_metadata_batch_drained 1",
	} {
		if !strings.Contains(body, metric) {
			t.Errorf("missing observed metric %q in output: %s", metric, body)
		}
	}
}
