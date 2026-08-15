package observability

import "strings"

// Compatibility plan and cache evidence is deliberately code-only. These
// records are safe to emit from request paths because they have no body,
// credential, digest, account, or correlation fields.
type CompatibilityPlanEvidence struct {
	RequestID         string // accepted for call-site convenience; never retained
	SourceSurface     string
	TargetSurface     string
	Profile           string
	Action            string
	Outcome           string
	Code              string
	Operation         string
	CompactionVersion string
	Bridge            string
}

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

type CacheEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Kind      CacheKind
	Layer     string
	Operation CacheOperation
	Outcome   string
	Code      string
}

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

type RecoveryEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Kind      string
	Code      string
}

type ExhaustionEvidence struct {
	RequestID string // accepted for call-site convenience; never retained
	Reason    string
	Code      string
}

type OperationEvidence struct {
	RequestID         string // accepted for call-site convenience; never retained
	Operation         string
	CompactionVersion string
	Bridge            string
	Outcome           string
	Code              string
}

type ToolRepairEvidence struct {
	RequestID   string // accepted for call-site convenience; never retained
	Disposition string
	Code        string
}

type CapabilityEvidence struct {
	RequestID     string // accepted for call-site convenience; never retained
	Code          string
	Operation     string
	Feature       string
	Modality      string
	ReferenceKind string
}

const (
	PlanActionPreserve         = "preserve"
	PlanActionTranslate        = "translate"
	PlanActionClamp            = "clamp"
	PlanActionStripNonSemantic = "strip-nonsemantic"
	PlanActionReject           = "reject"
	PlanActionPassthrough      = "passthrough-native"
)

const (
	PlanOutcomePlanned  = "planned"
	PlanOutcomeRejected = "rejected"
	PlanOutcomeFallback = "fallback"
)

const (
	RecoveryHidden    = "hidden_recovery"
	RecoveryAvoidable = "avoidable_error"
)

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

const (
	ToolRepairApplied  = "applied"
	ToolRepairRejected = "rejected"
	ToolRepairSkipped  = "skipped"
)

// Cache kinds are intentionally separate even when they share a backend. This
// prevents plan, token-saver, response, resolution, and provider evidence from
// collapsing into one misleading series.
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

var compatibilitySurfaces = map[string]struct{}{
	"openai-chat": {}, "openai-responses": {}, "anthropic-messages": {},
	"gemini-generate-content": {}, "images": {}, "web-search": {},
	"http": {}, "stream": {}, "unknown": {}, "other": {},
}
var compatibilityProfiles = map[string]struct{}{
	"unknown-standard": {}, "claude-code": {}, "codex-cli": {},
	"gemini-cli": {}, "openai-compatible-cli": {}, "other": {},
}
var planActions = map[string]struct{}{
	PlanActionPreserve: {}, PlanActionTranslate: {}, PlanActionClamp: {},
	PlanActionStripNonSemantic: {}, PlanActionReject: {}, PlanActionPassthrough: {}, "other": {},
}
var planOutcomes = map[string]struct{}{PlanOutcomePlanned: {}, PlanOutcomeRejected: {}, PlanOutcomeFallback: {}, "other": {}}
var operations = map[string]struct{}{"generate": {}, "compact": {}, "compaction": {}, "unknown": {}, "other": {}}
var operationOutcomes = map[string]struct{}{"planned": {}, "success": {}, "failure": {}, "rejected": {}, "bridged": {}, "unsupported": {}, "unknown": {}}
var evidenceOutcomes = map[string]struct{}{"planned": {}, "success": {}, "failure": {}, "rejected": {}, "fallback": {}, "bridged": {}, "unsupported": {}, "unknown": {}, "other": {}}
var compactionVersions = map[string]struct{}{"v1": {}, "v2": {}, "none": {}, "unknown": {}, "other": {}}
var bridgeOutcomes = map[string]struct{}{"none": {}, "v1-to-v2": {}, "v2-to-v1": {}, "supported": {}, "unsupported": {}, "unknown": {}, "other": {}}
var cacheOutcomes = map[string]struct{}{"hit": {}, "miss": {}, "stored": {}, "rejected": {}, "fallback": {}, "disabled": {}, "error": {}, "unknown": {}}
var recoveryKinds = map[string]struct{}{RecoveryHidden: {}, RecoveryAvoidable: {}}
var exhaustionReasons = map[string]struct{}{
	ExhaustionCandidate: {}, ExhaustionDeadline: {}, ExhaustionCost: {}, ExhaustionHardAttempt: {},
	ExhaustionTranslation: {}, ExhaustionCredential: {}, ExhaustionQuota: {}, ExhaustionNetwork: {},
}
var exclusionReasons = map[string]struct{}{
	"disabled": {}, "exhausted": {}, "cooling": {}, "model_locked": {},
	"already_attempted": {}, "unavailable": {}, "proxy_unavailable": {}, "quota_exhausted": {},
	"candidate": {}, "deadline": {}, "cost": {}, "hard_attempt": {}, "translation": {},
	"credential": {}, "quota": {}, "network": {},
}
var toolRepairDispositions = map[string]struct{}{ToolRepairApplied: {}, ToolRepairRejected: {}, ToolRepairSkipped: {}}
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

