package catalog

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

const (
	MaxAliasDepth     = 16
	MaxComboMembers   = 64
	MaxSnapshotModels = 4096
	DefaultRefreshTTL = 30 * time.Second
	DefaultMaxStale   = 5 * time.Minute
)

var (
	ErrUnknownModel    = errors.New("catalog: unknown model")
	ErrAliasCycle      = errors.New("catalog: alias cycle")
	ErrAliasDepth      = errors.New("catalog: alias depth exceeded")
	ErrEmptyCombo      = errors.New("catalog: combination has no members")
	ErrAmbiguousModel  = errors.New("catalog: ambiguous model")
	ErrSurfaceMismatch = errors.New("catalog: combination has no common surface")
	ErrStaleSnapshot   = errors.New("catalog: last valid snapshot exceeded stale window")
)

type Alias struct {
	Alias  string
	Target string
}
type Combination struct {
	ID       string
	Members  []string
	Strategy string
}

type Source interface {
	Load(context.Context) ([]Alias, []Combination, uint64, error)
}

type RouteStrategy string

const (
	RouteStrategySingle   RouteStrategy = "single"
	RouteStrategyFallback RouteStrategy = "fallback"
)

// Operation aliases keep catalog callers independent of wire codec details
// while sharing the canonical operation classifier.
type OperationKind = transforms.OperationKind

const (
	OperationGenerate = transforms.OperationGenerate
	OperationCompactV1 = transforms.OperationCompactV1
	OperationCompactV2 = transforms.OperationCompactV2
)

type RoutePlan struct {
	RequestedModel string
	Generation     uint64
	PolicyGeneration uint64
	Strategy       RouteStrategy
	SourceSurface  contracts.Surface
	Operation      transforms.OperationKind
	CanonicalOperation transforms.Operation
	Requirements   FeatureRequirements
	Members        []RouteMember
	Exclusions     []RouteExclusion
}

type RouteMember struct {
	ProviderID      string
	ClientModelID   string
	UpstreamModelID string
	// SourceSurface is the client-facing contract. TargetSurface is the
	// provider-native contract; they intentionally differ on translated routes.
	SourceSurface contracts.Surface
	TargetSurface providers.Surface
	// Surface is retained for existing router callers. New plans set it to the
	// source surface, while TargetSurface selects the provider wire encoder.
	Surface         contracts.Surface
}

// FeatureRequirement identifies a semantic request capability. Values are
// stable strings so diagnostics can be safely exposed without request data.
type FeatureRequirement string

const (
	FeatureVision             FeatureRequirement = "vision"
	FeatureAudio              FeatureRequirement = "audio"
	FeatureFile               FeatureRequirement = "file"
	FeatureDocument           FeatureRequirement = "document"
	FeaturePDF                FeatureRequirement = "pdf"
	FeatureToolDeclaration    FeatureRequirement = "tool.declaration"
	FeatureToolCall           FeatureRequirement = "tool.call"
	FeatureToolResult         FeatureRequirement = "tool.result"
	FeatureNativeTool         FeatureRequirement = "tool.native"
	FeatureStructuredOutput   FeatureRequirement = "structured_output"
	FeatureReasoningHistory   FeatureRequirement = "reasoning.history"
	FeatureContinuation       FeatureRequirement = "continuation"
	FeatureCompactionV1       FeatureRequirement = "compaction.v1"
	FeatureCompactionV2       FeatureRequirement = "compaction.v2"
)

// FeatureRequirements separates hard semantic requirements from optional
// preferences. A candidate missing a hard feature is excluded before account
// selection; soft features only affect deterministic ranking.
type FeatureRequirements struct {
	Hard         []FeatureRequirement
	Soft         []FeatureRequirement
	ToolKinds    []transforms.ToolKind
	ReferenceKinds []string
}

// RoutePlanningInput is the source/operation context used by PlanFor. The
// legacy Plan method remains a same-surface generation convenience.
type RoutePlanningInput struct {
	SourceSurface contracts.Surface
	Operation     transforms.OperationKind
	CanonicalOperation transforms.Operation
	Requirements  FeatureRequirements
}

// RouteExclusion records a bounded pre-account candidate rejection.
type RouteExclusion struct {
	ProviderID string
	ModelID    string
	Code       string
	Feature    FeatureRequirement
	Supported  []string
}

// CapabilityError is returned only when no route can satisfy the hard
// requirements. It is deliberately bounded and contains no request content.
type CapabilityError struct {
	RequestedModel string
	SourceSurface  contracts.Surface
	Operation      transforms.OperationKind
	Code           string
	Feature        FeatureRequirement
	Supported      []string
}

func (e *CapabilityError) Error() string {
	if e == nil {
		return "catalog: capability mismatch"
	}
	if e.Feature != "" {
		return fmt.Sprintf("catalog: %s (%s)", e.Code, e.Feature)
	}
	return "catalog: " + e.Code
}

