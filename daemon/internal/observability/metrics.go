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
	metadata   *AsyncMetadataWriter

	attempts                    atomic.Uint64
	candidateExclusions         atomic.Uint64
	repairs                     atomic.Uint64
	streamFinalizations         atomic.Uint64
	failoverSuccesses           atomic.Uint64
	repairSuccesses             atomic.Uint64
	preCommitFailures           atomic.Uint64
	postCommitFailures          atomic.Uint64
	truncations                 atomic.Uint64
	accountCooldowns            atomic.Uint64
	proxyQuarantines            atomic.Uint64
	sideEffectFailures          atomic.Uint64
	hiddenRecoveries            atomic.Uint64
	avoidableErrors             atomic.Uint64
	typedExhaustions            atomic.Uint64
	providerCacheReadTokens     atomic.Uint64
	providerCacheWriteTokens    atomic.Uint64
	providerCacheEligiblePrefix atomic.Uint64
	providerCacheHitPrefix      atomic.Uint64
	attemptBuckets              [6]atomic.Uint64
	attemptCount                atomic.Uint64
	attemptSum                  atomic.Uint64
	admissionBuckets            [14]atomic.Uint64
	admissionCount              atomic.Uint64
	admissionSum                atomic.Uint64
	streamBuckets               [14]atomic.Uint64
	streamCount                 atomic.Uint64
	streamSum                   atomic.Uint64
}

const MaxMetricSeries = 2048

var (
	attemptHistogramBounds  = [...]uint64{0, 1, 2, 3, 5, 8}
	durationHistogramBounds = [...]uint64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000, 300000}
)

// counter is a single labeled counter, tracked per metric name + label tuple.
type counter struct {
	name   string
	stage  Stage
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

// WithMetadataWriter connects the existing bounded asynchronous metadata
// writer so its capacity and persistence failures are reflected in the single
// dropped-evidence/side-effect metric set.
func (r *Registry) WithMetadataWriter(writer *AsyncMetadataWriter) *Registry {
	r.metadata = writer
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
func (r *Registry) EventDrops() uint64 {
	if r == nil {
		return 0
	}
	drops := r.eventDrops.Load()
	if r.recorder != nil {
		drops += r.recorder.Drops()
	}
	if r.metadata != nil {
		drops += r.metadata.Drops()
	}
	return drops
}

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
	if r == nil {
		return ErrInvalidEvent
	}
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
		if len(r.events) >= MaxMetricSeries {
			r.eventDrops.Add(1)
		} else {
			c = &counter{name: metricName(event), stage: event.Stage, labels: append([]Label(nil), normalized...)}
			r.events[key] = c
		}
	}
	if c != nil {
		c.value++
	}
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
	if r == nil || r.validator == nil {
		return 0
	}
	normalized, _ := r.validator.Normalize(labels)
	r.mu.RLock()
	defer r.mu.RUnlock()
	var total uint64
	for _, c := range r.events {
		if c == nil || c.stage != stage || !eventLabelsMatch(c.labels, stage, normalized) {
			continue
		}
		total += c.value
	}
	return total
}

