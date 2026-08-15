// Bounded request lifecycle events for the daemon observability package.
//
// Every long-lived HTTP / proxy / provider request emits a small set of
// classified events: start, route attempt, provider usage, cache lookup, and
// terminal outcome. The classification is intentionally narrow so that:
//   - cardinality stays bounded (a fixed enum, not user-supplied free text)
//   - secret leakage is structurally impossible (no place to put a prompt)
//   - provider prompt-cache evidence cannot be conflated with Redis/memory
//     resolution-cache hits (CacheKind is the discriminator)
//
// Terminal idempotence is enforced via Recorder: each request_id may emit at
// most one terminal event; subsequent attempts return ErrDuplicateTerminal so
// callers cannot double-count.
package observability

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Errors returned by the Recorder / Event validation paths.
var (
	ErrDuplicateTerminal = errors.New("observability: terminal event already recorded for request")
	ErrRecorderClosed    = errors.New("observability: recorder is closed")
	ErrInvalidEvent      = errors.New("observability: invalid event")
	ErrTooLarge          = errors.New("observability: event payload exceeds bounded size")
)

// Stage identifies the bounded lifecycle phase of a request. Values are
// deliberately short so they double as compact metric labels.
type Stage string

const (
	StageRequestStart       Stage = "request_start"
	StageRouteAttempt       Stage = "route_attempt"
	StageProviderCall       Stage = "provider_call"
	StageCandidateExclusion Stage = "candidate_exclusion"
	StageRepair             Stage = "repair"
	StageStreamFinalization Stage = "stream_finalization"
	StageCacheLookup        Stage = "cache_lookup"
	StageTerminal           Stage = "terminal"
	StageCompatibilityPlan  Stage = "compatibility_plan"
	StageOperation          Stage = "operation"
	StageCapability         Stage = "capability"
	StageRecovery           Stage = "recovery"
	StageExhaustion         Stage = "exhaustion"
)

// Outcome is the bounded terminal classification of a request. Only a small
// fixed set is permitted; callers must not invent free-form outcomes.
type Outcome string

const (
	OutcomeSuccess      Outcome = "success"
	OutcomeError        Outcome = "error"
	OutcomeCancelled    Outcome = "cancelled"
	OutcomeQuota        Outcome = "quota_exceeded"
	OutcomeAuthFailed   Outcome = "auth_failed"
	OutcomeUpstreamFail Outcome = "upstream_failed"
	OutcomeInvalidReq   Outcome = "invalid_request"
	OutcomeUnavailable  Outcome = "unavailable"
)

// CacheKind distinguishes provider-side prompt-cache evidence from local
// resolution-cache hits. The two categories MUST NOT be conflated: the proxy
// uses resolution cache to skip work entirely, while provider prompt cache
// only affects billing / TTL after the provider executes the call. Each kind
// produces a distinct metric series so dashboards can render them
// separately.
type CacheKind int8

const (
	CacheKindUnspecified CacheKind = iota
	CacheKindResolutionMemory
	CacheKindResolutionRedis
	CacheKindProviderPrompt
)

// String returns a stable, lowercased identifier suitable for metric labels.
func (c CacheKind) String() string {
	switch c {
	case CacheKindResolutionMemory:
		return "resolution_memory"
	case CacheKindResolutionRedis:
		return "resolution_redis"
	case CacheKindProviderPrompt:
		return "provider_prompt"
	case CacheKindPlanL0:
		return "plan_l0"
	case CacheKindPlanL1:
		return "plan_l1"
	case CacheKindTokenSaverL0:
		return "token_saver_l0"
	case CacheKindTokenSaverRedis:
		return "token_saver_redis"
	case CacheKindResponseL0:
		return "response_l0"
	case CacheKindResponseRedis:
		return "response_redis"
	default:
		return "unspecified"
	}
}

// IsResolutionCache reports whether c describes a local resolution-cache
// hit/miss (memory or Redis).
func (c CacheKind) IsResolutionCache() bool {
	return c == CacheKindResolutionMemory || c == CacheKindResolutionRedis || c == CacheKindPlanL0 || c == CacheKindPlanL1 || c == CacheKindTokenSaverL0 || c == CacheKindTokenSaverRedis || c == CacheKindResponseL0 || c == CacheKindResponseRedis
}

// IsProviderCache reports whether c describes provider-side prompt-cache
// evidence.
func (c CacheKind) IsProviderCache() bool {
	return c == CacheKindProviderPrompt
}

// IsZero reports whether the cache kind was not set.
func (c CacheKind) IsZero() bool {
	return c == CacheKindUnspecified
}

// Surface is the bounded surface that originated the request.
type Surface string

const (
	SurfaceHTTP    Surface = "http"
	SurfaceStream  Surface = "stream"
	SurfaceAdmin   Surface = "admin"
	SurfaceWorker  Surface = "worker"
	SurfaceUnknown Surface = "unknown"
)