type Snapshot struct {
	Generation   uint64
	PolicyGeneration uint64
	Providers    []string
	Models       map[string]Model
	Unqualified  map[string]string
	Aliases      map[string]string
	Combinations map[string]Combination
}
type Model struct {
	ID          string
	QualifiedID string
	ProviderID  string
	UpstreamID  string
	Surfaces    []providers.Surface
	Capabilities providers.ProviderCaps
}

func (s *Snapshot) Resolve(modelID string) (Model, error) {
	if s == nil {
		return Model{}, ErrUnknownModel
	}
	if target, ok := s.Aliases[modelID]; ok {
		modelID = target
	}
	if model, ok := s.Models[modelID]; ok {
		return model, nil
	}
	if qualified, ok := s.Unqualified[modelID]; ok {
		if qualified == "" {
			return Model{}, fmt.Errorf("%w: %s", ErrAmbiguousModel, modelID)
		}
		return s.Models[qualified], nil
	}
	return Model{}, fmt.Errorf("%w: %s", ErrUnknownModel, modelID)
}

func (s *Snapshot) Plan(requested string, surface contracts.Surface) (RoutePlan, error) {
	return s.PlanFor(requested, RoutePlanningInput{SourceSurface: surface, Operation: transforms.OperationGenerate})
}

// PlanFor resolves a requested model/combination and independently selects a
// provider-native target surface for each eligible member. Planning performs
// only bounded catalog/policy checks; it never acquires an account or starts a
// network attempt.
func (s *Snapshot) PlanFor(requested string, input RoutePlanningInput) (RoutePlan, error) {
	if s == nil {
		return RoutePlan{}, ErrUnknownModel
	}
	if !input.SourceSurface.IsValid() {
		return RoutePlan{}, fmt.Errorf("catalog: invalid surface %q", input.SourceSurface)
	}
	operation := input.Operation
	if operation == 0 && input.CanonicalOperation.Kind != 0 {
		operation = input.CanonicalOperation.Kind
	}
	if operation == 0 {
		operation = transforms.OperationGenerate
	}
	input.Operation = operation
	plan := RoutePlan{RequestedModel: requested, Generation: s.Generation, PolicyGeneration: s.PolicyGeneration, Strategy: RouteStrategySingle, SourceSurface: input.SourceSurface, Operation: operation, CanonicalOperation: input.CanonicalOperation, Requirements: normalizeRequirements(input.Requirements)}
	if combo, ok := s.Combinations[requested]; ok {
		plan.Strategy = RouteStrategyFallback
		plan.Members = make([]RouteMember, 0, len(combo.Members))
		for _, qualified := range combo.Members {
			model := s.Models[qualified]
			member, exclusion := planMember(model, input.SourceSurface, operation, plan.Requirements)
			if exclusion != nil {
				plan.Exclusions = appendBoundedExclusion(plan.Exclusions, RouteExclusion{ProviderID: model.ProviderID, ModelID: model.ID, Code: exclusion.Code, Feature: exclusion.Feature, Supported: exclusion.Supported})
				continue
			}
			plan.Members = append(plan.Members, member)
		}
		sort.SliceStable(plan.Members, func(i, j int) bool { return memberRank(s, plan.Members[i], plan.Requirements) < memberRank(s, plan.Members[j], plan.Requirements) })
		if len(plan.Members) == 0 {
			return RoutePlan{}, planCapabilityError(requested, input, plan.Exclusions)
		}
		return plan, nil
	}
	model, err := s.Resolve(requested)
	if err != nil {
		return RoutePlan{}, err
	}
	member, exclusion := planMember(model, input.SourceSurface, operation, plan.Requirements)
	if exclusion != nil {
		plan.Exclusions = appendBoundedExclusion(plan.Exclusions, RouteExclusion{ProviderID: model.ProviderID, ModelID: model.ID, Code: exclusion.Code, Feature: exclusion.Feature, Supported: exclusion.Supported})
		return RoutePlan{}, planCapabilityError(requested, input, plan.Exclusions)
	}
	plan.Members = []RouteMember{member}
	return plan, nil
}

// PlanWithRequirements is a convenience for callers that already extracted
// hard/soft features from a canonical request.
func (s *Snapshot) PlanWithRequirements(requested string, source contracts.Surface, operation transforms.OperationKind, requirements FeatureRequirements) (RoutePlan, error) {
	return s.PlanFor(requested, RoutePlanningInput{SourceSurface: source, Operation: operation, Requirements: requirements})
}