func eventLabelsMatch(labels []Label, stage Stage, wanted []Label) bool {
	hasStage := false
	stageLabelPresent := false
	for _, label := range labels {
		if label.Key == "stage" {
			stageLabelPresent = true
			hasStage = label.Value == string(stage)
			break
		}
	}
	if stageLabelPresent && !hasStage {
		return false
	}
	for _, want := range wanted {
		found := false
		for _, got := range labels {
			if got.Key == want.Key && got.Value == want.Value {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// ServeHTTP exposes the foundation metrics in Prometheus text format.
func (r *Registry) ServeHTTP(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "cartethyia_http_requests_total %d\n", r.requests.Load())
	r.mu.RLock()
	type counterSnapshot struct {
		key     string
		counter counter
	}
	snapshots := make([]counterSnapshot, 0, len(r.events))
	for key, value := range r.events {
		snapshots = append(snapshots, counterSnapshot{key: key, counter: *value})
	}
	r.mu.RUnlock()
	// Render bounded counters in deterministic order so dashboards can diff
	// scrapes without noise from map iteration. No registry lock is held while
	// the response writer performs potentially slow I/O.
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].key < snapshots[j].key })
	for _, snapshot := range snapshots {
		_, _ = fmt.Fprintf(w, "%s{%s} %d\n", snapshot.counter.name, renderLabels(snapshot.counter.labels), snapshot.counter.value)
	}
	_, _ = fmt.Fprintf(w, "cartethyia_upstream_attempts_total %d\n", r.attempts.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_candidate_exclusions_total %d\n", r.candidateExclusions.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_repairs_total %d\n", r.repairs.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_stream_finalizations_total %d\n", r.streamFinalizations.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_failover_success_total %d\n", r.failoverSuccesses.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_repair_success_total %d\n", r.repairSuccesses.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_stream_precommit_failures_total %d\n", r.preCommitFailures.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_stream_postcommit_failures_total %d\n", r.postCommitFailures.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_stream_truncations_total %d\n", r.truncations.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_account_cooldowns_total %d\n", r.accountCooldowns.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_proxy_quarantines_total %d\n", r.proxyQuarantines.Load())
	sideEffectFailures := r.sideEffectFailures.Load()
	if r.metadata != nil {
		sideEffectFailures += r.metadata.Failures()
	}
	_, _ = fmt.Fprintf(w, "cartethyia_post_result_side_effect_failures_total %d\n", sideEffectFailures)
	_, _ = fmt.Fprintf(w, "cartethyia_hidden_recoveries_total %d\n", r.hiddenRecoveries.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_avoidable_errors_total %d\n", r.avoidableErrors.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_typed_exhaustions_total %d\n", r.typedExhaustions.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_provider_prompt_cache_read_tokens_total %d\n", r.providerCacheReadTokens.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_provider_prompt_cache_write_tokens_total %d\n", r.providerCacheWriteTokens.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_provider_prompt_cache_eligible_prefix_tokens_total %d\n", r.providerCacheEligiblePrefix.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_provider_prompt_cache_hit_prefix_tokens_total %d\n", r.providerCacheHitPrefix.Load())
	eligible := r.providerCacheEligiblePrefix.Load()
	hit := r.providerCacheHitPrefix.Load()
	ratio := 0.0
	if eligible > 0 {
		ratio = float64(hit) / float64(eligible)
	}
	_, _ = fmt.Fprintf(w, "cartethyia_provider_prompt_cache_eligible_prefix_hit_ratio %g\n", ratio)
	renderHistogram(w, "cartethyia_attempts_per_request", attemptHistogramBounds[:], r.attemptBuckets[:], r.attemptSum.Load(), r.attemptCount.Load())
	renderHistogram(w, "cartethyia_admission_wait_milliseconds", durationHistogramBounds[:], r.admissionBuckets[:], r.admissionSum.Load(), r.admissionCount.Load())
	renderHistogram(w, "cartethyia_stream_duration_milliseconds", durationHistogramBounds[:], r.streamBuckets[:], r.streamSum.Load(), r.streamCount.Load())
	_, _ = fmt.Fprintf(w, "cartethyia_observability_drops_total %d\n", r.EventDrops())
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
	case StageCandidateExclusion:
		return "cartethyia_candidate_exclusions_total"
	case StageRepair:
		return "cartethyia_repairs_total"
	case StageStreamFinalization:
		return "cartethyia_stream_finalizations_total"
	case StageCacheLookup:
		return "cartethyia_cache_lookups_total"
	case StageTerminal:
		return "cartethyia_request_outcomes_total"
	case StageCompatibilityPlan:
		return "cartethyia_compatibility_plan_outcomes_total"
	case StageOperation:
		return "cartethyia_operation_outcomes_total"
	case StageCapability:
		return "cartethyia_capability_rejections_total"
	case StageRecovery:
		return "cartethyia_recovery_events_total"
	case StageExhaustion:
		return "cartethyia_exhaustion_total"
	default:
		return "cartethyia_events_total"
	}
}

func (r *Registry) observeAttempts(value int) {
	if value < 0 {
		value = 0
	}
	if value > MaxAttempts {
		value = MaxAttempts
	}
	r.attemptCount.Add(1)
	r.attemptSum.Add(uint64(value))
	for i, bound := range attemptHistogramBounds {
		if uint64(value) <= bound {
			r.attemptBuckets[i].Add(1)
		}
	}
}

func (r *Registry) observeAdmissionWait(milliseconds int64) {
	observeDuration(milliseconds, &r.admissionBuckets, &r.admissionSum, &r.admissionCount)
}

func (r *Registry) observeStreamDuration(milliseconds int64) {
	observeDuration(milliseconds, &r.streamBuckets, &r.streamSum, &r.streamCount)
}

func observeDuration(milliseconds int64, buckets *[14]atomic.Uint64, sum, count *atomic.Uint64) {
	if milliseconds < 0 {
		milliseconds = 0
	}
	if milliseconds > MaxLatencyMS {
		milliseconds = MaxLatencyMS
	}
	count.Add(1)
	sum.Add(uint64(milliseconds))
	for i, bound := range durationHistogramBounds {
		if uint64(milliseconds) <= bound {
			buckets[i].Add(1)
		}
	}
}

func renderHistogram(w http.ResponseWriter, name string, bounds []uint64, buckets []atomic.Uint64, sum, count uint64) {
	for i, bound := range bounds {
		_, _ = fmt.Fprintf(w, "%s_bucket{le=\"%d\"} %d\n", name, bound, buckets[i].Load())
	}
	_, _ = fmt.Fprintf(w, "%s_bucket{le=\"+Inf\"} %d\n", name, count)
	_, _ = fmt.Fprintf(w, "%s_sum %d\n", name, sum)
	_, _ = fmt.Fprintf(w, "%s_count %d\n", name, count)
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
