package observability

import "strings"

// Cache operation classification. Kept here because ObserveAttempt emits
// provider-prompt-cache evidence into StageCacheLookup events.
type CacheOperation string

const (
	CacheLookup   CacheOperation = "lookup"
	CacheHit      CacheOperation = "hit"
	CacheWrite    CacheOperation = "write"
	CacheReject   CacheOperation = "reject"
	CacheFallback CacheOperation = "fallback"
)

func (o CacheOperation) IsValid() bool {
	switch o {
	case CacheLookup, CacheHit, CacheWrite, CacheReject, CacheFallback:
		return true
	default:
		return false
	}
}

// CacheEvidence is the bounded record for one local-cache lookup. The
// response / token-saver paths share this shape because they all describe
// the same CacheLookup Stage.
type CacheEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Kind      CacheKind
	Layer     string
	Operation CacheOperation
	Outcome   string
	Code      string
}

// ProviderCacheEvidence is the bounded record for one provider-side prompt
// cache event. Only ObserveAttempt emits this.
type ProviderCacheEvidence struct {
	RequestID      string // accepted for call-site convenience; never retained
	Operation      CacheOperation
	Outcome        string
	Code           string
	ReadTokens     int64
	WriteTokens    int64
	EligiblePrefix int64
	HitPrefix      int64
}

// ExhaustionEvidence records one typed exhaustion event. It is consumed via
// ObserveTypedExhaustion from the dispatch path.
type ExhaustionEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Reason    string
	Code      string
}

// OperationEvidence records one operation outcome (generate / compact / bridge).
type OperationEvidence struct {
	RequestID         string // accepted for call-site convenience; never retained
	Operation         string
	CompactionVersion string
	Bridge            string
	Outcome           string
	Code              string
}

// CapabilityEvidence records one capability rejection. The Feature field is
// optional and accepted for call-site convenience.
type CapabilityEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Code      string
	Operation string
	Feature   string
	Modality  string
	ReferenceKind string
}

const (
	ExhaustionCandidate   = "candidate"
	ExhaustionDeadline    = "deadline"
	ExhaustionCost        = "cost"
	ExhaustionHardAttempt = "hard_attempt"
	ExhaustionTranslation = "translation"
	ExhaustionCredential  = "credential"
	ExhaustionQuota       = "quota"
	ExhaustionNetwork     = "network"
)

// Retained for events.go validation of RequestEvent.RecoveryKind. The only
// emitter (ObserveRecovery) is gone, but the field is still accepted and the
// validation contract is preserved.
const (
	RecoveryHidden    = "hidden_recovery"
	RecoveryAvoidable = "avoidable_error"
)

// Retained for events.go validation of RequestEvent.RepairDisposition. The only
// emitter (ObserveToolRepair) is gone, but the field is still accepted and the
// validation contract is preserved.
const (
	ToolRepairApplied  = "applied"
	ToolRepairRejected = "rejected"
	ToolRepairSkipped  = "skipped"
)

const (
	CacheKindPlanL0 CacheKind = iota + 4
	CacheKindPlanL1
	CacheKindTokenSaverL0
	CacheKindTokenSaverRedis
	CacheKindResponseL0
	CacheKindResponseRedis
)

func validDimension(value string, allowed map[string]struct{}) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	if _, ok := allowed[value]; ok {
		return value
	}
	return "other"
}

func dimensionAllowed(value string, allowed map[string]struct{}) bool {
	if strings.TrimSpace(value) == "" {
		return true
	}
	_, ok := allowed[strings.ToLower(strings.TrimSpace(value))]
	return ok
}

func validCacheKind(kind CacheKind) bool {
	switch kind {
	case CacheKindResolutionMemory, CacheKindResolutionRedis, CacheKindProviderPrompt,
		CacheKindPlanL0, CacheKindPlanL1, CacheKindTokenSaverL0, CacheKindTokenSaverRedis,
		CacheKindResponseL0, CacheKindResponseRedis:
		return true
	default:
		return false
	}
}