// PlanCanonical is the service-path entrypoint that retains the validated
// canonical request for planning metadata instead of decoding/re-encoding it
// once per candidate. The request remains owned by the caller; the plan keeps
// only typed operation and feature metadata.
func (s *Snapshot) PlanCanonical(requested string, req *transforms.NormalizedRequest) (RoutePlan, error) {
	if req == nil {
		return RoutePlan{}, ErrUnknownModel
	}
	operation := ClassifyOperation(req)
	return s.PlanFor(requested, RoutePlanningInput{
		SourceSurface: req.Source,
		Operation: operation,
		CanonicalOperation: req.Operation,
		Requirements: ExtractFeatureRequirements(req, operation),
	})
}

func routeMember(model Model, source contracts.Surface, target providers.Surface) RouteMember {
	return RouteMember{ProviderID: model.ProviderID, ClientModelID: model.ID, UpstreamModelID: model.UpstreamID, SourceSurface: source, TargetSurface: target, Surface: source}
}

func supportsSurface(surfaces []providers.Surface, surface contracts.Surface) bool {
	for _, candidate := range surfaces {
		if candidate == surface {
			return true
		}
	}
	return false
}

type memberMismatch struct {
	Code      string
	Feature   FeatureRequirement
	Supported []string
}

func planMember(model Model, source contracts.Surface, operation transforms.OperationKind, requirements FeatureRequirements) (RouteMember, *memberMismatch) {
	target, ok := targetSurface(model.Surfaces, source)
	if !ok {
		return RouteMember{}, &memberMismatch{Code: "capability.source_surface_unsupported", Supported: surfaceStrings(model.Surfaces)}
	}
	if operation != transforms.OperationGenerate && target != providers.SurfaceOpenAIResponses {
		feature := FeatureCompactionV1
		if operation == transforms.OperationCompactV2 {
			feature = FeatureCompactionV2
		}
		return RouteMember{}, &memberMismatch{Code: "capability.compaction_unsupported", Feature: feature, Supported: []string{string(providers.SurfaceOpenAIResponses)}}
	}
	if operation != transforms.OperationGenerate {
		feature := FeatureCompactionV1
		version := providers.CompactionV1
		if operation == transforms.OperationCompactV2 {
			feature = FeatureCompactionV2
			version = providers.CompactionV2
		}
		if !model.Capabilities.Compatibility.SupportsCompaction(version) {
			return RouteMember{}, &memberMismatch{Code: "capability.compaction_unsupported", Feature: feature, Supported: []string{string(providers.SurfaceOpenAIResponses)}}
		}
	}
	for _, feature := range requirements.Hard {
		if !modelSupportsFeature(model, target, source, feature, requirements) {
			return RouteMember{}, &memberMismatch{Code: featureMismatchCode(feature), Feature: feature, Supported: supportedFeatures(model, target)}
		}
	}
	return routeMember(model, source, target), nil
}

func targetSurface(surfaces []providers.Surface, source contracts.Surface) (providers.Surface, bool) {
	if supportsSurface(surfaces, source) {
		return providers.Surface(source), true
	}
	// OpenAI Chat and Responses have a validated canonical translation path.
	// Keep this explicit rather than advertising a synthetic source surface in
	// the catalog model.
	if source == contracts.SurfaceOpenAIChat && supportsSurface(surfaces, providers.SurfaceOpenAIResponses) {
		return providers.SurfaceOpenAIResponses, true
	}
	if source == contracts.SurfaceOpenAIResponses && supportsSurface(surfaces, providers.SurfaceOpenAIChat) {
		return providers.SurfaceOpenAIChat, true
	}
	return "", false
}

func modelSupportsFeature(model Model, target providers.Surface, source contracts.Surface, feature FeatureRequirement, requirements FeatureRequirements) bool {
	policy := model.Capabilities.Compatibility
	switch feature {
	case FeatureVision:
		return policy.SupportsMedia(providers.MediaImage, referenceKindFor(requirements), "")
	case FeatureAudio:
		return policy.SupportsMedia(providers.MediaAudio, referenceKindFor(requirements), "")
	case FeatureFile:
		return policy.SupportsMedia(providers.MediaFile, referenceKindFor(requirements), "")
	case FeatureDocument:
		return policy.SupportsMedia(providers.MediaDocument, referenceKindFor(requirements), "")
	case FeaturePDF:
		return policy.SupportsMedia(providers.MediaPDF, referenceKindFor(requirements), "")
	case FeatureToolDeclaration, FeatureToolCall, FeatureToolResult:
		return policy.SupportsToolKind(providers.ToolFunction)
	case FeatureNativeTool:
		if len(requirements.ToolKinds) == 0 {
			return policy.SupportsToolKind(providers.ToolProviderNative)
		}
		for _, kind := range requirements.ToolKinds {
			if kind == transforms.ToolKindFunction {
				continue
			}
			if !policy.SupportsToolKind(providerToolKind(kind)) {
				return false
			}
		}
		return true
	case FeatureReasoningHistory:
		return policy.Reasoning.Enabled
	case FeatureCompactionV1, FeatureCompactionV2:
		if target != providers.SurfaceOpenAIResponses {
			return false
		}
		version := providers.CompactionV1
		if feature == FeatureCompactionV2 {
			version = providers.CompactionV2
		}
		return policy.SupportsCompaction(version)
	case FeatureStructuredOutput, FeatureContinuation:
		// All current canonical codecs preserve these fields; provider-specific
		// restrictions are supplied by the typed compatibility policy in the
		// preparation/plan layer.
		return true
	default:
		return true
	}
}

