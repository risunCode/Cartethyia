package observability

import (
	"context"
	"strings"
	"time"
)

// AttemptObserver is the single non-blocking evidence boundary injected into
// the router. Implementations must bound all retained state and must not return
// failures to the request path.
type AttemptObserver interface {
	ObserveAttempt(AttemptEvidence)
	ObserveCandidateExclusion(CandidateExclusionEvidence)
	ObserveRepair(RepairEvidence)
	ObserveStreamFinalization(StreamFinalizationEvidence)
	ObserveRequestAttempts(int)
}

// UsageMask identifies which canonical token counters are known. Values are a
// bitset rather than pointers so recording evidence does not allocate.
type UsageMask uint8

const (
	UsageInput UsageMask = 1 << iota
	UsageOutput
	UsageCachedRead
	UsageCachedWrite
	UsageReasoning
	UsageTotal
)

// TokenUsage is the bounded provider-neutral usage subset carried by attempt
// and finalization evidence. Unknown counters have their mask bit cleared.
type TokenUsage struct {
	Known       UsageMask
	Input       int64
	Output      int64
	CachedRead  int64
	CachedWrite int64
	Reasoning   int64
	Total       int64
}

// AttemptResult is the fixed result set for one actual upstream call.
type AttemptResult string

const (
	AttemptSucceeded AttemptResult = "succeeded"
	AttemptFailed    AttemptResult = "failed"
)

// AttemptEvidence is one complete start/end record for one transport call. It
// deliberately has no request body, response body, headers, prompt, tool data,
// credential, cookie, URL, or hash field.
type AttemptEvidence struct {
	RequestID         string
	CatalogGeneration uint64
	Attempt           int
	RouteMember       int
	Provider          string
	Model             string
	AccountID         string
	NetworkMode       string
	ProxyID           string
	Surface           string
	Result            AttemptResult
	Code              string
	Scope             string
	Phase             string
	RetryAction       string
	RetryAfterMS      int64
	RepairRule        string
	StartedAt         time.Time
	EndedAt           time.Time
	LatencyMS         int64
	Usage             TokenUsage
	Failover          bool
}

// CandidateExclusionEvidence describes one bounded account exclusion. Account
// identity is operational metadata and is redacted by Registry before enqueue.
type CandidateExclusionEvidence struct {
	RequestID         string
	CatalogGeneration uint64
	RouteMember       int
	Provider          string
	Model             string
	AccountID         string
	Reason            string
	RetryAfterMS      int64
}

// RepairEvidence records one bounded compatibility proposal decision. It has
// no replacement body, request path, or body hash.
type RepairEvidence struct {
	RequestID         string
	CatalogGeneration uint64
	Attempt           int
	RouteMember       int
	Provider          string
	Rule              string
	Changed           bool
	Applied           bool
}

// StreamOutcome is the fixed exactly-once stream finalization classification.
type StreamOutcome string

const (
	StreamClean           StreamOutcome = "clean"
	StreamFailed          StreamOutcome = "failed"
	StreamCanceled        StreamOutcome = "canceled"
	StreamStalled         StreamOutcome = "stalled"
	StreamTruncated       StreamOutcome = "truncated"
	StreamDownstreamWrite StreamOutcome = "downstream_write"
)

// StreamFinalizationEvidence is emitted from the canonical sync.Once stream
// finalizer after authoritative lease/quota cleanup. Evidence failures are
// therefore unable to alter the already-determined client outcome.
type StreamFinalizationEvidence struct {
	RequestID         string
	CatalogGeneration uint64
	Attempt           int
	RouteMember       int
	Provider          string
	Model             string
	AccountID         string
	NetworkMode       string
	ProxyID           string
	Surface           string
	Outcome           StreamOutcome
	Code              string
	Committed         bool
	StartedAt         time.Time
	EndedAt           time.Time
	DurationMS        int64
	Usage             TokenUsage
}

func evidenceSurface(surface string) Surface {
	if strings.EqualFold(surface, string(SurfaceStream)) || strings.Contains(strings.ToLower(surface), "stream") {
		return SurfaceStream
	}
	return SurfaceHTTP
}

func redactedEvidenceID(value string, max int) string {
	value = boundedIdentifier(value, max)
	if containsSensitiveMaterial(value) {
		return "[redacted]"
	}
	return value
}

func boundedEvidenceTag(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		value = value[:max]
	}
	if strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return ""
	}
	if containsSensitiveMaterial(value) {
		return "[redacted]"
	}
	return value
}

func boundedTokenUsage(value TokenUsage) TokenUsage {
	value.Known &= UsageInput | UsageOutput | UsageCachedRead | UsageCachedWrite | UsageReasoning | UsageTotal
	counts := []*int64{&value.Input, &value.Output, &value.CachedRead, &value.CachedWrite, &value.Reasoning, &value.Total}
	for _, count := range counts {
		if *count < 0 || *count > 1<<50 {
			*count = 0
		}
	}
	return value
}