// Dimension maps retained because events.go validates RequestEvent fields
// against them. Keep narrow: only the keys actually emitted today.
var operations = map[string]struct{}{"generate": {}, "compact": {}, "compaction": {}, "unknown": {}, "other": {}}
var operationOutcomes = map[string]struct{}{"planned": {}, "success": {}, "failure": {}, "rejected": {}, "bridged": {}, "unsupported": {}, "unknown": {}}
var compactionVersions = map[string]struct{}{"v1": {}, "v2": {}, "none": {}, "unknown": {}, "other": {}}
var bridgeOutcomes = map[string]struct{}{"none": {}, "v1-to-v2": {}, "v2-to-v1": {}, "supported": {}, "unsupported": {}, "unknown": {}, "other": {}}
var cacheOutcomes = map[string]struct{}{"hit": {}, "miss": {}, "stored": {}, "rejected": {}, "fallback": {}, "disabled": {}, "error": {}, "unknown": {}}
// recoveryKinds and toolRepairDispositions are kept because events.go still
// validates RequestEvent.RecoveryKind and RequestEvent.RepairDisposition against
// them. No external code emits those fields any more, but the contract is
// preserved.
var recoveryKinds = map[string]struct{}{RecoveryHidden: {}, RecoveryAvoidable: {}}
var exhaustionReasons = map[string]struct{}{
	ExhaustionCandidate: {}, ExhaustionDeadline: {}, ExhaustionCost: {}, ExhaustionHardAttempt: {},
	ExhaustionTranslation: {}, ExhaustionCredential: {}, ExhaustionQuota: {}, ExhaustionNetwork: {},
}
var toolRepairDispositions = map[string]struct{}{ToolRepairApplied: {}, ToolRepairRejected: {}, ToolRepairSkipped: {}}
var exclusionReasons = map[string]struct{}{
	"disabled": {}, "exhausted": {}, "cooling": {}, "model_locked": {},
	"already_attempted": {}, "unavailable": {}, "proxy_unavailable": {}, "quota_exhausted": {},
	"candidate": {}, "deadline": {}, "cost": {}, "hard_attempt": {}, "translation": {},
	"credential": {}, "quota": {}, "network": {},
}
var capabilityCodes = map[string]struct{}{
	"capability.tool_kind_unsupported": {}, "capability.media_reference_unsupported": {},
	"capability.document_unsupported": {}, "capability.remote_compaction_v1_unsupported": {},
	"capability.remote_compaction_v2_unsupported": {}, "capability.remote_compaction_bridge_unsupported": {},
	"capability.reference_kind_unsupported": {}, "capability.mimetype_unsupported": {},
	"capability.context_management_unsupported": {}, "capability.unsupported": {},
	"capability.source_surface_unsupported": {}, "capability.compaction_unsupported": {},
	"capability.tool_unsupported": {}, "capability.reference_unsupported": {},
	"capability.feature_unsupported": {}, "capability.no_compatible_route": {},
}
var modalities = map[string]struct{}{"image": {}, "audio": {}, "file": {}, "document": {}, "pdf": {}, "text": {}, "unknown": {}}
var referenceKinds = map[string]struct{}{"url": {}, "inline-data": {}, "provider-file-id": {}, "provider-file-url": {}, "unknown": {}}

func (r *Registry) ObserveCache(e CacheEvidence) {
	if r == nil || e.Kind == CacheKindUnspecified || !e.Operation.IsValid() || !validCacheKind(e.Kind) {
		return
	}
	outcome := validDimension(e.Outcome, cacheOutcomes)
	r.recordEvidence(RequestEvent{Stage: StageCacheLookup, Surface: SurfaceHTTP, CacheKind: e.Kind,
		CacheOperation: string(e.Operation), CacheOutcome: outcome, CacheLayer: validDimension(e.Layer, map[string]struct{}{"l0": {}, "l1": {}, "memory": {}, "redis": {}, "provider": {}, "none": {}}),
		ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveProviderCache(e ProviderCacheEvidence) {
	if r == nil || !e.Operation.IsValid() {
		return
	}
	if e.ReadTokens < 0 || e.ReadTokens > 1<<50 {
		e.ReadTokens = 0
	}
	if e.WriteTokens < 0 || e.WriteTokens > 1<<50 {
		e.WriteTokens = 0
	}
	if e.EligiblePrefix < 0 || e.EligiblePrefix > 1<<50 {
		e.EligiblePrefix = 0
	}
	if e.HitPrefix < 0 || e.HitPrefix > e.EligiblePrefix {
		e.HitPrefix = 0
	}
	r.providerCacheReadTokens.Add(uint64(e.ReadTokens))
	r.providerCacheWriteTokens.Add(uint64(e.WriteTokens))
	r.providerCacheEligiblePrefix.Add(uint64(e.EligiblePrefix))
	r.providerCacheHitPrefix.Add(uint64(e.HitPrefix))
	r.recordEvidence(RequestEvent{Stage: StageCacheLookup, Surface: SurfaceHTTP, CacheKind: CacheKindProviderPrompt,
		CacheOperation: string(e.Operation), CacheOutcome: validDimension(e.Outcome, cacheOutcomes), CacheLayer: "provider",
		ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen),
		Usage:     TokenUsage{Known: UsageCachedRead | UsageCachedWrite, CachedRead: e.ReadTokens, CachedWrite: e.WriteTokens}})
}

func (r *Registry) ObserveExhaustion(e ExhaustionEvidence) {
	if r == nil {
		return
	}
	r.typedExhaustions.Add(1)
	r.recordEvidence(RequestEvent{Stage: StageExhaustion, Surface: SurfaceHTTP, ExhaustionReason: validDimension(e.Reason, exhaustionReasons), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveTypedExhaustion(reason, code string) {
	r.ObserveExhaustion(ExhaustionEvidence{Reason: reason, Code: code})
}

func (r *Registry) ObserveOperation(e OperationEvidence) {
	if r == nil {
		return
	}
	r.recordEvidence(RequestEvent{Stage: StageOperation, Surface: SurfaceHTTP, Operation: validDimension(e.Operation, operations), CompactionVersion: validDimension(e.CompactionVersion, compactionVersions), Bridge: validDimension(e.Bridge, bridgeOutcomes), PlanOutcome: validDimension(e.Outcome, operationOutcomes), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveCapability(e CapabilityEvidence) {
	if r == nil {
		return
	}
	code := validDimension(e.Code, capabilityCodes)
	r.recordEvidence(RequestEvent{Stage: StageCapability, Surface: SurfaceHTTP, CapabilityCode: code, Operation: validDimension(e.Operation, operations), Modality: validDimension(e.Modality, modalities), ReferenceKind: validDimension(e.ReferenceKind, referenceKinds)})
}