func providerToolKind(kind transforms.ToolKind) providers.ToolKind {
	switch kind {
	case transforms.ToolKindFunction:
		return providers.ToolFunction
	case transforms.ToolKindCustom:
		return providers.ToolCustom
	case transforms.ToolKindComputer:
		return providers.ToolComputer
	case transforms.ToolKindHosted:
		return providers.ToolHosted
	case transforms.ToolKindServer:
		return providers.ToolServer
	case transforms.ToolKindWebSearch:
		return providers.ToolWebSearch
	case transforms.ToolKindImage:
		return providers.ToolImage
	case transforms.ToolKindMCP:
		return providers.ToolMCP
	default:
		return providers.ToolProviderNative
	}
}

func referenceKindFor(requirements FeatureRequirements) providers.ReferenceKind {
	if len(requirements.ReferenceKinds) == 0 {
		return providers.ReferenceURL
	}
	switch requirements.ReferenceKinds[0] {
	case string(providers.ReferenceInlineData):
		return providers.ReferenceInlineData
	case string(providers.ReferenceProviderFileID):
		return providers.ReferenceProviderFileID
	case string(providers.ReferenceProviderFileURL):
		return providers.ReferenceProviderFileURL
	default:
		return providers.ReferenceURL
	}
}

func featureMismatchCode(feature FeatureRequirement) string {
	switch feature {
	case FeatureToolDeclaration, FeatureToolCall, FeatureToolResult, FeatureNativeTool:
		return "capability.tool_unsupported"
	case FeatureVision, FeatureAudio, FeatureFile, FeatureDocument, FeaturePDF:
		return "capability.reference_unsupported"
	case FeatureCompactionV1, FeatureCompactionV2:
		return "capability.compaction_unsupported"
	default:
		return "capability.feature_unsupported"
	}
}

func supportedFeatures(model Model, target providers.Surface) []string {
	out := []string{string(target)}
	policy := model.Capabilities.Compatibility
	if policy.SupportsMedia(providers.MediaImage, providers.ReferenceURL, "") {
		out = append(out, string(FeatureVision))
	}
	if policy.SupportsToolKind(providers.ToolFunction) {
		out = append(out, string(FeatureToolCall))
	}
	if policy.Reasoning.Enabled {
		out = append(out, string(FeatureReasoningHistory))
	}
	return out
}

func surfaceStrings(surfaces []providers.Surface) []string {
	out := make([]string, 0, len(surfaces))
	for _, surface := range surfaces {
		out = append(out, string(surface))
	}
	return out
}

func normalizeRequirements(requirements FeatureRequirements) FeatureRequirements {
	return FeatureRequirements{Hard: dedupeFeatures(requirements.Hard), Soft: dedupeFeatures(requirements.Soft), ToolKinds: dedupeToolKinds(requirements.ToolKinds), ReferenceKinds: dedupeStrings(requirements.ReferenceKinds)}
}