// RequestEvent is a single bounded lifecycle event. The struct deliberately
// has no Prompt, Body, or Credential fields; raw content has no place here.
// Correlation identifiers (request_id, trace_id) are kept for log fields and
// NEVER propagated to metric labels.
//
// The EventKey / Rate* / Retryable / RetryAfterMS / AlternateAccountEligible
// fields are additive metadata used by the lifecycle and rate-limit action
// surfaces. They are bounded by Validate (no free-form text, no sensitive
// material) and are emitted to log fields only by default; the metric label
// allow-list is intentionally NOT widened so cardinality stays bounded.
type RequestEvent struct {
	RequestID      string
	TraceID        string
	Method         string
	Path           string
	Stage          Stage
	Outcome        Outcome
	Provider       string
	Model          string
	Surface        Surface
	Attempt        int
	LatencyMS      int64
	CacheKind      CacheKind
	CacheHit       bool
	ErrorClass     string
	ErrorCode      string
	Origin         string
	ClientFamily   string
	AccountID      string
	AccountEmail   string
	AccountName    string
	AccountDisplay string
	ProxyID        string
	ProxyName      string
	ProxyDisplay   string
	ProxySource    string
	// EventKey is the bounded lifecycle translated key (for example
	// "request.rate_limited", "request.account_switch"). It is structural,
	// not free-form: callers MUST use a fixed enum. The set is owned by the
	// lifecycle package; observability only validates boundedness.
	EventKey string
	// RateSource identifies which rate-limit subsystem produced the signal
	// ("upstream", "local", "admission", "").
	RateSource string
	// RateScope identifies the bounded scope of the rate limit ("model",
	// "account", "proxy", "surface", "").
	RateScope string
	// RatePhase identifies the bounded phase at which the rate signal was
	// produced ("precheck", "backoff", "blocked", "").
	RatePhase string
	// Retryable reports whether the lifecycle considers the failure retryable.
	Retryable bool
	// RetryAfterMS is a hint, in milliseconds, for when the caller may retry.
	// 0 means "no hint"; values are bounded to MaxLatencyMS (24h) for safety.
	RetryAfterMS int64
	// AlternateAccountEligible reports whether the lifecycle considers an
	// alternate account a valid failover target for this failure.
	AlternateAccountEligible bool
	CatalogGeneration        uint64
	RouteMember              int
	NetworkMode              string
	FailureScope             string
	FailurePhase             string
	RetryAction              string
	RepairRule               string
	ExclusionReason          string
	AttemptResult            AttemptResult
	RepairChanged            bool
	RepairApplied            bool
	StreamOutcome            StreamOutcome
	Committed                bool
	Usage                    TokenUsage
	StartedAt                time.Time
	EndedAt                  time.Time
	// Compatibility and cache dimensions are fixed-code labels. They are
	// omitted from metric output when empty and never carry request content.
	SourceSurface     string
	TargetSurface     string
	Profile           string
	DispositionAction string
	PlanOutcome       string
	CacheOperation    string
	CacheOutcome      string
	CacheLayer        string
	Operation         string
	CompactionVersion string
	Bridge            string
	RepairDisposition string
	RecoveryKind      string
	ExhaustionReason  string
	CapabilityCode    string
	Modality          string
	ReferenceKind     string
}

// Bounds enforced on RequestEvent fields.
const (
	MaxAttempts         = 8
	MaxIdentifierLen    = 96
	MaxErrorClassLen    = 64
	MaxErrorCodeLen     = 96
	MaxLatencyMS        = int64(24 * 60 * 60 * 1000) // 24h sanity ceiling
	MaxConcurrentEvents = 1024
	MaxTerminalKeys     = 4096
	// MaxEventKeyLen caps the lifecycle EventKey. The lifecycle package owns
	// the canonical set; this bound only prevents accidental free-form text.
	MaxEventKeyLen = 96
	// MaxRateTagLen caps the bounded rate-limit identifiers (source / scope
	// / phase). 32 is plenty for "upstream", "admission", "precheck", etc.
	MaxRateTagLen = 32
)