func (r *Registry) ObserveCompatibilityPlan(e CompatibilityPlanEvidence) {
	if r == nil {
		return
	}
	r.recordEvidence(RequestEvent{Stage: StageCompatibilityPlan, Surface: SurfaceHTTP,
		SourceSurface:     validDimension(e.SourceSurface, compatibilitySurfaces),
		TargetSurface:     validDimension(e.TargetSurface, compatibilitySurfaces),
		Profile:           validDimension(e.Profile, compatibilityProfiles),
		DispositionAction: validDimension(e.Action, planActions),
		PlanOutcome:       validDimension(e.Outcome, planOutcomes), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen),
		Operation: validDimension(e.Operation, operations), CompactionVersion: validDimension(e.CompactionVersion, compactionVersions),
		Bridge: validDimension(e.Bridge, bridgeOutcomes)})
}

func (r *Registry) ObserveCache(e CacheEvidence) {
	if r == nil || e.Kind == CacheKindUnspecified || !e.Operation.IsValid() || !validCacheKind(e.Kind) {
		return
	}
	outcome := validDimension(e.Outcome, cacheOutcomes)
	r.recordEvidence(RequestEvent{Stage: StageCacheLookup, Surface: SurfaceHTTP, CacheKind: e.Kind,
		CacheOperation: string(e.Operation), CacheOutcome: outcome, CacheLayer: validDimension(e.Layer, map[string]struct{}{"l0": {}, "l1": {}, "memory": {}, "redis": {}, "provider": {}, "none": {}}),
		ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
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

// ObserveCacheLookup is an explicit alias for callers that want the event name
// to mirror the cache boundary; it has identical bounded semantics.
func (r *Registry) ObserveCacheLookup(e CacheEvidence) { r.ObserveCache(e) }

func (r *Registry) ObserveCompatibilityPlanOutcome(e CompatibilityPlanEvidence) {
	r.ObserveCompatibilityPlan(e)
}
func (r *Registry) ObservePlanCache(e CacheEvidence)       { r.ObserveCache(e) }
func (r *Registry) ObserveTokenSaverCache(e CacheEvidence) { r.ObserveCache(e) }
func (r *Registry) ObserveResponseCache(e CacheEvidence)   { r.ObserveCache(e) }

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

func (r *Registry) ObserveProviderPromptCache(e ProviderCacheEvidence) { r.ObserveProviderCache(e) }

func (r *Registry) ObserveRecovery(e RecoveryEvidence) {
	if r == nil {
		return
	}
	kind := validDimension(e.Kind, recoveryKinds)
	if kind == RecoveryHidden {
		r.hiddenRecoveries.Add(1)
	}
	if kind == RecoveryAvoidable {
		r.avoidableErrors.Add(1)
	}
	r.recordEvidence(RequestEvent{Stage: StageRecovery, Surface: SurfaceHTTP, RecoveryKind: kind, ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveExhaustion(e ExhaustionEvidence) {
	if r == nil {
		return
	}
	r.typedExhaustions.Add(1)
	r.recordEvidence(RequestEvent{Stage: StageExhaustion, Surface: SurfaceHTTP, ExhaustionReason: validDimension(e.Reason, exhaustionReasons), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveExhaustionReason(reason, code string) {
	r.ObserveExhaustion(ExhaustionEvidence{Reason: reason, Code: code})
}

func (r *Registry) ObserveOperation(e OperationEvidence) {
	if r == nil {
		return
	}
	r.recordEvidence(RequestEvent{Stage: StageOperation, Surface: SurfaceHTTP, Operation: validDimension(e.Operation, operations), CompactionVersion: validDimension(e.CompactionVersion, compactionVersions), Bridge: validDimension(e.Bridge, bridgeOutcomes), PlanOutcome: validDimension(e.Outcome, operationOutcomes), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveToolRepair(e ToolRepairEvidence) {
	if r == nil {
		return
	}
	r.recordEvidence(RequestEvent{Stage: StageRepair, Surface: SurfaceHTTP, RepairRule: "tool_repair", RepairDisposition: validDimension(e.Disposition, toolRepairDispositions), ErrorCode: boundedEvidenceTag(e.Code, MaxErrorCodeLen)})
}

func (r *Registry) ObserveToolRepairDisposition(disposition, code string) {
	r.ObserveToolRepair(ToolRepairEvidence{Disposition: disposition, Code: code})
}

func (r *Registry) ObserveCapability(e CapabilityEvidence) {
	if r == nil {
		return
	}
	code := validDimension(e.Code, capabilityCodes)
	r.recordEvidence(RequestEvent{Stage: StageCapability, Surface: SurfaceHTTP, CapabilityCode: code, Operation: validDimension(e.Operation, operations), Modality: validDimension(e.Modality, modalities), ReferenceKind: validDimension(e.ReferenceKind, referenceKinds)})
}

func (r *Registry) ObserveMediaCapabilityRejection(code, modality, reference string) {
	r.ObserveCapability(CapabilityEvidence{Code: code, Modality: modality, ReferenceKind: reference})
}

// Stable aliases used by integration call-sites.
func (r *Registry) ObserveHiddenRecovery(code string) {
	r.ObserveRecovery(RecoveryEvidence{Kind: RecoveryHidden, Code: code})
}
func (r *Registry) ObserveAvoidableError(code string) {
	r.ObserveRecovery(RecoveryEvidence{Kind: RecoveryAvoidable, Code: code})
}
func (r *Registry) ObserveTypedExhaustion(reason, code string) {
	r.ObserveExhaustion(ExhaustionEvidence{Reason: reason, Code: code})
}
func (r *Registry) ObserveCapabilityRejection(code, operation, modality, reference string) {
	r.ObserveCapability(CapabilityEvidence{Code: code, Operation: operation, Modality: modality, ReferenceKind: reference})
}