func dedupeFeatures(values []FeatureRequirement) []FeatureRequirement {
	seen := make(map[FeatureRequirement]struct{}, len(values))
	out := make([]FeatureRequirement, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func dedupeToolKinds(values []transforms.ToolKind) []transforms.ToolKind {
	seen := make(map[transforms.ToolKind]struct{}, len(values))
	out := make([]transforms.ToolKind, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func memberRank(snapshot *Snapshot, member RouteMember, requirements FeatureRequirements) int {
	rank := 2
	if member.SourceSurface == member.TargetSurface {
		rank = 1
	}
	softMissing := 0
	if snapshot != nil {
		if model, ok := snapshot.Models[qualify(member.ProviderID, member.ClientModelID)]; ok {
			for _, feature := range requirements.Soft {
				if !modelSupportsFeature(model, member.TargetSurface, member.SourceSurface, feature, requirements) {
					softMissing++
				}
			}
		}
	}
	// Lower is better: native full-fit first, then lossless translation, then
	// the same tier ordered by the fewest optional feature mismatches.
	return rank*1000 + softMissing
}

func appendBoundedExclusion(exclusions []RouteExclusion, exclusion RouteExclusion) []RouteExclusion {
	if len(exclusions) >= MaxComboMembers {
		return exclusions
	}
	exclusion.Supported = append([]string(nil), exclusion.Supported...)
	return append(exclusions, exclusion)
}

func planCapabilityError(requested string, input RoutePlanningInput, exclusions []RouteExclusion) error {
	err := &CapabilityError{RequestedModel: requested, SourceSurface: input.SourceSurface, Operation: input.Operation, Code: "capability.no_compatible_route"}
	if len(exclusions) > 0 {
		err.Code = exclusions[0].Code
		err.Feature = exclusions[0].Feature
		err.Supported = append([]string(nil), exclusions[0].Supported...)
	}
	return err
}

// ExtractFeatureRequirements turns one canonical request into bounded hard
// and soft feature sets before candidate planning. It never copies user text.
func ExtractFeatureRequirements(req *transforms.NormalizedRequest, operation transforms.OperationKind) FeatureRequirements {
	if req == nil {
		return FeatureRequirements{}
	}
	if operation == 0 {
		operation = ClassifyOperation(req)
	}
	out := FeatureRequirements{}
	addHard := func(feature FeatureRequirement) { out.Hard = append(out.Hard, feature) }
	if req.StructuredOutput != nil || req.ResponseFormat != "" {
		addHard(FeatureStructuredOutput)
	}
	if req.PreviousResponseID != "" || req.ConversationID != "" || req.ContinuationID != "" {
		addHard(FeatureContinuation)
	}
	if req.Reasoning != transforms.ReasoningDefault || req.ReasoningConfig != nil || len(req.TrailingReasoningItems) > 0 {
		addHard(FeatureReasoningHistory)
	}
	if operation == transforms.OperationCompactV1 {
		addHard(FeatureCompactionV1)
	}
	if operation == transforms.OperationCompactV2 {
		addHard(FeatureCompactionV2)
	}
	for _, tool := range req.Tools {
		addHard(FeatureToolDeclaration)
		out.ToolKinds = append(out.ToolKinds, tool.Kind)
		if tool.Kind != transforms.ToolKindFunction {
			addHard(FeatureNativeTool)
		}
	}
	for _, message := range req.Messages {
		for _, block := range message.Content {
			appendBlockReferences(&out, block)
			switch block.Type {
			case transforms.BlockImage:
				addHard(FeatureVision)
			case transforms.BlockAudio:
				addHard(FeatureAudio)
			case transforms.BlockFile:
				addHard(FeatureFile)
			case transforms.BlockDocument:
				addHard(FeatureDocument)
			case transforms.BlockPDF:
				addHard(FeaturePDF)
			case transforms.BlockToolUse:
				addHard(FeatureToolCall)
				out.ToolKinds = append(out.ToolKinds, block.ToolKind)
			case transforms.BlockToolResult:
				addHard(FeatureToolResult)
			case transforms.BlockServerToolUse, transforms.BlockServerToolResult:
				addHard(FeatureNativeTool)
			}
		}
	}
	return normalizeRequirements(out)
}

func appendBlockReferences(out *FeatureRequirements, block transforms.ContentBlock) {
	if out == nil {
		return
	}
	appendReference := func(reference transforms.ReferenceKind) {
		switch reference {
		case transforms.ReferenceInlineData:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceInlineData))
		case transforms.ReferenceProviderFileID:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceProviderFileID))
		case transforms.ReferenceProviderFileURL:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceProviderFileURL))
		default:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceURL))
		}
	}
	if block.Media != nil {
		appendReference(block.Media.Reference)
	}
	if block.Audio != nil {
		appendReference(block.Audio.Reference)
	}
	if block.File != nil {
		appendReference(block.File.Reference)
	}
	if block.Document != nil {
		appendReference(block.Document.Reference)
	}
	if block.Image != nil {
		switch block.Image.Kind {
		case transforms.ImageData:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceInlineData))
		case transforms.ImageFile:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceProviderFileID))
		default:
			out.ReferenceKinds = append(out.ReferenceKinds, string(providers.ReferenceURL))
		}
	}
}

// ClassifyOperation is body/endpoint authoritative once source decoding has
// produced a canonical request. It deliberately does not inspect User-Agent
// or other client identity hints.
func ClassifyOperation(req *transforms.NormalizedRequest) transforms.OperationKind {
	if req == nil {
		return transforms.OperationGenerate
	}
	if req.Operation.Kind != 0 {
		return req.Operation.Kind
	}
	for _, message := range req.Messages {
		for _, block := range message.Content {
			if block.Type == transforms.BlockCompactionTrigger || (block.Compaction != nil && block.Compaction.Kind == transforms.CompactionItemTrigger) {
				return transforms.OperationCompactV2
			}
			if block.Type == transforms.BlockCompaction || (block.Compaction != nil && block.Compaction.Kind != "") {
				if block.Compaction != nil && block.Compaction.Version == transforms.CompactionV2 {
					return transforms.OperationCompactV2
				}
				return transforms.OperationCompactV1
			}
		}
	}
	return transforms.OperationGenerate
}