// containsSensitiveMaterial rejects credential-shaped values before they can
// become metric labels. Provider and model IDs are bounded identifiers, but
// callers must not be able to smuggle an authorization header or raw token
// into the metrics stream.
func containsSensitiveMaterial(value string) bool {
	lower := strings.ToLower(value)
	for _, marker := range []string{
		"authorization", "api_key", "apikey", "access_token", "refresh_token",
		"client_secret", "password=", "credential=", "secret=", "token=",
		"bearer ", "cookie=",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// Validate returns nil if the event is bounded and well-formed.
func (e RequestEvent) Validate() error {
	switch e.Stage {
	case StageRequestStart, StageRouteAttempt, StageProviderCall, StageCandidateExclusion,
		StageRepair, StageStreamFinalization, StageCacheLookup, StageTerminal,
		StageCompatibilityPlan, StageOperation, StageCapability, StageRecovery, StageExhaustion:
	default:
		return fmt.Errorf("%w: stage=%q", ErrInvalidEvent, e.Stage)
	}
	if e.Surface == "" {
		return fmt.Errorf("%w: empty surface", ErrInvalidEvent)
	}
	switch e.Surface {
	case SurfaceHTTP, SurfaceStream, SurfaceAdmin, SurfaceWorker, SurfaceUnknown:
	default:
		return fmt.Errorf("%w: surface=%q", ErrInvalidEvent, e.Surface)
	}
	for _, field := range []struct {
		name  string
		value string
		max   int
	}{
		{"request_id", e.RequestID, MaxIdentifierLen},
		{"trace_id", e.TraceID, MaxIdentifierLen},
		{"method", e.Method, 16},
		{"path", e.Path, 128},
		{"origin", e.Origin, 32},
		{"client_family", e.ClientFamily, 32},
		{"account_id", e.AccountID, MaxIdentifierLen},
		{"account_email", e.AccountEmail, MaxIdentifierLen},
		{"account_name", e.AccountName, MaxIdentifierLen},
		{"account_display", e.AccountDisplay, MaxIdentifierLen},
		{"proxy_id", e.ProxyID, MaxIdentifierLen},
		{"proxy_name", e.ProxyName, MaxIdentifierLen},
		{"proxy_display", e.ProxyDisplay, MaxIdentifierLen},
		{"proxy_source", e.ProxySource, 16},
		{"error_code", e.ErrorCode, MaxErrorCodeLen},
		{"event_key", e.EventKey, MaxEventKeyLen},
		{"rate_source", e.RateSource, MaxRateTagLen},
		{"rate_scope", e.RateScope, MaxRateTagLen},
		{"rate_phase", e.RatePhase, MaxRateTagLen},
		{"network_mode", e.NetworkMode, MaxRateTagLen},
		{"failure_scope", e.FailureScope, MaxRateTagLen},
		{"failure_phase", e.FailurePhase, MaxRateTagLen},
		{"retry_action", e.RetryAction, MaxErrorClassLen},
		{"repair_rule", e.RepairRule, MaxErrorCodeLen},
		{"exclusion_reason", e.ExclusionReason, MaxRateTagLen},
	} {
		if len(field.value) > field.max || strings.IndexFunc(field.value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return fmt.Errorf("%w: %s exceeds bounds", ErrTooLarge, field.name)
		}
		if containsSensitiveMaterial(field.value) {
			return fmt.Errorf("%w: sensitive %s", ErrInvalidEvent, field.name)
		}
	}
	if e.ProxySource != "" {
		switch e.ProxySource {
		case "configured", "direct", "none", "unknown":
		default:
			return fmt.Errorf("%w: invalid proxy_source", ErrInvalidEvent)
		}
	}
	if len(e.Provider) > MaxIdentifierLen {
		return fmt.Errorf("%w: provider too long", ErrTooLarge)
	}
	if len(e.Model) > MaxIdentifierLen {
		return fmt.Errorf("%w: model too long", ErrTooLarge)
	}
	if containsSensitiveMaterial(e.Provider) || containsSensitiveMaterial(e.Model) || containsSensitiveMaterial(e.ErrorClass) {
		return fmt.Errorf("%w: sensitive identifier", ErrInvalidEvent)
	}
	if len(e.ErrorClass) > MaxErrorClassLen {
		return fmt.Errorf("%w: error_class too long", ErrTooLarge)
	}
	if e.Attempt < 0 || e.Attempt > MaxAttempts {
		return fmt.Errorf("%w: attempt=%d", ErrInvalidEvent, e.Attempt)
	}
	if e.LatencyMS < 0 || e.LatencyMS > MaxLatencyMS {
		return fmt.Errorf("%w: latency_ms=%d", ErrInvalidEvent, e.LatencyMS)
	}
	if e.RetryAfterMS < 0 || e.RetryAfterMS > MaxLatencyMS {
		return fmt.Errorf("%w: retry_after_ms=%d", ErrInvalidEvent, e.RetryAfterMS)
	}
	if e.RouteMember < 0 || e.RouteMember > MaxAttempts {
		return fmt.Errorf("%w: route_member=%d", ErrInvalidEvent, e.RouteMember)
	}
	if e.AttemptResult != "" && e.AttemptResult != AttemptSucceeded && e.AttemptResult != AttemptFailed {
		return fmt.Errorf("%w: attempt_result=%q", ErrInvalidEvent, e.AttemptResult)
	}
	if e.StreamOutcome != "" {
		switch e.StreamOutcome {
		case StreamClean, StreamFailed, StreamCanceled, StreamStalled, StreamTruncated, StreamDownstreamWrite:
		default:
			return fmt.Errorf("%w: stream_outcome=%q", ErrInvalidEvent, e.StreamOutcome)
		}
	}
	if e.Usage.Known & ^UsageMask(UsageInput|UsageOutput|UsageCachedRead|UsageCachedWrite|UsageReasoning|UsageTotal) != 0 {
		return fmt.Errorf("%w: usage mask", ErrInvalidEvent)
	}
	for _, count := range []int64{e.Usage.Input, e.Usage.Output, e.Usage.CachedRead, e.Usage.CachedWrite, e.Usage.Reasoning, e.Usage.Total} {
		if count < 0 || count > 1<<50 {
			return fmt.Errorf("%w: usage count", ErrInvalidEvent)
		}
	}
	if e.Stage == StageCacheLookup && e.CacheKind.IsZero() {
		return fmt.Errorf("%w: cache_lookup without cache_kind", ErrInvalidEvent)
	}
	if !e.CacheKind.IsZero() && !validCacheKind(e.CacheKind) {
		return fmt.Errorf("%w: invalid cache_kind", ErrInvalidEvent)
	}
	if e.Stage != StageCacheLookup && !e.CacheKind.IsZero() {
		return fmt.Errorf("%w: cache_kind only valid with StageCacheLookup", ErrInvalidEvent)
	}
	if e.Stage != StageTerminal && e.Outcome != "" && e.Outcome != OutcomeSuccess {
		return fmt.Errorf("%w: outcome=%q requires StageTerminal", ErrInvalidEvent, e.Outcome)
	}
	if e.Stage == StageTerminal && e.Outcome == "" {
		return fmt.Errorf("%w: terminal stage requires outcome", ErrInvalidEvent)
	}

	if e.Outcome != "" {
		switch e.Outcome {
		case OutcomeSuccess, OutcomeError, OutcomeCancelled, OutcomeQuota, OutcomeAuthFailed,
			OutcomeUpstreamFail, OutcomeInvalidReq, OutcomeUnavailable:
		default:
			return fmt.Errorf("%w: outcome=%q", ErrInvalidEvent, e.Outcome)
		}
	}
	if e.Stage == StageCandidateExclusion && e.ExclusionReason == "" {
		return fmt.Errorf("%w: candidate exclusion requires reason", ErrInvalidEvent)
	}
	if e.ExclusionReason != "" {
		switch e.ExclusionReason {
		case "disabled", "exhausted", "cooling", "model_locked", "already_attempted", "unavailable", "proxy_unavailable", "quota_exhausted", "candidate", "deadline", "cost", "hard_attempt", "translation", "credential", "quota", "network":
		default:
			return fmt.Errorf("%w: exclusion_reason=%q", ErrInvalidEvent, e.ExclusionReason)
		}
	}
	if e.Stage == StageRepair && e.RepairRule == "" {
		return fmt.Errorf("%w: repair requires rule", ErrInvalidEvent)
	}
	if e.RepairDisposition != "" {
		if _, ok := toolRepairDispositions[e.RepairDisposition]; !ok {
			return fmt.Errorf("%w: repair disposition", ErrInvalidEvent)
		}
	}
	if e.Stage == StageStreamFinalization && e.StreamOutcome == "" {
		return fmt.Errorf("%w: stream finalization requires outcome", ErrInvalidEvent)
	}
	for _, field := range []struct {
		name, value string
		max         int
	}{
		{"source_surface", e.SourceSurface, MaxRateTagLen}, {"target_surface", e.TargetSurface, MaxRateTagLen},
		{"profile", e.Profile, MaxRateTagLen}, {"disposition_action", e.DispositionAction, MaxRateTagLen},
		{"plan_outcome", e.PlanOutcome, MaxRateTagLen}, {"cache_operation", e.CacheOperation, MaxRateTagLen},
		{"cache_outcome", e.CacheOutcome, MaxRateTagLen}, {"cache_layer", e.CacheLayer, MaxRateTagLen},
		{"operation", e.Operation, MaxRateTagLen}, {"compaction_version", e.CompactionVersion, MaxRateTagLen},
		{"bridge", e.Bridge, MaxRateTagLen}, {"repair_disposition", e.RepairDisposition, MaxRateTagLen},
		{"recovery_kind", e.RecoveryKind, MaxRateTagLen}, {"exhaustion_reason", e.ExhaustionReason, MaxRateTagLen},
		{"capability_code", e.CapabilityCode, MaxErrorCodeLen}, {"modality", e.Modality, MaxRateTagLen},
		{"reference_kind", e.ReferenceKind, MaxRateTagLen},
	} {
		if len(field.value) > field.max || strings.IndexFunc(field.value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
			return fmt.Errorf("%w: %s exceeds bounds", ErrTooLarge, field.name)
		}
		if containsSensitiveMaterial(field.value) {
			return fmt.Errorf("%w: sensitive %s", ErrInvalidEvent, field.name)
		}
	}
	if !dimensionAllowed(e.SourceSurface, compatibilitySurfaces) || !dimensionAllowed(e.TargetSurface, compatibilitySurfaces) ||
		!dimensionAllowed(e.Profile, compatibilityProfiles) || !dimensionAllowed(e.DispositionAction, planActions) ||
		!dimensionAllowed(e.CompactionVersion, compactionVersions) || !dimensionAllowed(e.Bridge, bridgeOutcomes) ||
		!dimensionAllowed(e.Operation, operations) || !dimensionAllowed(e.RecoveryKind, recoveryKinds) ||
		!dimensionAllowed(e.ExhaustionReason, exclusionReasons) || !dimensionAllowed(e.RepairDisposition, toolRepairDispositions) ||
		!dimensionAllowed(e.PlanOutcome, evidenceOutcomes) || !dimensionAllowed(e.CacheOperation, map[string]struct{}{string(CacheLookup): {}, string(CacheHit): {}, string(CacheWrite): {}, string(CacheReject): {}, string(CacheFallback): {}}) ||
		!dimensionAllowed(e.CacheOutcome, cacheOutcomes) || !dimensionAllowed(e.CacheLayer, map[string]struct{}{"l0": {}, "l1": {}, "memory": {}, "redis": {}, "provider": {}, "none": {}}) ||
		!dimensionAllowed(e.CapabilityCode, capabilityCodes) || !dimensionAllowed(e.Modality, modalities) || !dimensionAllowed(e.ReferenceKind, referenceKinds) {
		return fmt.Errorf("%w: unrecognized evidence dimension", ErrInvalidEvent)
	}
	if e.Stage == StageCompatibilityPlan && (e.SourceSurface == "" || e.TargetSurface == "" || e.Profile == "" || e.DispositionAction == "" || e.PlanOutcome == "") {
		return fmt.Errorf("%w: compatibility plan dimensions required", ErrInvalidEvent)
	}
	if e.Stage == StageOperation && e.Operation == "" {
		return fmt.Errorf("%w: operation required", ErrInvalidEvent)
	}
	if e.Stage == StageCapability && e.CapabilityCode == "" {
		return fmt.Errorf("%w: capability code required", ErrInvalidEvent)
	}
	if e.Stage == StageRecovery && e.RecoveryKind == "" {
		return fmt.Errorf("%w: recovery kind required", ErrInvalidEvent)
	}
	if e.Stage == StageExhaustion && e.ExhaustionReason == "" {
		return fmt.Errorf("%w: exhaustion reason required", ErrInvalidEvent)
	}
	return nil
}

// IsTerminal reports whether the event describes the terminal outcome of a
// request.
func (e RequestEvent) IsTerminal() bool {
	return e.Stage == StageTerminal
}

// MetricLabels returns the bounded metric label set for the event. The
// returned slice is independently validated against DefaultLabelAllowList so
// callers cannot accidentally smuggle request IDs into the metric pipeline.
// Returns nil if the event produces no metric labels (e.g., request start).
func (e RequestEvent) MetricLabels() []Label {
	switch e.Stage {
	case StageRequestStart:
		return nil
	case StageCacheLookup:
		hit := "false"
		if e.CacheHit {
			hit = "true"
		}
		labels := []Label{
			{Key: "surface", Value: string(e.Surface)},
			{Key: "cache_kind", Value: e.CacheKind.String()},
			{Key: "cache_layer", Value: cacheLayerLabel(e.CacheKind)},
			{Key: "hit", Value: hit},
		}
		if e.CacheOperation != "" {
			labels = append(labels, Label{Key: "cache_operation", Value: e.CacheOperation})
		}
		if e.CacheOutcome != "" {
			labels = append(labels, Label{Key: "cache_result", Value: e.CacheOutcome})
		}
		if e.CacheLayer != "" {
			labels = append(labels, Label{Key: "cache_layer", Value: e.CacheLayer})
		}
		return labels
	case StageRouteAttempt, StageTerminal:
		labels := []Label{
			{Key: "surface", Value: string(e.Surface)},
			{Key: "stage", Value: string(e.Stage)},
		}
		if e.Stage == StageTerminal && e.Outcome != "" {
			labels = append(labels, Label{Key: "outcome", Value: string(e.Outcome)})
		}
		return labels
	case StageProviderCall:
		return []Label{
			{Key: "surface", Value: string(e.Surface)},
			{Key: "stage", Value: string(e.Stage)},
			{Key: "outcome", Value: string(e.AttemptResult)},
		}
	case StageCandidateExclusion:
		return []Label{
			{Key: "stage", Value: string(e.Stage)},
			{Key: "error_class", Value: e.ExclusionReason},
		}
	case StageRepair:
		outcome := "rejected"
		if e.RepairApplied {
			outcome = "applied"
		}
		if e.RepairDisposition != "" {
			outcome = e.RepairDisposition
		}
		return []Label{{Key: "stage", Value: string(e.Stage)}, {Key: "outcome", Value: outcome}}
	case StageStreamFinalization:
		return []Label{
			{Key: "surface", Value: string(e.Surface)},
			{Key: "stage", Value: string(e.Stage)},
			{Key: "outcome", Value: string(e.StreamOutcome)},
		}
	case StageCompatibilityPlan:
		return []Label{{Key: "source_surface", Value: e.SourceSurface}, {Key: "target_surface", Value: e.TargetSurface}, {Key: "profile", Value: e.Profile}, {Key: "action", Value: e.DispositionAction}, {Key: "outcome", Value: e.PlanOutcome}}
	case StageOperation:
		labels := []Label{{Key: "operation", Value: e.Operation}}
		if e.CompactionVersion != "" {
			labels = append(labels, Label{Key: "compaction_version", Value: e.CompactionVersion})
		}
		if e.Bridge != "" {
			labels = append(labels, Label{Key: "bridge", Value: e.Bridge})
		}
		if e.PlanOutcome != "" {
			labels = append(labels, Label{Key: "outcome", Value: e.PlanOutcome})
		}
		return labels
	case StageCapability:
		labels := []Label{{Key: "capability_code", Value: e.CapabilityCode}}
		if e.Operation != "" {
			labels = append(labels, Label{Key: "operation", Value: e.Operation})
		}
		if e.Modality != "" {
			labels = append(labels, Label{Key: "modality", Value: e.Modality})
		}
		if e.ReferenceKind != "" {
			labels = append(labels, Label{Key: "reference_kind", Value: e.ReferenceKind})
		}
		return labels
	case StageRecovery:
		return []Label{{Key: "recovery", Value: e.RecoveryKind}}
	case StageExhaustion:
		return []Label{{Key: "exhaustion_reason", Value: e.ExhaustionReason}}
	default:
		return nil
	}
}

// cacheLayerLabel separates the resolution-cache layer (memory / redis) from
// the provider prompt-cache layer so dashboards can render them on different
// axes.
func cacheLayerLabel(k CacheKind) string {
	switch k {
	case CacheKindResolutionMemory:
		return "memory"
	case CacheKindResolutionRedis:
		return "redis"
	case CacheKindProviderPrompt:
		return "provider"
	case CacheKindPlanL0, CacheKindTokenSaverL0, CacheKindResponseL0:
		return "l0"
	case CacheKindPlanL1, CacheKindTokenSaverRedis, CacheKindResponseRedis:
		return "redis"
	default:
		return "none"
	}
}

// LogFields returns the bounded log field set for the event. Includes the
// correlation identifiers that the metric path explicitly rejects.
func (e RequestEvent) LogFields() []Field {
	fields := []Field{
		String("stage", string(e.Stage)),
		String("surface", string(e.Surface)),
	}
	if e.RequestID != "" {
		fields = append(fields, String("request_id", e.RequestID))
	}
	if e.TraceID != "" {
		fields = append(fields, String("trace_id", e.TraceID))
	}
	if e.Provider != "" {
		fields = append(fields, String("provider", e.Provider))
	}
	if e.Model != "" {
		fields = append(fields, String("model", e.Model))
	}
	if e.Outcome != "" {
		fields = append(fields, String("outcome", string(e.Outcome)))
	}
	if e.Attempt > 0 {
		fields = append(fields, Int("attempt", e.Attempt))
	}
	if e.LatencyMS > 0 {
		fields = append(fields, Int64("latency_ms", e.LatencyMS))
	}
	if !e.CacheKind.IsZero() {
		fields = append(fields, String("cache_kind", e.CacheKind.String()))
		fields = append(fields, Bool("cache_hit", e.CacheHit))
	}
	if e.ErrorClass != "" {
		fields = append(fields, String("error_class", e.ErrorClass))
	}
	if e.ErrorCode != "" {
		fields = append(fields, String("error_code", e.ErrorCode))
	}
	if e.EventKey != "" {
		fields = append(fields, String("event_key", e.EventKey))
	}
	if e.RateSource != "" {
		fields = append(fields, String("rate_source", e.RateSource))
	}
	if e.RateScope != "" {
		fields = append(fields, String("rate_scope", e.RateScope))
	}
	if e.RatePhase != "" {
		fields = append(fields, String("rate_phase", e.RatePhase))
	}
	if e.Retryable {
		fields = append(fields, Bool("retryable", true))
	}
	if e.RetryAfterMS > 0 {
		fields = append(fields, Int64("retry_after_ms", e.RetryAfterMS))
	}
	if e.AlternateAccountEligible {
		fields = append(fields, Bool("alternate_account_eligible", true))
	}
	if e.CatalogGeneration > 0 {
		fields = append(fields, Int64("catalog_generation", int64(e.CatalogGeneration)))
	}
	fields = append(fields, Int("route_member", e.RouteMember))
	if e.NetworkMode != "" {
		fields = append(fields, String("network_mode", e.NetworkMode))
	}
	if e.FailureScope != "" {
		fields = append(fields, String("failure_scope", e.FailureScope))
	}
	if e.FailurePhase != "" {
		fields = append(fields, String("failure_phase", e.FailurePhase))
	}
	if e.RetryAction != "" {
		fields = append(fields, String("retry_action", e.RetryAction))
	}
	if e.RepairRule != "" {
		fields = append(fields, String("repair_rule", e.RepairRule))
	}
	if e.ExclusionReason != "" {
		fields = append(fields, String("exclusion_reason", e.ExclusionReason))
	}
	if e.AttemptResult != "" {
		fields = append(fields, String("attempt_result", string(e.AttemptResult)))
	}
	if e.Stage == StageRepair {
		fields = append(fields, Bool("repair_changed", e.RepairChanged), Bool("repair_applied", e.RepairApplied))
	}
	if e.StreamOutcome != "" {
		fields = append(fields, String("stream_outcome", string(e.StreamOutcome)), Bool("committed", e.Committed))
	}
	fields = appendUsageFields(fields, e.Usage)
	if e.Origin != "" {
		fields = append(fields, String("origin", e.Origin))
	}
	if e.ClientFamily != "" {
		fields = append(fields, String("client_family", e.ClientFamily))
	}
	if e.AccountDisplay != "" {
		fields = append(fields, String("account_display", e.AccountDisplay))
	}
	if e.AccountID != "" {
		fields = append(fields, String("account_id", e.AccountID))
	}
	if e.ProxyDisplay != "" {
		fields = append(fields, String("proxy_display", e.ProxyDisplay))
	}
	if e.ProxyID != "" {
		fields = append(fields, String("proxy_id", e.ProxyID))
	}
	if e.ProxySource != "" {
		fields = append(fields, String("proxy_source", e.ProxySource))
	}
	if !e.StartedAt.IsZero() {
		fields = append(fields, Time("started_at", e.StartedAt))
	}
	if !e.EndedAt.IsZero() {
		fields = append(fields, Time("ended_at", e.EndedAt))
	}
	for _, field := range []struct{ key, value string }{
		{"source_surface", e.SourceSurface}, {"target_surface", e.TargetSurface}, {"profile", e.Profile},
		{"action", e.DispositionAction}, {"plan_outcome", e.PlanOutcome}, {"cache_operation", e.CacheOperation},
		{"cache_result", e.CacheOutcome}, {"cache_layer", e.CacheLayer}, {"operation", e.Operation},
		{"compaction_version", e.CompactionVersion}, {"bridge", e.Bridge}, {"repair_disposition", e.RepairDisposition},
		{"recovery", e.RecoveryKind}, {"exhaustion_reason", e.ExhaustionReason}, {"capability_code", e.CapabilityCode},
		{"modality", e.Modality}, {"reference_kind", e.ReferenceKind},
	} {
		if field.value != "" {
			fields = append(fields, String(field.key, field.value))
		}
	}
	return fields
}

// EventSink consumes emitted events. Implementations are expected to be
// cancellation-safe: a slow or failing sink MUST NOT block the request path
// or wedge the Recorder.
type EventSink interface {
	// Emit writes a single event. Returning an error counts as a soft
	// failure; the Recorder increments its drop counter but does not retry.
	Emit(ctx context.Context, event RequestEvent) error
}

// LogSink is a convenience EventSink that writes events through a Logger
// using the bounded log fields. It does not emit metrics; pair with
// Registry.RecordEvent for full coverage.
type LogSink struct {
	Logger Logger
}

// Emit writes the event as an info-level record.
func (s LogSink) Emit(ctx context.Context, e RequestEvent) error {
	if s.Logger == nil {
		return nil
	}
	s.Logger.Info(ctx, "request_event", e.LogFields()...)
	return nil
}

// Recorder buffers bounded RequestEvents and dispatches them to a sink. The
// recorder enforces:
//   - bounded buffer (drops are observable via Drops())
//   - cancellation safety (Record returns ctx.Err() when ctx is cancelled)
//   - terminal idempotence (one terminal event per RequestID)
//   - non-blocking emit (the sink runs in a worker goroutine)
//
// A nil sink is treated as a black hole: events are validated, terminal
// idempotence is enforced, and drops are still tracked.
type Recorder struct {
	sink          EventSink
	capacity      int
	ch            chan RequestEvent
	closeOnce     sync.Once
	sendMu        sync.RWMutex
	closed        atomic.Bool
	wg            sync.WaitGroup
	drops         atomic.Uint64
	validator     *labelValidator
	terminalsMu   sync.Mutex
	terminals     map[string]struct{}
	terminalOrder []string
}

// RecorderOption configures a Recorder.
type RecorderOption func(*Recorder)

// WithCapacity overrides the bounded buffer size. Values <= 0 default to 256.
func WithCapacity(n int) RecorderOption {
	return func(r *Recorder) {
		if n > 0 && n <= MaxConcurrentEvents {
			r.capacity = n
		}
	}
}

// WithValidator overrides the label validator. Tests use this to inject a
// permissive allowlist; production code should leave it default.
func WithValidator(v *labelValidator) RecorderOption {
	return func(r *Recorder) {
		if v != nil {
			r.validator = v
		}
	}
}

// NewRecorder constructs a Recorder that dispatches events to sink. The
// returned Recorder owns a background goroutine which exits when ctx is
// cancelled or Close is called.
func NewRecorder(ctx context.Context, sink EventSink, opts ...RecorderOption) *Recorder {
	r := &Recorder{
		sink:      sink,
		capacity:  256,
		validator: NewLabelValidator(),
		terminals: make(map[string]struct{}),
	}
	for _, opt := range opts {
		opt(r)
	}
	r.ch = make(chan RequestEvent, r.capacity)
	r.wg.Add(1)
	go r.run(ctx)
	return r
}

// run drains the event channel until it is closed or ctx is cancelled. Sink
// errors are counted as drops and never propagated.
func (r *Recorder) run(ctx context.Context) {
	defer r.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-r.ch:
			if !ok {
				return
			}
			r.emit(ctx, ev)
		}
	}
}

