package protocol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	MaxPlanFeatures     = 64
	MaxPlanDispositions = 128
	MaxPlanPathBytes    = 256
	MaxPlanRuleIDBytes  = 96
	MaxPlanAlternatives = 8
	MaxPlanPayloadBytes = 64 * 1024
	DefaultPlanCacheTTL = 60
	maxLocalCompiledPlans = 256
)

// ProcessingMode identifies the amount of protocol work required for one
// request. A decision is content-free and can therefore be shared by all
// attempts for a route.
type ProcessingMode uint8

const (
	ModePass ProcessingMode = iota
	ModePatch
	ModeTranslate
	ModeReject
)

func (m ProcessingMode) IsValid() bool {
	return m <= ModeReject
}

func (m ProcessingMode) String() string {
	switch m {
	case ModePass:
		return "PASS"
	case ModePatch:
		return "PATCH"
	case ModeTranslate:
		return "TRANSLATE"
	case ModeReject:
		return "REJECT"
	default:
		return "UNKNOWN"
	}
}

// RepairSet is a bounded, deterministic set of provider/request repair rule
// identifiers. The planner copies and sorts it before putting it in a
// CompatibilityDecision; callers must treat values as immutable after
// planning.
type RepairSet []string

func NewRepairSet(values ...string) (RepairSet, error) {
	seen := make(map[string]struct{}, len(values))
	out := make(RepairSet, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	if err := out.Validate(); err != nil {
		return nil, err
	}
	return out, nil
}

func (r RepairSet) Validate() error {
	if len(r) > MaxPlanFeatures {
		return planError(CodePlanBounds, "repairs", "repair count exceeds bound", nil)
	}
	seen := make(map[string]struct{}, len(r))
	for _, value := range r {
		if value == "" || len(value) > MaxPlanRuleIDBytes {
			return planError(CodeInvalidPlan, "repairs", "repair identifier is invalid", nil)
		}
		if _, ok := seen[value]; ok {
			return planError(CodeInvalidPlan, "repairs", "duplicate repair identifier", nil)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func (r RepairSet) Values() []string {
	return append([]string(nil), r...)
}

func (r RepairSet) Empty() bool { return len(r) == 0 }

// Feature is a stable, content-free semantic feature name. Values intentionally
// match the compatibility corpus vocabulary, but this package does not import
// the corpus package (which depends on compatibility for profile types).
type Feature string

const (
	FeatureText               Feature = "text"
	FeatureMultipleSystem     Feature = "multiple-system"
	FeatureTools              Feature = "tools"
	FeatureFunctionTool       Feature = "function-tool"
	FeatureCustomTool         Feature = "custom-tool"
	FeatureComputerTool       Feature = "computer-tool"
	FeatureHostedTool         Feature = "hosted-tool"
	FeatureToolCall           Feature = "tool-call"
	FeatureToolResult         Feature = "tool-result"
	FeatureParallelTools      Feature = "parallel-tools"
	FeatureReasoning          Feature = "reasoning"
	FeatureEncryptedReasoning Feature = "encrypted-reasoning"
	FeatureStructuredOutput   Feature = "structured-output"
	FeatureImage              Feature = "image"
	FeatureAudio              Feature = "audio"
	FeatureFile               Feature = "file"
	FeaturePDF                Feature = "pdf"
	FeatureCitation           Feature = "citation"
	FeatureUsage              Feature = "usage"
	FeatureStreaming          Feature = "streaming"
	FeatureRemoteCompactionV1 Feature = "remote-compaction-v1"
	FeatureRemoteCompactionV2 Feature = "remote-compaction-v2"
	FeatureContextManagement  Feature = "context-management"
	FeatureContinuation       Feature = "continuation"
	FeatureUnknownFields      Feature = "unknown-fields"
)

var knownPlanFeatures = map[Feature]struct{}{
	FeatureText: {}, FeatureMultipleSystem: {}, FeatureTools: {}, FeatureFunctionTool: {},
	FeatureCustomTool: {}, FeatureComputerTool: {}, FeatureHostedTool: {}, FeatureToolCall: {},
	FeatureToolResult: {}, FeatureParallelTools: {}, FeatureReasoning: {}, FeatureEncryptedReasoning: {},
	FeatureStructuredOutput: {}, FeatureImage: {}, FeatureAudio: {}, FeatureFile: {}, FeaturePDF: {},
	FeatureCitation: {}, FeatureUsage: {}, FeatureStreaming: {}, FeatureRemoteCompactionV1: {},
	FeatureRemoteCompactionV2: {}, FeatureContextManagement: {}, FeatureContinuation: {}, FeatureUnknownFields: {},
}

// DispositionAction is the only action a known source feature may receive.
type DispositionAction string

const (
	Preserve          DispositionAction = "preserve"
	Translate         DispositionAction = "translate"
	Clamp             DispositionAction = "clamp"
	StripNonSemantic  DispositionAction = "strip-nonsemantic"
	Reject            DispositionAction = "reject"
	PassthroughNative DispositionAction = "passthrough-native"

	// Compatibility aliases make the action names read naturally at call sites.
	DispositionPreserve          = Preserve
	DispositionTranslate         = Translate
	DispositionClamp             = Clamp
	DispositionStripNonSemantic  = StripNonSemantic
	DispositionReject            = Reject
	DispositionPassthroughNative = PassthroughNative
)

// FeatureRequirement carries only bounded paths and semantic metadata; it must
// never contain request values or prompt content.
type FeatureRequirement struct {
	Feature      Feature
	SourcePath   string
	TargetPath   string
	Semantic     bool
	NumericValue int64
	HasNumeric   bool
}

// FeatureSet is immutable after planning. Features is retained for callers that
// only need flags; Requirements provide paths and verified numeric bounds.
type FeatureSet struct {
	Features     []Feature
	Requirements []FeatureRequirement
}

func (s FeatureSet) normalized() ([]FeatureRequirement, error) {
	if len(s.Features)+len(s.Requirements) > MaxPlanFeatures {
		return nil, planError(CodePlanBounds, "features", "feature count exceeds bound", nil)
	}
	out := make([]FeatureRequirement, 0, len(s.Features)+len(s.Requirements))
	seen := make(map[Feature]struct{}, len(s.Features)+len(s.Requirements))
	for _, f := range s.Features {
		if _, ok := knownPlanFeatures[f]; !ok {
			return nil, planError(CodeUnknownFeature, string(f), "unknown feature", nil)
		}
		if _, ok := seen[f]; !ok {
			seen[f] = struct{}{}
			out = append(out, FeatureRequirement{Feature: f, Semantic: true})
		}
	}
	for _, requirement := range s.Requirements {
		if _, ok := knownPlanFeatures[requirement.Feature]; !ok {
			return nil, planError(CodeUnknownFeature, string(requirement.Feature), "unknown feature", nil)
		}
		if len(requirement.SourcePath) > MaxPlanPathBytes || len(requirement.TargetPath) > MaxPlanPathBytes {
			return nil, planError(CodePlanBounds, "feature.path", "path exceeds bound", nil)
		}
		if _, ok := seen[requirement.Feature]; ok {
			for i := range out {
				if out[i].Feature == requirement.Feature {
					if out[i].SourcePath == "" {
						out[i].SourcePath = requirement.SourcePath
					}
					if out[i].TargetPath == "" {
						out[i].TargetPath = requirement.TargetPath
					}
					if requirement.HasNumeric {
						out[i].NumericValue, out[i].HasNumeric = requirement.NumericValue, true
					}
					out[i].Semantic = out[i].Semantic || requirement.Semantic
				}
			}
			continue
		}
		seen[requirement.Feature] = struct{}{}
		out = append(out, requirement)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Feature < out[j].Feature })
	return out, nil
}

// FeaturePolicy describes one immutable provider/model capability rule.
type FeaturePolicy struct {
	Supported        bool
	Translatable     bool
	StripNonSemantic bool
	Clamp            bool
	RuleID           string
	Max              int64
	Alternatives     []string
}

// TargetPolicy is the planner-facing, provider-owned policy snapshot. Provider
// catalog code can map its richer policy into this bounded view.
type TargetPolicy struct {
	ID         string
	Generation uint64
	// CapabilityVersion changes whenever provider capability rules affecting
	// wire behavior change independently of the catalog generation.
	CapabilityVersion uint64
	Features   map[Feature]FeaturePolicy
	Surfaces   []Surface

	NativePassthrough      bool
	BytePreservation       bool
	SupportsStreaming      bool
	LossyEligible          bool
	ContentStorageEligible bool
	ResponseCacheEligible  bool
	HedgeEligible          bool
	PromptCacheEligible    bool
	MaxOutputTokens        int64
	Rules                  []string
}

func (p TargetPolicy) Validate() error {
	if p.ID == "" {
		return planError(CodeInvalidPolicy, "policy.id", "policy id is required", nil)
	}
	if p.Generation == 0 {
		return planError(CodeInvalidPolicy, "policy.generation", "policy generation is required", nil)
	}
	if len(p.Rules) > MaxPlanFeatures {
		return planError(CodePlanBounds, "policy.rules", "rule count exceeds bound", nil)
	}
	if len(p.Surfaces) > MaxPlanAlternatives {
		return planError(CodePlanBounds, "policy.surfaces", "surface count exceeds bound", nil)
	}
	for _, surface := range p.Surfaces {
		if !surface.IsValid() {
			return planError(CodeInvalidSurface, "policy.surface", "invalid policy surface", nil)
		}
	}
	for feature, rule := range p.Features {
		if _, ok := knownPlanFeatures[feature]; !ok {
			return planError(CodeUnknownFeature, string(feature), "unknown feature policy", nil)
		}
		if len(rule.RuleID) > MaxPlanRuleIDBytes {
			return planError(CodePlanBounds, "policy.rule_id", "rule id exceeds bound", nil)
		}
		if rule.Max < 0 {
			return planError(CodeInvalidPolicy, string(feature), "negative policy maximum", nil)
		}
	}
	return nil
}

// EncoderKind identifies both source response and target request codecs.
type EncoderKind string

const (
	EncoderOpenAIChat        EncoderKind = "openai-chat"
	EncoderOpenAIResponses   EncoderKind = "openai-responses"
	EncoderAnthropic         EncoderKind = "anthropic-messages"
	EncoderGemini            EncoderKind = "gemini-generate-content"
	EncoderNativePassthrough EncoderKind = "native-passthrough"
)

// ResponsePolicy is content-free and applies to source-surface response
// projection. Loss evidence is represented by a stable code, never a value.
type ResponsePolicy struct {
	SourceEncoder EncoderKind
	TargetEncoder EncoderKind
	LossAllowed   bool
	LossCode      string
	Strict        bool
}

// CompatibilityCachePolicy records cache eligibility computed by the
// compatibility planner. It is distinct from the canonical request-level
// CachePolicy used by domain exchanges.
type CompatibilityCachePolicy struct {
	PromptEligible  bool
	ContentStorage  bool
	ResponseCaching bool
}

type HedgePolicy struct{ Eligible bool }

// FieldDisposition is retained in the plan so every known feature has an
// auditable, bounded action and rule/path. It carries no request values.
type FieldDisposition struct {
	SourcePath string
	TargetPath string
	Feature    Feature
	Action     DispositionAction
	RuleID     string
}

// CompatibilityPlan is content-free and safe to serialize into runtime/cache.
type CompatibilityPlan struct {
	SourceSurface          Surface
	TargetSurface          Surface
	Profile                ClientProfileID
	ProviderID             string
	ModelID                string
	PolicyID               string
	PolicyGeneration       uint64
	Encoder                EncoderKind
	SourceEncoder          EncoderKind
	TargetEncoder          EncoderKind
	SameSurfacePassthrough bool
	BytePreserving         bool
	Dispositions           []FieldDisposition
	Response               ResponsePolicy
	Cache                  CompatibilityCachePolicy
	Hedge                  HedgePolicy
	CapabilityCode         ErrorCode
	Alternatives           []string
	Decision               CompatibilityDecision
}

// Clone returns a defensive copy suitable for retaining in a local compiled
// plan cache. Cached plans are immutable snapshots; callers must not mutate a
// value returned by a cache and then publish it to another request.
func (p CompatibilityPlan) Clone() CompatibilityPlan {
	out := p
	out.Dispositions = append([]FieldDisposition(nil), p.Dispositions...)
	out.Alternatives = append([]string(nil), p.Alternatives...)
	out.Decision.RequiredRepairs = append(RepairSet(nil), p.Decision.RequiredRepairs...)
	out.Decision.Unsupported = cloneFeatureSet(p.Decision.Unsupported)
	out.Decision.Lossy = cloneFeatureSet(p.Decision.Lossy)
	return out
}

func (p CompatibilityPlan) Validate() error {
	if !p.SourceSurface.IsValid() || !p.TargetSurface.IsValid() {
		return planError(CodePlanInvalidSurface, "surface", "invalid source or target surface", nil)
	}
	if p.Profile == "" || p.ProviderID == "" || p.ModelID == "" || p.PolicyID == "" || p.PolicyGeneration == 0 {
		return planError(CodeInvalidPlan, "identity", "plan identity is incomplete", nil)
	}
	if p.SourceEncoder == "" || p.TargetEncoder == "" || p.Encoder == "" {
		return planError(CodeInvalidPlan, "encoder", "encoder selection is incomplete", nil)
	}
	if len(p.Dispositions) > MaxPlanDispositions {
		return planError(CodePlanBounds, "dispositions", "disposition count exceeds bound", nil)
	}
	for _, d := range p.Dispositions {
		if d.SourcePath == "" || len(d.SourcePath) > MaxPlanPathBytes || len(d.TargetPath) > MaxPlanPathBytes || d.Feature == "" || !validDisposition(d.Action) || len(d.RuleID) > MaxPlanRuleIDBytes {
			return planError(CodeInvalidPlan, "disposition", "invalid disposition", nil)
		}
	}
	if len(p.Alternatives) > MaxPlanAlternatives {
		return planError(CodePlanBounds, "alternatives", "alternative count exceeds bound", nil)
	}
	if err := p.Decision.Validate(); err != nil {
		return err
	}
	if p.Decision.SourceSurface != p.SourceSurface || p.Decision.TargetSurface != p.TargetSurface {
		return planError(CodeInvalidPlan, "decision.surface", "decision and plan surfaces differ", nil)
	}
	return nil
}

func validDisposition(a DispositionAction) bool {
	return a == Preserve || a == Translate || a == Clamp || a == StripNonSemantic || a == Reject || a == PassthroughNative
}

// PlanRequest supplies the source facts and target policy at one generation.
type PlanRequest struct {
	Profile                    ClientProfileID
	SourceSurface              Surface
	TargetSurface              Surface
	ProviderID                 string
	ModelID                    string
	Features                   FeatureSet
	Policy                     TargetPolicy
	Tenant                     OptInPolicy
	Generation                 CacheGeneration
	NativePassthroughRequested bool
	BytePreservationRequired   bool
	LossRequested              bool
	ResponseStrict             bool
}

type OptInPolicy struct {
	AllowLossy           bool
	AllowContentStorage  bool
	AllowResponseCaching bool
	AllowHedging         bool
}

// CompatibilityDecision is the immutable, content-free protocol decision
// shared by request preparation, response handling, and all route attempts.
// Its fields describe wire-affecting behavior only; secrets and request
// content never belong here.
type CompatibilityDecision struct {
	Mode              ProcessingMode
	SourceSurface     Surface
	TargetSurface     Surface
	SourceStream      bool
	TargetStream      bool
	ModelPatch        string
	RequiredRepairs   RepairSet
	Unsupported       FeatureSet
	Lossy             FeatureSet
	CatalogGeneration uint64
	CapabilityVersion uint64
}

// NewCompatibilityDecision validates and defensively copies a decision. The
// returned value is safe to retain for the lifetime of a route.
func NewCompatibilityDecision(decision CompatibilityDecision) (CompatibilityDecision, error) {
	repairs, err := NewRepairSet(decision.RequiredRepairs...)
	if err != nil {
		return CompatibilityDecision{}, err
	}
	decision.RequiredRepairs = repairs
	decision.Unsupported = cloneFeatureSet(decision.Unsupported)
	decision.Lossy = cloneFeatureSet(decision.Lossy)
	if err := decision.Validate(); err != nil {
		return CompatibilityDecision{}, err
	}
	return decision, nil
}

func (d CompatibilityDecision) Validate() error {
	if !d.Mode.IsValid() {
		return planError(CodeInvalidPlan, "decision.mode", "unsupported processing mode", nil)
	}
	if !d.SourceSurface.IsValid() || !d.TargetSurface.IsValid() {
		return planError(CodePlanInvalidSurface, "decision.surface", "invalid source or target surface", nil)
	}
	if len(d.ModelPatch) > MaxPlanPathBytes {
		return planError(CodePlanBounds, "decision.model_patch", "model patch exceeds bound", nil)
	}
	if err := d.RequiredRepairs.Validate(); err != nil {
		return err
	}
	if _, err := d.Unsupported.normalized(); err != nil {
		return err
	}
	if _, err := d.Lossy.normalized(); err != nil {
		return err
	}
	if d.CatalogGeneration == 0 || d.CapabilityVersion == 0 {
		return planError(CodeInvalidPlan, "decision.generation", "decision generation is required", nil)
	}
	switch d.Mode {
	case ModePass:
		if d.SourceSurface != d.TargetSurface || d.SourceStream != d.TargetStream ||
			d.ModelPatch != "" || !d.RequiredRepairs.Empty() ||
			len(d.Unsupported.Features) != 0 || len(d.Unsupported.Requirements) != 0 ||
			len(d.Lossy.Features) != 0 || len(d.Lossy.Requirements) != 0 {
			return planError(CodeInvalidPlan, "decision.mode", "PASS cannot contain patch, repair, unsupported, or lossy work", nil)
		}
	case ModePatch:
		if d.SourceSurface != d.TargetSurface || len(d.Unsupported.Features) != 0 || len(d.Unsupported.Requirements) != 0 {
			return planError(CodeInvalidPlan, "decision.mode", "PATCH must be same-surface and supported", nil)
		}
	}
	return nil
}

func (d CompatibilityDecision) CacheKey() CompatibilityCacheKey {
	key, _ := NewCompatibilityCacheKey(d)
	return key
}

func cloneFeatureSet(in FeatureSet) FeatureSet {
	return FeatureSet{
		Features:     append([]Feature(nil), in.Features...),
		Requirements: append([]FeatureRequirement(nil), in.Requirements...),
	}
}

// Stable planner errors are source-surface capability failures, not generic
// upstream failures. Alternatives are bounded identifiers only.
const (
	CodeInvalidPlan                 ErrorCode = "compat.plan_invalid"
	CodePlanInvalidSurface          ErrorCode = "compat.source_surface_invalid"
	CodeInvalidPolicy               ErrorCode = "compat.policy_invalid"
	CodePlanBounds                  ErrorCode = "compat.plan_bounds"
	CodeUnknownFeature              ErrorCode = "compat.unknown_feature"
	CodeCapability                  ErrorCode = "compat.capability_unsupported"
	CodeToolKindUnsupported         ErrorCode = "capability.tool_kind_unsupported"
	CodeMediaUnsupported            ErrorCode = "capability.media_reference_unsupported"
	CodeDocumentUnsupported         ErrorCode = "capability.document_unsupported"
	CodeCompactionV1Unsupported     ErrorCode = "capability.remote_compaction_v1_unsupported"
	CodeCompactionV2Unsupported     ErrorCode = "capability.remote_compaction_v2_unsupported"
	CodeCompactionBridgeUnsupported ErrorCode = "capability.remote_compaction_bridge_unsupported"
	CodeLossOptInRequired           ErrorCode = "compat.loss_opt_in_required"
)

type CapabilityError struct {
	Code          ErrorCode
	SourceSurface Surface
	Feature       Feature
	Path          string
	Alternatives  []string
}

func (e *CapabilityError) Error() string {
	if e == nil {
		return "<nil capability error>"
	}
	return string(e.Code)
}
func (e *CapabilityError) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}
func (e *CapabilityError) Is(target error) bool {
	other, ok := target.(*CapabilityError)
	return ok && e != nil && other != nil && e.Code == other.Code
}

func planError(code ErrorCode, field, reason string, cause error) error {
	return &PlanError{Code: code, Field: field, Reason: reason, Cause: cause}
}

type PlanError struct {
	Code          ErrorCode
	Field, Reason string
	Cause         error
}

func (e *PlanError) Error() string {
	if e == nil {
		return "<nil compatibility plan error>"
	}
	if e.Field == "" {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Field
}
func (e *PlanError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}
func (e *PlanError) Is(target error) bool {
	other, ok := target.(*PlanError)
	return ok && e != nil && other != nil && e.Code == other.Code
}
func (e *PlanError) CodeString() string {
	if e == nil {
		return ""
	}
	return string(e.Code)
}

func Plan(req PlanRequest) (CompatibilityPlan, error) {
	if !req.SourceSurface.IsValid() || !req.TargetSurface.IsValid() {
		return CompatibilityPlan{}, planError(CodePlanInvalidSurface, "surface", "source and target surfaces are required", nil)
	}
	if req.Profile == "" || req.ProviderID == "" || req.ModelID == "" {
		return CompatibilityPlan{}, planError(CodeInvalidPlan, "identity", "profile, provider, and model are required", nil)
	}
	if err := req.Policy.Validate(); err != nil {
		return CompatibilityPlan{}, err
	}
	if !surfaceAllowed(req.Policy.Surfaces, req.TargetSurface) {
		return CompatibilityPlan{}, &CapabilityError{Code: CodeCapability, SourceSurface: req.SourceSurface, Path: string(req.TargetSurface), Alternatives: boundedSurfaceStrings(req.Policy.Surfaces)}
	}
	requirements, err := req.Features.normalized()
	if err != nil {
		return CompatibilityPlan{}, err
	}
	encoder := encoderFor(req.TargetSurface)
	plan := CompatibilityPlan{SourceSurface: req.SourceSurface, TargetSurface: req.TargetSurface, Profile: req.Profile, ProviderID: req.ProviderID, ModelID: req.ModelID, PolicyID: req.Policy.ID, PolicyGeneration: req.Policy.Generation, Encoder: encoder, SourceEncoder: encoderFor(req.SourceSurface), TargetEncoder: encoder, Response: ResponsePolicy{SourceEncoder: encoderFor(req.SourceSurface), TargetEncoder: encoder, Strict: req.ResponseStrict}}
	passthrough := req.SourceSurface == req.TargetSurface && req.NativePassthroughRequested && req.Policy.NativePassthrough && req.Policy.BytePreservation
	if req.BytePreservationRequired && !passthrough {
		return CompatibilityPlan{}, &CapabilityError{Code: CodeCapability, SourceSurface: req.SourceSurface, Path: "native_passthrough", Alternatives: []string{"canonical-encode"}}
	}
	for _, requirement := range requirements {
		fp, ok := req.Policy.Features[requirement.Feature]
		if !ok {
			fp = FeaturePolicy{Supported: requirement.Feature == FeatureText}
		}
		d := FieldDisposition{SourcePath: requirement.SourcePath, TargetPath: requirement.TargetPath, Feature: requirement.Feature}
		if d.SourcePath == "" {
			d.SourcePath = "/features/" + string(requirement.Feature)
		}
		if passthrough {
			d.Action = PassthroughNative
			d.TargetPath = d.SourcePath
			plan.Dispositions = append(plan.Dispositions, d)
			continue
		}
		if requirement.HasNumeric && fp.Max > 0 && requirement.NumericValue > fp.Max {
			if !fp.Clamp || fp.RuleID == "" {
				return CompatibilityPlan{}, capabilityFor(requirement, req.SourceSurface, fp.Alternatives)
			}
			d.Action, d.RuleID = Clamp, fp.RuleID
		} else if fp.Supported {
			d.Action, d.RuleID = Preserve, fp.RuleID
			if req.SourceSurface != req.TargetSurface {
				if !fp.Translatable {
					return CompatibilityPlan{}, capabilityFor(requirement, req.SourceSurface, fp.Alternatives)
				}
				d.Action = Translate
			}
		} else if !requirement.Semantic && fp.StripNonSemantic && fp.RuleID != "" {
			d.Action, d.RuleID = StripNonSemantic, fp.RuleID
		} else {
			return CompatibilityPlan{}, capabilityFor(requirement, req.SourceSurface, fp.Alternatives)
		}
		plan.Dispositions = append(plan.Dispositions, d)
	}
	if req.LossRequested {
		if !req.Tenant.AllowLossy || !req.Policy.LossyEligible {
			return CompatibilityPlan{}, &PlanError{Code: CodeLossOptInRequired, Field: "loss", Reason: "loss requires tenant and provider opt-in"}
		}
		plan.Response.LossAllowed = true
		plan.Response.LossCode = "compat.lossy_projection"
	}
	plan.SameSurfacePassthrough = passthrough
	plan.BytePreserving = passthrough
	plan.Cache = CompatibilityCachePolicy{PromptEligible: req.Policy.PromptCacheEligible, ContentStorage: req.Tenant.AllowContentStorage && req.Policy.ContentStorageEligible, ResponseCaching: req.Tenant.AllowResponseCaching && req.Policy.ResponseCacheEligible}
	plan.Hedge = HedgePolicy{Eligible: req.Tenant.AllowHedging && req.Policy.HedgeEligible}
	if req.FeaturesHas(FeatureStreaming) && !req.Policy.SupportsStreaming {
		return CompatibilityPlan{}, capabilityFor(FeatureRequirement{Feature: FeatureStreaming}, req.SourceSurface, nil)
	}
	mode := ModePass
	repairs := RepairSet(nil)
	for _, disposition := range plan.Dispositions {
		switch disposition.Action {
		case Translate:
			mode = ModeTranslate
		case Clamp, StripNonSemantic:
			if mode == ModePass {
				mode = ModePatch
			}
			if disposition.RuleID != "" {
				repairs = append(repairs, disposition.RuleID)
			}
		}
	}
	if req.SourceSurface != req.TargetSurface || plan.Response.LossAllowed {
		mode = ModeTranslate
	}
	capabilityVersion := req.Policy.CapabilityVersion
	if capabilityVersion == 0 {
		capabilityVersion = req.Policy.Generation
	}
	catalogGeneration := req.Generation.Catalog
	if catalogGeneration == 0 {
		catalogGeneration = req.Policy.Generation
	}
	lossy := FeatureSet{}
	if plan.Response.LossAllowed {
		lossy = cloneFeatureSet(req.Features)
	}
	decision, err := NewCompatibilityDecision(CompatibilityDecision{
		Mode:              mode,
		SourceSurface:     req.SourceSurface,
		TargetSurface:     req.TargetSurface,
		SourceStream:      req.FeaturesHas(FeatureStreaming),
		TargetStream:      req.FeaturesHas(FeatureStreaming),
		RequiredRepairs:   repairs,
		Lossy:             lossy,
		CatalogGeneration: catalogGeneration,
		CapabilityVersion: capabilityVersion,
	})
	if err != nil {
		return CompatibilityPlan{}, err
	}
	plan.Decision = decision
	if err := plan.Validate(); err != nil {
		return CompatibilityPlan{}, err
	}
	return plan, nil
}

func (r PlanRequest) FeaturesHas(f Feature) bool {
	for _, x := range r.Features.Features {
		if x == f {
			return true
		}
	}
	for _, x := range r.Features.Requirements {
		if x.Feature == f {
			return true
		}
	}
	return false
}
func capabilityFor(r FeatureRequirement, source Surface, alternatives []string) error {
	code := CodeCapability
	switch r.Feature {
	case FeatureFunctionTool, FeatureCustomTool, FeatureComputerTool, FeatureHostedTool, FeatureTools, FeatureToolCall, FeatureToolResult:
		code = CodeToolKindUnsupported
	case FeatureImage, FeatureAudio, FeatureFile:
		code = CodeMediaUnsupported
	case FeaturePDF, FeatureContextManagement:
		code = CodeDocumentUnsupported
	case FeatureRemoteCompactionV1:
		code = CodeCompactionV1Unsupported
	case FeatureRemoteCompactionV2:
		code = CodeCompactionV2Unsupported
	}
	return &CapabilityError{Code: code, SourceSurface: source, Feature: r.Feature, Path: r.SourcePath, Alternatives: boundedStrings(alternatives)}
}
func encoderFor(s Surface) EncoderKind {
	switch s {
	case SurfaceOpenAIChat:
		return EncoderOpenAIChat
	case SurfaceOpenAIResponses:
		return EncoderOpenAIResponses
	case SurfaceAnthropic:
		return EncoderAnthropic
	case SurfaceGemini:
		return EncoderGemini
	default:
		return EncoderKind(s)
	}
}
func surfaceAllowed(values []Surface, target Surface) bool {
	if len(values) == 0 {
		return true
	}
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func boundedStrings(in []string) []string {
	out := make([]string, 0, minInt(len(in), MaxPlanAlternatives))
	for _, s := range in {
		if s != "" && len(s) <= MaxPlanPathBytes {
			out = append(out, s)
		}
	}
	return out
}
func boundedSurfaceStrings(in []Surface) []string {
	out := make([]string, 0, minInt(len(in), MaxPlanAlternatives))
	for _, s := range in {
		if s != "" && len(s) <= MaxPlanPathBytes {
			out = append(out, string(s))
		}
	}
	return out
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// PlanCache stores serialized plans in the shared backend and immutable typed
// plans in a bounded local hot cache. Local hits never marshal or unmarshal;
// the backend remains advisory distributed state and miss coalescing.
type PlanCache struct {
	backend    PlanCacheBackend
	ttlSeconds int
	localMu    sync.RWMutex
	local      map[string]compiledPlan
}

type compiledPlan struct {
	plan       CompatibilityPlan
	expiresAt  time.Time
	generation CacheGeneration
}

func NewPlanCache(backend PlanCacheBackend, ttlSeconds int) (*PlanCache, error) {
	if backend == nil {
		return nil, planError(CodeInvalidPlan, "cache", "cache backend is required", nil)
	}
	if ttlSeconds <= 0 {
		ttlSeconds = DefaultPlanCacheTTL
	}
	if ttlSeconds > 3600 {
		ttlSeconds = 3600
	}
	return &PlanCache{backend: backend, ttlSeconds: ttlSeconds, local: make(map[string]compiledPlan)}, nil
}

// Planner is the single request compatibility planning seam. It owns no
// routing, account, or transport state; those remain catalog and Router
// responsibilities. A nil cache is a valid fail-open configuration.
type Planner struct{ cache *PlanCache }

func NewPlanner(backend PlanCacheBackend, ttlSeconds int) (*Planner, error) {
	if backend == nil {
		return &Planner{}, nil
	}
	planCache, err := NewPlanCache(backend, ttlSeconds)
	if err != nil {
		return nil, err
	}
	return &Planner{cache: planCache}, nil
}

func (p *Planner) Plan(ctx context.Context, req PlanRequest) (CompatibilityPlan, error) {
	if p == nil || p.cache == nil {
		return Plan(req)
	}
	if ctx == nil {
		return CompatibilityPlan{}, planError(CodeInvalidPlan, "context", "context is required when plan caching is enabled", nil)
	}
	return p.cache.Plan(ctx, req)
}

func PlanCached(ctx context.Context, backend PlanCacheBackend, req PlanRequest) (CompatibilityPlan, error) {
	planner, err := NewPlanner(backend, DefaultPlanCacheTTL)
	if err != nil {
		return CompatibilityPlan{}, err
	}
	return planner.Plan(ctx, req)
}

func (c *PlanCache) Plan(ctx context.Context, req PlanRequest) (CompatibilityPlan, error) {
	if c == nil || c.backend == nil {
		return Plan(req)
	}
	if ctx == nil {
		return CompatibilityPlan{}, planError(CodeInvalidPlan, "context", "context is required when plan caching is enabled", nil)
	}
	shape, shapeErr := planCacheShapeKey(req)
	if shapeErr == nil {
		if cached, ok := c.localGet(shape); ok {
			return cached, nil
		}
	}
	key, err := planCacheKey(req)
	if err != nil {
		return Plan(req)
	}
	if cached, ok := c.localGet(key); ok {
		return cached, nil
	}
	loader := func(_ context.Context, k PlanCacheKey) (PlanCacheEntry, error) {
		p, e := Plan(req)
		if e != nil {
			return PlanCacheEntry{}, e
		}
		payload, e := json.Marshal(p)
		if e != nil {
			return PlanCacheEntry{}, e
		}
		if len(payload) > MaxPlanPayloadBytes {
			return PlanCacheEntry{}, planError(CodePlanBounds, "cache.value", "plan payload exceeds bound", nil)
		}
		return PlanCacheEntry{Key: k, Value: payload, ExpiresAt: time.Now().Add(time.Duration(c.ttlSeconds) * time.Second)}, nil
	}
	var entry PlanCacheEntry
	if coalescer, ok := c.backend.(PlanCacheMissCoalescer); ok {
		entry, err = coalescer.GetOrLoad(ctx, key, loader)
	} else {
		entry, err = c.backend.Get(ctx, key)
		if err != nil {
			entry, err = loader(ctx, key)
			if err == nil {
				_ = c.backend.Set(ctx, key, entry.Value, time.Duration(c.ttlSeconds)*time.Second)
			}
		}
	}
	if err == nil {
		var p CompatibilityPlan
		if json.Unmarshal(entry.Value, &p) == nil && p.Validate() == nil && planMatchesKey(p, key) {
			c.localPut(key, p)
			if shapeErr == nil {
				c.localPut(shape, p)
			}
			return p.Clone(), nil
		}
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return CompatibilityPlan{}, ctxErr
	}
	return Plan(req)
}

func (c *PlanCache) localGet(key PlanCacheKey) (CompatibilityPlan, bool) {
	if c == nil {
		return CompatibilityPlan{}, false
	}
	now := time.Now()
	wire := key.wire()
	c.localMu.RLock()
	entry, ok := c.local[wire]
	c.localMu.RUnlock()
	if !ok {
		return CompatibilityPlan{}, false
	}
	if !entry.expiresAt.IsZero() && !now.Before(entry.expiresAt) {
		c.localMu.Lock()
		if current, exists := c.local[wire]; exists && !current.expiresAt.IsZero() && !now.Before(current.expiresAt) {
			delete(c.local, wire)
		}
		c.localMu.Unlock()
		return CompatibilityPlan{}, false
	}
	if !entry.generation.IsZero() && entry.generation != key.Generation {
		return CompatibilityPlan{}, false
	}
	if !planMatchesKey(entry.plan, key) {
		return CompatibilityPlan{}, false
	}
	return entry.plan.Clone(), true
}

func (c *PlanCache) localPut(key PlanCacheKey, plan CompatibilityPlan) {
	if c == nil || plan.Validate() != nil || !planMatchesKey(plan, key) {
		return
	}
	c.localMu.Lock()
	if c.local == nil {
		c.local = make(map[string]compiledPlan)
	}
	if _, exists := c.local[key.wire()]; !exists && len(c.local) >= maxLocalCompiledPlans {
		for wire := range c.local {
			delete(c.local, wire)
			break
		}
	}
	c.local[key.wire()] = compiledPlan{
		plan:       plan.Clone(),
		expiresAt:  time.Now().Add(time.Duration(c.ttlSeconds) * time.Second),
		generation: key.Generation,
	}
	c.localMu.Unlock()
}

func planMatchesKey(plan CompatibilityPlan, key PlanCacheKey) bool {
	if plan.Decision.CatalogGeneration != key.Generation.Catalog {
		return false
	}
	if key.Generation.Credentials != 0 &&
		plan.Decision.CapabilityVersion != key.Generation.Credentials {
		return false
	}
	return plan.ProviderID == key.ProviderScope && plan.ModelID == modelIDFromCacheKey(key.Model)
}

func modelIDFromCacheKey(model string) string {
	if slash := strings.IndexByte(model, '/'); slash >= 0 && slash+1 < len(model) {
		return model[slash+1:]
	}
	return model
}

func planCacheKey(req PlanRequest) (PlanCacheKey, error) {
	key, err := planCacheShapeKey(req)
	if err != nil {
		return PlanCacheKey{}, err
	}
	plan, err := Plan(req)
	if err != nil {
		return PlanCacheKey{}, err
	}
	decisionKey, err := NewCompatibilityCacheKey(plan.Decision)
	if err != nil {
		return PlanCacheKey{}, err
	}
	key.Decision = decisionKey
	return key, nil
}

func planCacheShapeKey(req PlanRequest) (PlanCacheKey, error) {
	reqs, err := req.Features.normalized()
	if err != nil {
		return PlanCacheKey{}, err
	}
	caps := []string{"profile=" + string(req.Profile), "source=" + string(req.SourceSurface), "target=" + string(req.TargetSurface), "provider=" + req.ProviderID, "policy=" + req.Policy.ID, fmt.Sprintf("policy-generation=%d", req.Policy.Generation)}
	for _, r := range reqs {
		caps = append(caps, "feature="+string(r.Feature))
	}
	caps = append(caps,
		fmt.Sprintf("native-passthrough=%t", req.NativePassthroughRequested),
		fmt.Sprintf("byte-preservation=%t", req.BytePreservationRequired),
		fmt.Sprintf("loss-requested=%t", req.LossRequested),
		fmt.Sprintf("response-strict=%t", req.ResponseStrict),
		fmt.Sprintf("allow-lossy=%t", req.Tenant.AllowLossy),
		fmt.Sprintf("allow-content-storage=%t", req.Tenant.AllowContentStorage),
		fmt.Sprintf("allow-response-caching=%t", req.Tenant.AllowResponseCaching),
		fmt.Sprintf("allow-hedging=%t", req.Tenant.AllowHedging),
		fmt.Sprintf("capability-version=%d", req.Policy.CapabilityVersion),
	)
	model := req.ProviderID + "/" + req.ModelID
	gen := req.Generation
	if gen.Catalog == 0 {
		gen.Catalog = req.Policy.Generation
	}
	if gen.Health == 0 {
		gen.Health = 1
	}
	key, err := NewPlanCacheKey(model, string(req.TargetSurface), caps, gen, req.ProviderID)
	if err != nil {
		return PlanCacheKey{}, err
	}
	return key, nil
}

// PlanDigest is useful for bounded diagnostics and tests; it hashes only the
// content-free plan, never request content.
func PlanDigest(plan CompatibilityPlan) string {
	payload, _ := json.Marshal(plan)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