func (s *Snapshot) Clone() *Snapshot {
	if s == nil {
		return nil
	}
	out := &Snapshot{Generation: s.Generation, PolicyGeneration: s.PolicyGeneration, Providers: append([]string(nil), s.Providers...), Models: make(map[string]Model, len(s.Models)), Unqualified: make(map[string]string, len(s.Unqualified)), Aliases: make(map[string]string, len(s.Aliases)), Combinations: make(map[string]Combination, len(s.Combinations))}
	for k, v := range s.Models {
		v.Surfaces = append([]providers.Surface(nil), v.Surfaces...)
		v.Capabilities.Surfaces = append([]providers.Surface(nil), v.Capabilities.Surfaces...)
		v.Capabilities.MediaGeneration = append([]string(nil), v.Capabilities.MediaGeneration...)
		v.Capabilities.Compatibility = v.Capabilities.Compatibility.Clone()
		out.Models[k] = v
	}
	for k, v := range s.Aliases {
		out.Aliases[k] = v
	}
	for k, v := range s.Unqualified {
		out.Unqualified[k] = v
	}
	for k, v := range s.Combinations {
		v.Members = append([]string(nil), v.Members...)
		out.Combinations[k] = v
	}
	return out
}

type Builder struct {
	registry *providers.Registry
	mu       sync.Mutex
	last     *Snapshot
}

func NewBuilder(registry *providers.Registry) (*Builder, error) {
	if registry == nil {
		return nil, errors.New("catalog: registry is required")
	}
	return &Builder{registry: registry}, nil
}

func (b *Builder) Build(ctx context.Context, source Source) (*Snapshot, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if source == nil {
		return nil, errors.New("catalog: source is required")
	}
	aliases, combos, generation, err := source.Load(ctx)
	if err != nil {
		return nil, fmt.Errorf("catalog source: %w", err)
	}
	s := &Snapshot{Generation: generation, PolicyGeneration: generation, Models: map[string]Model{}, Unqualified: map[string]string{}, Aliases: map[string]string{}, Combinations: map[string]Combination{}}
	s.Providers = b.registry.IDs()
	for _, pid := range s.Providers {
		p, err := b.registry.Get(pid)
		if err != nil {
			return nil, err
		}
		for _, m := range p.Models().List() {
			m.ID = strings.TrimSpace(m.ID)
			if m.ID == "" {
				return nil, fmt.Errorf("catalog: provider %s has an empty model id", pid)
			}
			up := strings.TrimSpace(m.UpstreamID)
			if up == "" {
				up = m.ID
			}
			providerCaps := p.Capabilities()
			caps := providerCaps
			if m.Capabilities != nil {
				caps = cloneProviderCaps(*m.Capabilities)
			}
			caps.Compatibility = providers.EffectiveCompatibilityPolicy(providerCaps, &m)
			if err := caps.Compatibility.Validate(); err != nil {
				return nil, fmt.Errorf("catalog: provider %s model %s compatibility policy: %w", pid, m.ID, err)
			}
			if caps.Compatibility.Generation > s.PolicyGeneration {
				s.PolicyGeneration = caps.Compatibility.Generation
			}
			surfaces := m.Surfaces
			if len(surfaces) == 0 {
				surfaces = caps.Surfaces
				if len(surfaces) == 0 {
					surfaces = providerCaps.Surfaces
				}
			}
			caps.Surfaces = append([]providers.Surface(nil), surfaces...)
			qualified := qualify(pid, m.ID)
			if _, exists := s.Models[qualified]; exists {
				return nil, fmt.Errorf("catalog: provider/model collision %s", qualified)
			}
			s.Models[qualified] = Model{ID: m.ID, QualifiedID: qualified, ProviderID: pid, UpstreamID: up, Surfaces: append([]providers.Surface(nil), surfaces...), Capabilities: caps}
			if previous, exists := s.Unqualified[m.ID]; !exists {
				s.Unqualified[m.ID] = qualified
			} else if previous != qualified {
				s.Unqualified[m.ID] = ""
			}
		}
	}
	for _, a := range aliases {
		a.Alias = strings.TrimSpace(a.Alias)
		a.Target = strings.TrimSpace(a.Target)
		if a.Alias == "" || a.Target == "" {
			return nil, errors.New("catalog: empty alias")
		}
		if _, exists := s.Aliases[a.Alias]; exists {
			return nil, fmt.Errorf("catalog: duplicate alias %s", a.Alias)
		}
		s.Aliases[a.Alias] = a.Target
	}
	for alias := range s.Aliases {
		target, err := resolveAlias(s.Aliases, alias)
		if err != nil {
			return nil, err
		}
		qualified, err := resolveModelIdentity(s, target)
		if err != nil {
			return nil, fmt.Errorf("catalog alias %s: %w", alias, err)
		}
		if _, collision := s.Unqualified[alias]; collision {
			return nil, fmt.Errorf("catalog: alias %s collides with a model", alias)
		}
		if _, collision := s.Models[alias]; collision {
			return nil, fmt.Errorf("catalog: alias %s collides with a qualified model", alias)
		}
		s.Aliases[alias] = qualified
	}
	for _, c := range combos {
		c.ID = strings.TrimSpace(c.ID)
		if c.ID == "" || len(c.Members) == 0 {
			return nil, ErrEmptyCombo
		}
		if len(c.Members) > MaxComboMembers {
			return nil, fmt.Errorf("catalog: combo %s exceeds member bound", c.ID)
		}
		if _, ok := s.Combinations[c.ID]; ok {
			return nil, fmt.Errorf("catalog: duplicate combo %s", c.ID)
		}
		if _, collision := s.Unqualified[c.ID]; collision {
			return nil, fmt.Errorf("catalog: combination %s collides with a model", c.ID)
		}
		if _, collision := s.Models[c.ID]; collision {
			return nil, fmt.Errorf("catalog: combination %s collides with a qualified model", c.ID)
		}
		if _, collision := s.Aliases[c.ID]; collision {
			return nil, fmt.Errorf("catalog: combination %s collides with an alias", c.ID)
		}
		if strings.ToLower(strings.TrimSpace(c.Strategy)) != string(RouteStrategyFallback) {
			return nil, fmt.Errorf("catalog: combination %s uses unsupported strategy %q", c.ID, c.Strategy)
		}
		seen := make(map[string]struct{}, len(c.Members))
		var common map[providers.Surface]struct{}
		for i, m := range c.Members {
			m = strings.TrimSpace(m)
			target := m
			if aliasTarget, ok := s.Aliases[m]; ok {
				target = aliasTarget
			}
			qualified, err := resolveModelIdentity(s, target)
			if err != nil {
				return nil, fmt.Errorf("catalog combo %s: %w", c.ID, err)
			}
			if _, duplicate := seen[qualified]; duplicate {
				return nil, fmt.Errorf("catalog: combination %s has duplicate member %s", c.ID, m)
			}
			seen[qualified] = struct{}{}
			c.Members[i] = qualified
			common = intersectSurfaces(common, s.Models[qualified].Surfaces)
		}
		if len(common) == 0 {
			return nil, fmt.Errorf("%w: %s", ErrSurfaceMismatch, c.ID)
		}
		s.Combinations[c.ID] = Combination{ID: c.ID, Members: append([]string(nil), c.Members...), Strategy: string(RouteStrategyFallback)}
	}
	if len(s.Models) > MaxSnapshotModels {
		return nil, errors.New("catalog: snapshot model bound exceeded")
	}
	b.last = s.Clone()
	return s, nil
}