func (r *Recorder) emit(ctx context.Context, ev RequestEvent) {
	if r.sink == nil {
		return
	}
	if err := r.sink.Emit(ctx, ev); err != nil {
		r.drops.Add(1)
	}
}

// Record enqueues an event for emission. Behaviour:
//   - ErrRecorderClosed if Close has been called
//   - ErrInvalidEvent if the event fails Validate
//   - ErrDuplicateTerminal if a terminal event has already been recorded for
//     the same RequestID; the event is NOT enqueued
//   - ctx.Err() if ctx is cancelled and the buffer cannot accept the event
//   - nil on successful enqueue (drops due to a full buffer increment Drops)
//
// The method is safe for concurrent use.
func (r *Recorder) Record(ctx context.Context, event RequestEvent) error {
	r.sendMu.RLock()
	defer r.sendMu.RUnlock()
	if r.closed.Load() {
		return ErrRecorderClosed
	}
	if err := event.Validate(); err != nil {
		return err
	}
	if event.IsTerminal() {
		r.terminalsMu.Lock()
		if _, dup := r.terminals[event.RequestID]; dup && event.RequestID != "" {
			r.terminalsMu.Unlock()
			return ErrDuplicateTerminal
		}
		if event.RequestID != "" {
			if len(r.terminals) >= MaxTerminalKeys && len(r.terminalOrder) > 0 {
				oldest := r.terminalOrder[0]
				r.terminalOrder = r.terminalOrder[1:]
				delete(r.terminals, oldest)
			}
			r.terminals[event.RequestID] = struct{}{}
			r.terminalOrder = append(r.terminalOrder, event.RequestID)
		}
		r.terminalsMu.Unlock()
	}
	// Dispatch is strictly non-blocking. A saturated buffer drops evidence and
	// increments the monotonic drop counter rather than delaying the request.
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case r.ch <- event:
		return nil
	default:
		r.drops.Add(1)
		return nil
	}
}

