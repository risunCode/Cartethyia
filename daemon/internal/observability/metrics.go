package observability

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Registry stores daemon metrics and exposes observability primitives without
// coupling the foundation to a vendor SDK. Metrics are emitted through
// ObserveRequest; structured logging and tracing are accessed via Logger and
// Tracer. A fresh Registry uses a no-op logger and a no-op tracer provider so
// callers can wire the registry before injecting a real implementation.
//
// The Registry also exposes bounded request-lifecycle event recording via
// RecordEvent. Metric labels are validated against the package allowlist so
// request IDs, raw prompt content, and credential-shaped values cannot leak
// into the metric pipeline.
type Registry struct {
	requests atomic.Uint64
	logger   Logger
	tracer   TracerProvider

	mu         sync.RWMutex
	events     map[string]*counter // metric-key -> counter
	validator  *labelValidator
	recorder   *Recorder
	eventDrops atomic.Uint64
}

// counter is a single labeled counter, tracked per metric name + label tuple.
type counter struct {
	name   string
	labels []Label
	value  uint64
}

// NewRegistry constructs a metrics registry with a no-op logger and a no-op
// tracer provider. Use WithLogger / WithTracer to inject real implementations.
func NewRegistry() *Registry {
	return &Registry{
		logger:    NopLogger(),
		tracer:    NoopTracerProvider{},
		events:    make(map[string]*counter),
		validator: NewLabelValidator(),
	}
}

// WithLogger replaces the registry's logger and returns the registry. A nil
// logger resets the registry to a no-op logger rather than panicking.
func (r *Registry) WithLogger(l Logger) *Registry {
	if l == nil {
		l = NopLogger()
	}
	r.logger = l
	return r
}

// WithTracer replaces the registry's tracer provider and returns the
// registry. A nil provider resets the registry to a no-op provider.
func (r *Registry) WithTracer(t TracerProvider) *Registry {
	if t == nil {
		t = NoopTracerProvider{}
	}
	r.tracer = t
	return r
}

// WithRecorder installs a bounded event Recorder. The Registry forwards
// every accepted event into the recorder after metric counting. A nil
// recorder is ignored.
func (r *Registry) WithRecorder(rec *Recorder) *Registry {
	if rec == nil {
		return r
	}
	r.recorder = rec
	return r
}

// Logger returns the registry's logger. The default is NopLogger; runtime
// wiring typically injects a NewLogger-backed instance.
func (r *Registry) Logger() Logger { return r.logger }

// Tracer returns the registry's tracer provider. The default is
// NoopTracerProvider; runtime wiring typically injects a real SDK-backed
// provider.
func (r *Registry) Tracer() TracerProvider { return r.tracer }

// Recorder returns the installed Recorder, or nil if none was set.
func (r *Registry) Recorder() *Recorder { return r.recorder }

// ObserveRequest records one HTTP request.
func (r *Registry) ObserveRequest(_ string, _ string, _ time.Duration) {
	r.requests.Add(1)
}

// EventDrops returns the cumulative count of events that were rejected by
// the Recorder (buffer overflow, sink error, or invalid labels).
func (r *Registry) EventDrops() uint64 { return r.eventDrops.Load() }

// RecordEvent validates event, increments the bounded metric counters, and
// forwards the event to the configured Recorder (if any). The metric path
// enforces the label allowlist; an event whose label set includes reserved
// or out-of-bounds keys is rejected with an error and counted as a drop.
//
// The metric key is derived from the event stage plus the validated label
// set so that bounded cardinality is preserved across the lifetime of the
// process. Two events with the same stage + labels increment the same
// counter; distinct labels create a distinct series.
func (r *Registry) RecordEvent(ctx context.Context, event RequestEvent) error {
	if err := event.Validate(); err != nil {
		r.eventDrops.Add(1)
		return err
	}
	labels := event.MetricLabels()
	normalized, err := r.validator.Normalize(labels)
	if err != nil {
		r.eventDrops.Add(1)
		return err
	}
	key := metricKey(string(event.Stage), normalized)
	r.mu.Lock()
	c, ok := r.events[key]
	if !ok {
		c = &counter{name: metricName(event), labels: append([]Label(nil), normalized...)}
		r.events[key] = c
	}
	c.value++
	r.mu.Unlock()
	if r.recorder != nil {
		if err := r.recorder.Record(ctx, event); err != nil {
			r.eventDrops.Add(1)
			return err
		}
	}
	return nil
}

// EventCount returns the current value of the bounded counter identified by
// stage + the supplied label set. Returns 0 when no event has been recorded.
// Labels are normalized via the package validator before lookup, matching
// the canonical key used during RecordEvent.
func (r *Registry) EventCount(stage Stage, labels []Label) uint64 {
	normalized, _ := r.validator.Normalize(labels)
	key := metricKey(string(stage), normalized)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if c, ok := r.events[key]; ok {
		return c.value
	}
	return 0
}

// ServeHTTP exposes the foundation metrics in Prometheus text format.
func (r *Registry) ServeHTTP(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "cartethyia_http_requests_total %d\n", r.requests.Load())
	r.mu.RLock()
	defer r.mu.RUnlock()
	// Render bounded counters in deterministic order so dashboards can diff
	// scrapes without noise from map iteration.
	keys := make([]string, 0, len(r.events))
	for k := range r.events {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		c := r.events[k]
		_, _ = fmt.Fprintf(w, "%s{%s} %d\n", c.name, renderLabels(c.labels), c.value)
	}
	if d := r.eventDrops.Load(); d > 0 {
		_, _ = fmt.Fprintf(w, "cartethyia_observability_drops_total %d\n", d)
	}
}

// metricName returns the canonical metric name for an event stage.
func metricName(e RequestEvent) string {
	switch e.Stage {
	case StageRequestStart:
		return "cartethyia_requests_started_total"
	case StageRouteAttempt:
		return "cartethyia_route_attempts_total"
	case StageProviderCall:
		return "cartethyia_provider_calls_total"
	case StageCacheLookup:
		return "cartethyia_cache_lookups_total"
	case StageTerminal:
		return "cartethyia_request_outcomes_total"
	default:
		return "cartethyia_events_total"
	}
}

// metricKey builds the lookup key for the bounded counter map. Stage and
// labels are joined deterministically so the same logical series always
// hashes to the same bucket.
func metricKey(stage string, labels []Label) string {
	if len(labels) == 0 {
		return stage + "|"
	}
	sorted := append([]Label(nil), labels...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Key < sorted[j].Key })
	parts := make([]string, len(sorted))
	for i, l := range sorted {
		parts[i] = l.Key + "=" + l.Value
	}
	return stage + "|" + strings.Join(parts, ",")
}

func renderLabels(labels []Label) string {
	if len(labels) == 0 {
		return ""
	}
	parts := make([]string, len(labels))
	for i, l := range labels {
		parts[i] = l.Key + "=\"" + escapeLabelValue(l.Value) + "\""
	}
	return strings.Join(parts, ",")
}

func escapeLabelValue(v string) string {
	if !strings.ContainsAny(v, "\\\"\n") {
		return v
	}
	var b strings.Builder
	b.Grow(len(v) + 2)
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '\\':
			b.WriteString("\\\\")
		case '"':
			b.WriteString("\\\"")
		case '\n':
			b.WriteString("\\n")
		default:
			b.WriteByte(v[i])
		}
	}
	return b.String()
}