func qualify(providerID, modelID string) string { return providerID + ":" + modelID }

func cloneProviderCaps(caps providers.ProviderCaps) providers.ProviderCaps {
	caps.Surfaces = append([]providers.Surface(nil), caps.Surfaces...)
	caps.MediaGeneration = append([]string(nil), caps.MediaGeneration...)
	return caps
}

func clientSurfaces(providerID string, surfaces []providers.Surface) []providers.Surface {
	out := append([]providers.Surface(nil), surfaces...)
	if providerID != "openai" && providerID != "codex" {
		return out
	}
	if supportsSurface(out, contracts.SurfaceOpenAIResponses) && !supportsSurface(out, contracts.SurfaceOpenAIChat) {
		out = append(out, contracts.SurfaceOpenAIChat)
	}
	return out
}

func resolveModelIdentity(s *Snapshot, value string) (string, error) {
	if _, ok := s.Models[value]; ok {
		return value, nil
	}
	if qualified, ok := s.Unqualified[value]; ok {
		if qualified == "" {
			return "", fmt.Errorf("%w: %s", ErrAmbiguousModel, value)
		}
		return qualified, nil
	}
	return "", fmt.Errorf("%w: %s", ErrUnknownModel, value)
}

func intersectSurfaces(current map[providers.Surface]struct{}, surfaces []providers.Surface) map[providers.Surface]struct{} {
	if current == nil {
		current = make(map[providers.Surface]struct{}, len(surfaces))
		for _, surface := range surfaces {
			current[surface] = struct{}{}
		}
		return current
	}
	next := make(map[providers.Surface]struct{}, len(current))
	for _, surface := range surfaces {
		if _, ok := current[surface]; ok {
			next[surface] = struct{}{}
		}
	}
	return next
}