// ForgetTerminal clears the terminal record for requestID. Tests use this to
// reset state between cases; production callers should not need it.
func (r *Recorder) ForgetTerminal(requestID string) {
	r.terminalsMu.Lock()
	delete(r.terminals, requestID)
	for i, id := range r.terminalOrder {
		if id == requestID {
			r.terminalOrder = append(r.terminalOrder[:i], r.terminalOrder[i+1:]...)
			break
		}
	}
	r.terminalsMu.Unlock()
}

// Drops returns the cumulative count of events that were rejected by the
// bounded buffer or by the sink. The counter is monotonic for the lifetime
// of the Recorder.
func (r *Recorder) Drops() uint64 {
	return r.drops.Load()
}

// Close drains the buffer and stops the worker. After Close, Record returns
// ErrRecorderClosed.
func (r *Recorder) Close(_ context.Context) error {
	r.closeOnce.Do(func() {
		r.sendMu.Lock()
		r.closed.Store(true)
		close(r.ch)
		r.sendMu.Unlock()
	})
	r.wg.Wait()
	return nil
}

// NoopSink discards every event. Useful for tests that exercise the
// Recorder without binding it to a Logger.

type NoopSink struct{}

// Emit drops the event. It is itself a no-op but satisfies EventSink.
func (NoopSink) Emit(context.Context, RequestEvent) error { return nil }

// CountingSink records every emitted event in memory. Tests use this to
// assert the Recorder delivers the expected events.
type CountingSink struct {
	mu     sync.Mutex
	events []RequestEvent
}

// Emit appends the event to the in-memory list.
func (s *CountingSink) Emit(_ context.Context, e RequestEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, e)
	return nil
}

// Events returns a copy of the events recorded so far.
func (s *CountingSink) Events() []RequestEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]RequestEvent, len(s.events))
	copy(out, s.events)
	return out
}