// ObserveAttempt records one complete attempt without returning an error to
// the router. Metrics use only fixed result/phase dimensions; operational IDs
// remain log/evidence fields and never become labels.
func (r *Registry) ObserveAttempt(e AttemptEvidence) {
	if r == nil {
		return
	}
	e.RequestID = redactedEvidenceID(e.RequestID, MaxIdentifierLen)
	e.Provider = redactedEvidenceID(e.Provider, MaxIdentifierLen)
	e.Model = redactedEvidenceID(e.Model, MaxIdentifierLen)
	e.AccountID = redactedEvidenceID(e.AccountID, MaxIdentifierLen)
	e.ProxyID = redactedEvidenceID(e.ProxyID, MaxIdentifierLen)
	e.NetworkMode = boundedEvidenceTag(e.NetworkMode, MaxRateTagLen)
	e.Code = boundedEvidenceTag(e.Code, MaxErrorCodeLen)
	e.Scope = boundedEvidenceTag(e.Scope, MaxRateTagLen)
	e.Phase = boundedEvidenceTag(e.Phase, MaxRateTagLen)
	e.RetryAction = boundedEvidenceTag(e.RetryAction, MaxErrorClassLen)
	e.RepairRule = boundedEvidenceTag(e.RepairRule, MaxErrorCodeLen)
	e.Usage = boundedTokenUsage(e.Usage)
	if e.Result != AttemptSucceeded {
		e.Result = AttemptFailed
	}
	if e.LatencyMS < 0 || e.LatencyMS > MaxLatencyMS {
		e.LatencyMS = 0
	}
	if e.RetryAfterMS < 0 {
		e.RetryAfterMS = 0
	} else if e.RetryAfterMS > MaxLatencyMS {
		e.RetryAfterMS = MaxLatencyMS
	}
	r.attempts.Add(1)
	if e.Result == AttemptFailed && evidenceSurface(e.Surface) == SurfaceStream {
		r.preCommitFailures.Add(1)
	}
	if e.Result == AttemptSucceeded && e.Failover {
		r.failoverSuccesses.Add(1)
		r.hiddenRecoveries.Add(1)
		r.avoidableErrors.Add(1)
	}
	if e.Result == AttemptSucceeded && e.RepairRule != "" {
		r.repairSuccesses.Add(1)
	}
	r.recordEvidence(RequestEvent{
		RequestID: e.RequestID, Stage: StageProviderCall, Surface: evidenceSurface(e.Surface),
		Provider: e.Provider, Model: e.Model, AccountID: e.AccountID, ProxyID: e.ProxyID,
		Attempt: e.Attempt, LatencyMS: e.LatencyMS, CatalogGeneration: e.CatalogGeneration,
		RouteMember: e.RouteMember, NetworkMode: e.NetworkMode, ErrorCode: e.Code,
		FailureScope: e.Scope, FailurePhase: e.Phase, RetryAction: e.RetryAction,
		RetryAfterMS: e.RetryAfterMS, RepairRule: e.RepairRule, AttemptResult: e.Result,
		StartedAt: e.StartedAt, EndedAt: e.EndedAt, Usage: e.Usage,
	})
	if e.Usage.Known&(UsageCachedRead|UsageCachedWrite) != 0 {
		op := CacheLookup
		outcome := "miss"
		if e.Usage.Known&UsageCachedRead != 0 && e.Usage.CachedRead > 0 {
			op, outcome = CacheHit, "hit"
		}
		r.ObserveProviderCache(ProviderCacheEvidence{Operation: op, Outcome: outcome,
			ReadTokens: e.Usage.CachedRead, WriteTokens: e.Usage.CachedWrite,
			EligiblePrefix: e.Usage.CachedRead + e.Usage.CachedWrite,
			HitPrefix:      e.Usage.CachedRead})
	}
}

func (r *Registry) ObserveCandidateExclusion(e CandidateExclusionEvidence) {
	r.ObserveCandidateExclusionBounded(e)
}

// ObserveCandidateExclusionBounded is the shared exclusion path for account
// availability and local preparation. Reasons are normalized to fixed
// categories before the event reaches metrics.
func (r *Registry) ObserveCandidateExclusionBounded(e CandidateExclusionEvidence) {
	if r == nil {
		return
	}
	e.RequestID = redactedEvidenceID(e.RequestID, MaxIdentifierLen)
	e.Provider = redactedEvidenceID(e.Provider, MaxIdentifierLen)
	e.Model = redactedEvidenceID(e.Model, MaxIdentifierLen)
	e.AccountID = redactedEvidenceID(e.AccountID, MaxIdentifierLen)
	e.Reason = validDimension(e.Reason, exclusionReasons)
	if e.Reason == "" || e.Reason == "other" {
		e.Reason = "candidate"
	}
	if e.RetryAfterMS < 0 {
		e.RetryAfterMS = 0
	} else if e.RetryAfterMS > MaxLatencyMS {
		e.RetryAfterMS = MaxLatencyMS
	}
	r.candidateExclusions.Add(1)
	r.recordEvidence(RequestEvent{
		RequestID: e.RequestID, Stage: StageCandidateExclusion, Surface: SurfaceHTTP,
		Provider: e.Provider, Model: e.Model, AccountID: e.AccountID,
		CatalogGeneration: e.CatalogGeneration, RouteMember: e.RouteMember,
		ExclusionReason: e.Reason, RetryAfterMS: e.RetryAfterMS,
	})
}