func resolveAlias(aliases map[string]string, start string) (string, error) {
	seen := map[string]bool{}
	cur := start
	for depth := 0; depth < MaxAliasDepth; depth++ {
		target, ok := aliases[cur]
		if !ok {
			return cur, nil
		}
		if seen[cur] {
			return "", fmt.Errorf("%w: %s", ErrAliasCycle, start)
		}
		seen[cur] = true
		cur = target
	}
	return "", fmt.Errorf("%w: %s", ErrAliasDepth, start)
}

func (b *Builder) Last() *Snapshot { b.mu.Lock(); defer b.mu.Unlock(); return b.last.Clone() }

type RefreshStatus struct {
	Generation  uint64
	RefreshedAt time.Time
	StaleUntil  time.Time
	Degraded    bool
	Diagnostic  string
}

type Resolver interface {
	Current(context.Context) (*Snapshot, RefreshStatus, error)
}

type StoreConfig struct {
	RefreshTTL time.Duration
	MaxStale   time.Duration
	Now        func() time.Time
}

type Store struct {
	builder     *Builder
	source      Source
	refreshTTL  time.Duration
	maxStale    time.Duration
	now         func() time.Time
	mu          sync.Mutex
	snapshot    *Snapshot
	refreshedAt time.Time
	nextRefresh time.Time
	degraded    bool
	diagnostic  string
}

func NewStore(ctx context.Context, builder *Builder, source Source, cfg StoreConfig) (*Store, error) {
	if builder == nil || source == nil {
		return nil, errors.New("catalog: store builder and source are required")
	}
	refreshTTL := cfg.RefreshTTL
	if refreshTTL <= 0 {
		refreshTTL = DefaultRefreshTTL
	}
	maxStale := cfg.MaxStale
	if maxStale <= 0 {
		maxStale = DefaultMaxStale
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	store := &Store{builder: builder, source: source, refreshTTL: refreshTTL, maxStale: maxStale, now: now}
	if _, _, err := store.Current(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) Current(ctx context.Context) (*Snapshot, RefreshStatus, error) {
	if s == nil {
		return nil, RefreshStatus{}, errors.New("catalog: store is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.snapshot != nil && now.Before(s.nextRefresh) {
		if s.degraded && now.After(s.refreshedAt.Add(s.maxStale)) {
			return nil, s.statusLocked(), fmt.Errorf("%w: %s", ErrStaleSnapshot, s.diagnostic)
		}
		return s.snapshot.Clone(), s.statusLocked(), nil
	}
	snapshot, err := s.builder.Build(ctx, s.source)
	if err == nil {
		s.snapshot = snapshot.Clone()
		s.refreshedAt = now
		s.nextRefresh = now.Add(s.refreshTTL)
		s.degraded = false
		s.diagnostic = ""
		return snapshot.Clone(), s.statusLocked(), nil
	}
	s.degraded = true
	s.diagnostic = "catalog refresh failed"
	s.nextRefresh = now.Add(s.refreshTTL)
	if s.snapshot == nil {
		return nil, s.statusLocked(), err
	}
	if now.After(s.refreshedAt.Add(s.maxStale)) {
		return nil, s.statusLocked(), fmt.Errorf("%w: %v", ErrStaleSnapshot, err)
	}
	if staleUntil := s.refreshedAt.Add(s.maxStale); s.nextRefresh.After(staleUntil) {
		s.nextRefresh = staleUntil
	}
	return s.snapshot.Clone(), s.statusLocked(), nil
}

func (s *Store) Status() RefreshStatus {
	if s == nil {
		return RefreshStatus{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Store) statusLocked() RefreshStatus {
	status := RefreshStatus{RefreshedAt: s.refreshedAt, Degraded: s.degraded, Diagnostic: s.diagnostic}
	if s.snapshot != nil {
		status.Generation = s.snapshot.Generation
		status.StaleUntil = s.refreshedAt.Add(s.maxStale)
	}
	return status
}

type FixedResolver struct{ Snapshot *Snapshot }

func (r FixedResolver) Current(context.Context) (*Snapshot, RefreshStatus, error) {
	if r.Snapshot == nil {
		return nil, RefreshStatus{}, ErrUnknownModel
	}
	return r.Snapshot.Clone(), RefreshStatus{Generation: r.Snapshot.Generation}, nil
}

func (s *Snapshot) ModelIDs() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.Models)+len(s.Combinations))
	for id := range s.Models {
		out = append(out, id)
	}
	for id := range s.Combinations {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

type StaticSource struct {
	AliasList       []Alias
	CombinationList []Combination
	Gen             uint64
}

func (s StaticSource) Load(context.Context) ([]Alias, []Combination, uint64, error) {
	aliases := append([]Alias(nil), s.AliasList...)
	combinations := make([]Combination, len(s.CombinationList))
	for i, combination := range s.CombinationList {
		combination.Members = append([]string(nil), combination.Members...)
		combinations[i] = combination
	}
	return aliases, combinations, s.Gen, nil
}