func (r *Registry) ObserveRepair(e RepairEvidence) {
	if r == nil {
		return
	}
	e.RequestID = redactedEvidenceID(e.RequestID, MaxIdentifierLen)
	e.Provider = redactedEvidenceID(e.Provider, MaxIdentifierLen)
	e.Rule = boundedEvidenceTag(e.Rule, MaxErrorCodeLen)
	r.repairs.Add(1)
	r.recordEvidence(RequestEvent{
		RequestID: e.RequestID, Stage: StageRepair, Surface: SurfaceHTTP,
		Provider: e.Provider, Attempt: e.Attempt, CatalogGeneration: e.CatalogGeneration,
		RouteMember: e.RouteMember, RepairRule: e.Rule,
		RepairChanged: e.Changed, RepairApplied: e.Applied,
	})
}

func (r *Registry) ObserveStreamFinalization(e StreamFinalizationEvidence) {
	if r == nil {
		return
	}
	e.RequestID = redactedEvidenceID(e.RequestID, MaxIdentifierLen)
	e.Provider = redactedEvidenceID(e.Provider, MaxIdentifierLen)
	e.Model = redactedEvidenceID(e.Model, MaxIdentifierLen)
	e.AccountID = redactedEvidenceID(e.AccountID, MaxIdentifierLen)
	e.ProxyID = redactedEvidenceID(e.ProxyID, MaxIdentifierLen)
	e.NetworkMode = boundedEvidenceTag(e.NetworkMode, MaxRateTagLen)
	e.Code = boundedEvidenceTag(e.Code, MaxErrorCodeLen)
	e.Usage = boundedTokenUsage(e.Usage)
	if e.DurationMS < 0 || e.DurationMS > MaxLatencyMS {
		e.DurationMS = 0
	}
	r.observeStreamDuration(e.DurationMS)
	if e.Outcome == StreamTruncated {
		r.truncations.Add(1)
	}
	if e.Outcome != StreamClean {
		if e.Committed {
			r.postCommitFailures.Add(1)
		} else {
			r.preCommitFailures.Add(1)
		}
	}
	r.streamFinalizations.Add(1)
	r.recordEvidence(RequestEvent{
		RequestID: e.RequestID, Stage: StageStreamFinalization, Surface: evidenceSurface(e.Surface),
		Provider: e.Provider, Model: e.Model, AccountID: e.AccountID, ProxyID: e.ProxyID,
		Attempt: e.Attempt, CatalogGeneration: e.CatalogGeneration, RouteMember: e.RouteMember,
		NetworkMode: e.NetworkMode, ErrorCode: e.Code, StreamOutcome: e.Outcome,
		Committed: e.Committed, LatencyMS: e.DurationMS, StartedAt: e.StartedAt,
		EndedAt: e.EndedAt, Usage: e.Usage,
	})
}

func (r *Registry) ObserveRequestAttempts(attempts int) {
	if r != nil {
		r.observeAttempts(attempts)
	}
}

func (r *Registry) recordEvidence(event RequestEvent) {
	if r == nil {
		return
	}
	// RecordEvent owns validation, bounded series accounting, and queue
	// dispatch. Keeping one path prevents evidence from reaching a sink while
	// silently missing the metrics endpoint.
	_ = r.RecordEvent(context.Background(), event)
}

// ObserveAdmissionWait records the admission delay without request or key
// labels, keeping the histogram cardinality constant.
func (r *Registry) ObserveAdmissionWait(wait time.Duration) {
	if r != nil {
		r.observeAdmissionWait(wait.Milliseconds())
	}
}

func (r *Registry) ObserveAccountCooldown() {
	if r != nil {
		r.accountCooldowns.Add(1)
	}
}

func (r *Registry) ObserveProxyQuarantine() {
	if r != nil {
		r.proxyQuarantines.Add(1)
	}
}

func (r *Registry) ObserveSideEffectFailure() {
	if r != nil {
		r.sideEffectFailures.Add(1)
	}
}

func appendUsageFields(fields []Field, usage TokenUsage) []Field {
	if usage.Known&UsageInput != 0 {
		fields = append(fields, Int64("input_tokens", usage.Input))
	}
	if usage.Known&UsageOutput != 0 {
		fields = append(fields, Int64("output_tokens", usage.Output))
	}
	if usage.Known&UsageCachedRead != 0 {
		fields = append(fields, Int64("cached_read_tokens", usage.CachedRead))
	}
	if usage.Known&UsageCachedWrite != 0 {
		fields = append(fields, Int64("cached_write_tokens", usage.CachedWrite))
	}
	if usage.Known&UsageReasoning != 0 {
		fields = append(fields, Int64("reasoning_tokens", usage.Reasoning))
	}
	if usage.Known&UsageTotal != 0 {
		fields = append(fields, Int64("total_tokens", usage.Total))
	}
	return fields
}
