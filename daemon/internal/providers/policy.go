package providers

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// PolicyAction describes a fixture-backed transformation of a known field.
type PolicyAction string

const (
	PolicyPreserve         PolicyAction = "preserve"
	PolicyTranslate        PolicyAction = "translate"
	PolicyClamp            PolicyAction = "clamp"
	PolicyStripNonsemantic PolicyAction = "strip-nonsemantic"
	PolicyReject           PolicyAction = "reject"
	PolicyPassthroughNative PolicyAction = "passthrough-native"
)

// PolicyRule is immutable operational metadata. Values and request content are
// deliberately absent; callers receive copies from Clone and RulesCopy.
type PolicyRule struct {
	ID       string
	RuleID   string
	Fixture  string
	FixtureRef string
	Action   PolicyAction
	Path     string
	Reason   string
}

func (r PolicyRule) valid() error {
	id := r.ID
	if id == "" { id = r.RuleID }
	fixture := r.Fixture
	if fixture == "" { fixture = r.FixtureRef }
	if r.ID != "" && r.RuleID != "" && r.ID != r.RuleID { return errors.New("provider policy rule id aliases disagree") }
	if r.Fixture != "" && r.FixtureRef != "" && r.Fixture != r.FixtureRef { return errors.New("provider policy fixture aliases disagree") }
	if strings.TrimSpace(id) == "" || len(id) > 128 {
		return errors.New("provider policy rule id is required and bounded")
	}
	if strings.TrimSpace(fixture) == "" || len(fixture) > 256 {
		return fmt.Errorf("provider policy rule %q requires a fixture reference", id)
	}
	switch r.Action {
	case PolicyPreserve, PolicyTranslate, PolicyClamp, PolicyStripNonsemantic, PolicyReject, PolicyPassthroughNative:
	default:
		return fmt.Errorf("provider policy rule %q has unknown action", id)
	}
	return nil
}

// ParameterMode controls a numeric/optional request parameter.
type ParameterMode string

const (
	ParameterPreserve   ParameterMode = "preserve"
	ParameterUnsupported ParameterMode = "unsupported"
	ParameterClamp      ParameterMode = "clamp"
	ParameterStrip      ParameterMode = "strip-nonsemantic"
)

type ParameterPolicy struct {
	Unsupported []string
	MaxOutput   int
	MaxInput    int
	Temperature ParameterMode
	TopP        ParameterMode
	Stop        ParameterMode
	Rules       []PolicyRule
}

// ToolKind remains distinct through planning and projection.
type ToolKind string

const (
	ToolFunction       ToolKind = "function"
	ToolCustom         ToolKind = "custom"
	ToolComputer       ToolKind = "computer"
	ToolHosted         ToolKind = "hosted"
	ToolServer         ToolKind = "server"
	ToolWebSearch      ToolKind = "web-search"
	ToolImage          ToolKind = "image"
	ToolMCP            ToolKind = "mcp"
	ToolProviderNative ToolKind = "provider-native"
)

type ToolArgumentMode string

const (
	ToolArgumentsObjectOrString ToolArgumentMode = "object-or-string"
	ToolArgumentsObject          ToolArgumentMode = "object"
	ToolArgumentsJSONString      ToolArgumentMode = "json-string"
)

type ToolPairingMode string

const (
	ToolPairingOptional  ToolPairingMode = "optional"
	ToolPairingRequired  ToolPairingMode = "required"
	ToolPairingContiguous ToolPairingMode = "contiguous"
)

type ToolPolicy struct {
	SupportedKinds []ToolKind
	Function       bool
	Custom         bool
	Computer       bool
	Hosted         bool
	Server         bool
	WebSearch      bool
	Image          bool
	MCP            bool
	ProviderNative bool
	RequireIDs     bool
	IDMaxBytes     int
	Arguments      ToolArgumentMode
	Pairing        ToolPairingMode
	Parallel       bool
	ResultImages   bool
	Rules          []PolicyRule
}

// ReasoningPolicy describes reasoning history and wire representation.
type ReasoningPolicy struct {
	Enabled          bool
	Formats          []string
	Efforts          []string
	RequireHistory   bool
	Encrypted        bool
	Summary          bool
	PreserveText     bool
	Rules            []PolicyRule
}

type MediaKind string

const (
	MediaImage    MediaKind = "image"
	MediaAudio    MediaKind = "audio"
	MediaDocument MediaKind = "document"
	MediaPDF      MediaKind = "pdf"
	MediaFile     MediaKind = "file"
)

type ReferenceKind string

const (
	ReferenceURL             ReferenceKind = "url"
	ReferenceInlineData      ReferenceKind = "inline-data"
	ReferenceProviderFileID  ReferenceKind = "provider-file-id"
	ReferenceProviderFileURL ReferenceKind = "provider-file-url"
)

type MediaCapability struct {
	Kind       MediaKind
	References []ReferenceKind
	MIMETypes  []string
	MaxBytes   int
	MaxItems   int
	Detail     []string
}

type LossyMediaPolicy struct {
	Allowed       bool
	Placeholder   string
	RuleID        string
	Fixture       string
	CurrentTurn   bool
	Historical    bool
}

type MediaPolicy struct {
	Kinds          []MediaKind
	References     []ReferenceKind
	MIMETypes      []string
	Capabilities   []MediaCapability
	Images         bool
	Audio          bool
	Documents      bool
	PDFs           bool
	Files          bool
	URLs           bool
	InlineData     bool
	ProviderFileIDs  bool
	ProviderFileURLs bool
	ToolResultMedia bool
	Loss           LossyMediaPolicy
	Rules          []PolicyRule
}

// ContextManagementPolicy is intentionally separate from remote compaction.
type ContextManagementPolicy struct {
	Supported       bool
	EditTypes       []string
	PreserveUnknown bool
	Rules           []PolicyRule
}

type StreamingPolicy struct {
	Supported             bool
	ForceUpstream         bool
	AssembleNonStreaming  bool
	MaxEvents             int
	MaxBytes              int
	CleanEOFAllowed       bool
	RequiresExplicitTerminal bool
	Rules                 []PolicyRule
}

type ResponsePolicy struct {
	AllowedExtensionFields []string
	RequiredFields         []string
	StripRuleID            string
	StripFixture           string
	PreserveSemantic       bool
	RejectRawProviderErrors bool
	Rules                  []PolicyRule
}

type PromptCachePolicy struct {
	Supported          bool
	Key                bool
	ExplicitBreakpoint bool
	MinPrefixBytes     int
	MarkerLocations    []string
	TTLs               []time.Duration
	Rules              []PolicyRule
}

type ContentCachePolicy struct {
	Supported bool
	MaxBytes  int
	TTL       time.Duration
	Rules     []PolicyRule
}

type ResponseCachePolicy struct {
	Supported bool
	MaxBytes  int
	TTL       time.Duration
	Streaming bool
	Rules     []PolicyRule
}

type CachePolicy struct {
	Prompt    PromptCachePolicy
	Transform ContentCachePolicy
	Response  ResponseCachePolicy
}

type HedgePolicy struct {
	Allowed          bool
	Delay            time.Duration
	MaxExtraAttempts int
	NoToolsOnly      bool
	PreCommitOnly    bool
	Rules            []PolicyRule
}

type ExecutionPolicy struct {
	LossyMedia LossyMediaPolicy
	Hedge      HedgePolicy
}

type EndpointPolicy struct {
	Supported             bool
	Path                  string
	RequiresStreaming     bool
	RequiresExplicitTerminal bool
	Rules                 []PolicyRule
}

type CompactionVersion string

const (
	CompactionNone CompactionVersion = ""
	CompactionV1   CompactionVersion = "v1"
	CompactionV2   CompactionVersion = "v2"
)

type RemoteCompactionPolicy struct {
	Versions              []CompactionVersion
	V1                    bool
	V2                    bool
	V1Endpoint            EndpointPolicy
	V2Endpoint            EndpointPolicy
	BridgeV1ToV2          bool
	BridgeV2ToV1          bool
	MaxInputBytes         int
	MaxRetainedTokens     int
	TrailingOutputRewrite bool
	Rules                 []PolicyRule
}

// CompatibilityPolicy is provider/model-owned immutable capability metadata.
// Constructors and accessors defensively copy every slice; policy values should
// be published as snapshots and never mutated after catalog activation.
type CompatibilityPolicy struct {
	Generation        uint64
	Parameters        ParameterPolicy
	Tools             ToolPolicy
	Reasoning         ReasoningPolicy
	Media             MediaPolicy
	ContextManagement ContextManagementPolicy
	Streaming         StreamingPolicy
	Response          ResponsePolicy
	Cache             CachePolicy
	Execution         ExecutionPolicy
	Compaction        RemoteCompactionPolicy
}

func NewCompatibilityPolicy(generation uint64) (CompatibilityPolicy, error) {
	if generation == 0 { return CompatibilityPolicy{}, errors.New("provider compatibility policy generation must be positive") }
	return CompatibilityPolicy{Generation: generation}, nil
}

func cloneRules(in []PolicyRule) []PolicyRule { return append([]PolicyRule(nil), in...) }
func cloneKinds(in []ToolKind) []ToolKind { return append([]ToolKind(nil), in...) }
func cloneMediaKinds(in []MediaKind) []MediaKind { return append([]MediaKind(nil), in...) }
func cloneRefs(in []ReferenceKind) []ReferenceKind { return append([]ReferenceKind(nil), in...) }
func cloneStrings(in []string) []string { return append([]string(nil), in...) }

func (p CompatibilityPolicy) Clone() CompatibilityPolicy {
	p.Parameters.Unsupported = cloneStrings(p.Parameters.Unsupported)
	p.Parameters.Rules = cloneRules(p.Parameters.Rules)
	p.Tools.SupportedKinds = cloneKinds(p.Tools.SupportedKinds)
	p.Tools.Rules = cloneRules(p.Tools.Rules)
	p.Reasoning.Formats, p.Reasoning.Efforts = cloneStrings(p.Reasoning.Formats), cloneStrings(p.Reasoning.Efforts)
	p.Reasoning.Rules = cloneRules(p.Reasoning.Rules)
	p.Media.Kinds, p.Media.References, p.Media.MIMETypes = cloneMediaKinds(p.Media.Kinds), cloneRefs(p.Media.References), cloneStrings(p.Media.MIMETypes)
	p.Media.Capabilities = append([]MediaCapability(nil), p.Media.Capabilities...)
	for i := range p.Media.Capabilities {
		p.Media.Capabilities[i].References = cloneRefs(p.Media.Capabilities[i].References)
		p.Media.Capabilities[i].MIMETypes = cloneStrings(p.Media.Capabilities[i].MIMETypes)
		p.Media.Capabilities[i].Detail = cloneStrings(p.Media.Capabilities[i].Detail)
	}
	p.Media.Rules = cloneRules(p.Media.Rules)
	p.ContextManagement.EditTypes, p.ContextManagement.Rules = cloneStrings(p.ContextManagement.EditTypes), cloneRules(p.ContextManagement.Rules)
	p.Streaming.Rules = cloneRules(p.Streaming.Rules)
	p.Response.AllowedExtensionFields, p.Response.RequiredFields = cloneStrings(p.Response.AllowedExtensionFields), cloneStrings(p.Response.RequiredFields)
	p.Response.Rules = cloneRules(p.Response.Rules)
	p.Cache.Prompt.MarkerLocations, p.Cache.Prompt.TTLs = cloneStrings(p.Cache.Prompt.MarkerLocations), append([]time.Duration(nil), p.Cache.Prompt.TTLs...)
	p.Cache.Prompt.Rules, p.Cache.Transform.Rules, p.Cache.Response.Rules = cloneRules(p.Cache.Prompt.Rules), cloneRules(p.Cache.Transform.Rules), cloneRules(p.Cache.Response.Rules)
	p.Execution.Hedge.Rules = cloneRules(p.Execution.Hedge.Rules)
	p.Compaction.Versions, p.Compaction.Rules = append([]CompactionVersion(nil), p.Compaction.Versions...), cloneRules(p.Compaction.Rules)
	p.Compaction.V1Endpoint.Rules, p.Compaction.V2Endpoint.Rules = cloneRules(p.Compaction.V1Endpoint.Rules), cloneRules(p.Compaction.V2Endpoint.Rules)
	return p
}

func clonePolicyPtr(policy *CompatibilityPolicy) *CompatibilityPolicy {
	if policy == nil {
		return nil
	}
	clone := policy.Clone()
	return &clone
}

func (p CompatibilityPolicy) RulesCopy() []PolicyRule {
	var out []PolicyRule
	groups := [][]PolicyRule{p.Parameters.Rules, p.Tools.Rules, p.Reasoning.Rules, p.Media.Rules, p.ContextManagement.Rules, p.Streaming.Rules, p.Response.Rules, p.Cache.Prompt.Rules, p.Cache.Transform.Rules, p.Cache.Response.Rules, p.Execution.Hedge.Rules, p.Compaction.Rules, p.Compaction.V1Endpoint.Rules, p.Compaction.V2Endpoint.Rules}
	for _, group := range groups { out = append(out, group...) }
	return cloneRules(out)
}

func validateRules(rules []PolicyRule, seen map[string]struct{}) error {
	for _, rule := range rules {
		if err := rule.valid(); err != nil { return err }
		id := rule.ID
		if id == "" { id = rule.RuleID }
		if _, exists := seen[id]; exists { return fmt.Errorf("provider policy rule %q is duplicated", id) }
		seen[id] = struct{}{}
	}
	return nil
}

func containsString(values []string, value string) bool { for _, v := range values { if v == value { return true } }; return false }
func containsKind(values []ToolKind, value ToolKind) bool { for _, v := range values { if v == value { return true } }; return false }
func containsMedia(values []MediaKind, value MediaKind) bool { for _, v := range values { if v == value { return true } }; return false }

// Validate rejects contradictory catalog data before activation.
func (p CompatibilityPolicy) Validate() error {
	if p.Generation == 0 { return errors.New("provider compatibility policy generation must be positive") }
	if p.Parameters.MaxOutput < 0 || p.Parameters.MaxInput < 0 { return errors.New("provider compatibility policy parameter limits must not be negative") }
	if p.Parameters.Temperature != "" && p.Parameters.Temperature != ParameterPreserve && p.Parameters.Temperature != ParameterUnsupported && p.Parameters.Temperature != ParameterClamp && p.Parameters.Temperature != ParameterStrip { return errors.New("provider compatibility policy temperature mode is invalid") }
	if p.Parameters.TopP != "" && p.Parameters.TopP != ParameterPreserve && p.Parameters.TopP != ParameterUnsupported && p.Parameters.TopP != ParameterClamp && p.Parameters.TopP != ParameterStrip { return errors.New("provider compatibility policy top-p mode is invalid") }
	if p.Tools.IDMaxBytes < 0 || (p.Tools.RequireIDs && p.Tools.IDMaxBytes == 0) { return errors.New("provider compatibility policy tool ID bound is invalid") }
	if p.Tools.Arguments != "" && p.Tools.Arguments != ToolArgumentsObjectOrString && p.Tools.Arguments != ToolArgumentsObject && p.Tools.Arguments != ToolArgumentsJSONString { return errors.New("provider compatibility policy tool argument mode is invalid") }
	if p.Tools.Pairing != "" && p.Tools.Pairing != ToolPairingOptional && p.Tools.Pairing != ToolPairingRequired && p.Tools.Pairing != ToolPairingContiguous { return errors.New("provider compatibility policy tool pairing mode is invalid") }
	for _, k := range p.Tools.SupportedKinds { if !containsKind([]ToolKind{ToolFunction,ToolCustom,ToolComputer,ToolHosted,ToolServer,ToolWebSearch,ToolImage,ToolMCP,ToolProviderNative}, k) { return fmt.Errorf("unknown tool kind %q", k) } }
	if !p.Reasoning.Enabled && (len(p.Reasoning.Formats) > 0 || p.Reasoning.RequireHistory || p.Reasoning.Encrypted || p.Reasoning.Summary) { return errors.New("reasoning details require reasoning capability") }
	if p.Streaming.MaxEvents < 0 || p.Streaming.MaxBytes < 0 { return errors.New("streaming bounds must not be negative") }
	if p.Streaming.ForceUpstream && (!p.Streaming.Supported || !p.Streaming.AssembleNonStreaming) { return errors.New("forced upstream streaming requires streaming and assembly") }
	if p.Response.StripRuleID != "" && p.Response.StripFixture == "" { return errors.New("response strip rule requires fixture") }
	for _, c := range p.Media.Capabilities { if c.MaxBytes < 0 || c.MaxItems < 0 { return errors.New("media bounds must not be negative") }; if !containsMedia([]MediaKind{MediaImage,MediaAudio,MediaDocument,MediaPDF,MediaFile}, c.Kind) { return fmt.Errorf("unknown media kind %q", c.Kind) } }
	if p.Media.Loss.Allowed && (p.Media.Loss.RuleID == "" || p.Media.Loss.Fixture == "") { return errors.New("lossy media policy requires stable rule and fixture") }
	if p.Cache.Prompt.MinPrefixBytes < 0 || p.Cache.Prompt.Supported && p.Cache.Prompt.MinPrefixBytes == 0 { return errors.New("prompt cache minimum prefix must be positive when supported") }
	if p.Cache.Prompt.ExplicitBreakpoint && !p.Cache.Prompt.Supported { return errors.New("explicit cache breakpoint requires prompt cache support") }
	if p.Cache.Transform.TTL < 0 || p.Cache.Response.TTL < 0 { return errors.New("cache TTL must not be negative") }
	if p.Execution.Hedge.Allowed && (p.Execution.Hedge.MaxExtraAttempts < 1 || p.Execution.Hedge.Delay < 0) { return errors.New("hedge policy bounds are invalid") }
	if p.Compaction.MaxInputBytes < 0 || p.Compaction.MaxRetainedTokens < 0 { return errors.New("compaction bounds must not be negative") }
	for _, v := range p.Compaction.Versions { if v != CompactionV1 && v != CompactionV2 { return fmt.Errorf("unknown compaction version %q", v) } }
	if p.Compaction.BridgeV1ToV2 && !(p.Compaction.V1 || containsCompaction(p.Compaction.Versions, CompactionV1)) && !(p.Compaction.V2 || containsCompaction(p.Compaction.Versions, CompactionV2)) { return errors.New("v1 to v2 bridge requires both versions") }
	if p.Compaction.BridgeV1ToV2 && !(p.Compaction.V1 || containsCompaction(p.Compaction.Versions, CompactionV1)) || p.Compaction.BridgeV1ToV2 && !(p.Compaction.V2 || containsCompaction(p.Compaction.Versions, CompactionV2)) { return errors.New("v1 to v2 bridge requires both versions") }
	if p.Compaction.BridgeV2ToV1 && !(p.Compaction.V1 || containsCompaction(p.Compaction.Versions, CompactionV1)) || p.Compaction.BridgeV2ToV1 && !(p.Compaction.V2 || containsCompaction(p.Compaction.Versions, CompactionV2)) { return errors.New("v2 to v1 bridge requires both versions") }
	seen := make(map[string]struct{}); groups := [][]PolicyRule{p.Parameters.Rules,p.Tools.Rules,p.Reasoning.Rules,p.Media.Rules,p.ContextManagement.Rules,p.Streaming.Rules,p.Response.Rules,p.Cache.Prompt.Rules,p.Cache.Transform.Rules,p.Cache.Response.Rules,p.Execution.Hedge.Rules,p.Compaction.Rules,p.Compaction.V1Endpoint.Rules,p.Compaction.V2Endpoint.Rules}
	for _, rules := range groups { if err := validateRules(rules, seen); err != nil { return err } }
	return nil
}
func containsCompaction(values []CompactionVersion, value CompactionVersion) bool { for _, v := range values { if v == value { return true } }; return false }

// LegacyCompatibilityPolicy converts the established boolean capability flags
// into typed facts. It is intentionally conservative and preserves behavior.
func LegacyCompatibilityPolicy(caps ProviderCaps) CompatibilityPolicy {
	p := CompatibilityPolicy{Generation: 1}
	p.Streaming.Supported = caps.Streaming
	p.Reasoning.Enabled = caps.Reasoning
	p.Tools.SupportedKinds = nil
	if caps.ToolCalls { p.Tools.SupportedKinds = []ToolKind{ToolFunction} }
	if caps.ToolCalls { p.Tools.SupportedKinds = []ToolKind{ToolFunction}; p.Tools.Function = true }
	if caps.Images { p.Media.Kinds = []MediaKind{MediaImage}; p.Media.Images = true; p.Media.References = []ReferenceKind{ReferenceURL, ReferenceInlineData, ReferenceProviderFileID, ReferenceProviderFileURL}; p.Media.URLs = true; p.Media.InlineData = true; p.Media.ProviderFileIDs = true; p.Media.ProviderFileURLs = true }
	if caps.Search { p.Tools.SupportedKinds = appendUniqueToolKinds(p.Tools.SupportedKinds, ToolWebSearch); p.Tools.WebSearch = true }
	p.Cache.Prompt.Supported = caps.ExplicitCache || caps.PromptCacheKey
	p.Cache.Prompt.Key = caps.PromptCacheKey
	p.Cache.Prompt.ExplicitBreakpoint = caps.ExplicitCache
	p.Cache.Prompt.MinPrefixBytes = 1
	return p
}

// mergeCompatibilityPolicies unions independent model capabilities while
// retaining the first non-zero scalar restriction. It is used only to build a
// provider aggregate; model-level planning uses EffectiveCompatibilityPolicy.
func mergeCompatibilityPolicies(base, extra CompatibilityPolicy) CompatibilityPolicy {
	if extra.Generation > base.Generation { base.Generation = extra.Generation }
	base.Tools.SupportedKinds = appendUniqueToolKinds(base.Tools.SupportedKinds, extra.Tools.SupportedKinds...)
	base.Tools.Function = base.Tools.Function || extra.Tools.Function
	base.Tools.Custom = base.Tools.Custom || extra.Tools.Custom
	base.Tools.Computer = base.Tools.Computer || extra.Tools.Computer
	base.Tools.Hosted = base.Tools.Hosted || extra.Tools.Hosted
	base.Tools.Server = base.Tools.Server || extra.Tools.Server
	base.Tools.WebSearch = base.Tools.WebSearch || extra.Tools.WebSearch
	base.Tools.Image = base.Tools.Image || extra.Tools.Image
	base.Tools.MCP = base.Tools.MCP || extra.Tools.MCP
	base.Tools.ProviderNative = base.Tools.ProviderNative || extra.Tools.ProviderNative
	base.Media.Kinds = appendUniqueMediaKinds(base.Media.Kinds, extra.Media.Kinds...)
	base.Media.References = appendUniqueRefs(base.Media.References, extra.Media.References...)
	base.Media.MIMETypes = appendUniqueStrings(base.Media.MIMETypes, extra.Media.MIMETypes...)
	base.Media.Images = base.Media.Images || extra.Media.Images
	base.Media.Audio = base.Media.Audio || extra.Media.Audio
	base.Media.Documents = base.Media.Documents || extra.Media.Documents
	base.Media.PDFs = base.Media.PDFs || extra.Media.PDFs
	base.Media.Files = base.Media.Files || extra.Media.Files
	base.Media.URLs = base.Media.URLs || extra.Media.URLs
	base.Media.InlineData = base.Media.InlineData || extra.Media.InlineData
	base.Media.ProviderFileIDs = base.Media.ProviderFileIDs || extra.Media.ProviderFileIDs
	base.Media.ProviderFileURLs = base.Media.ProviderFileURLs || extra.Media.ProviderFileURLs
	base.Reasoning.Enabled = base.Reasoning.Enabled || extra.Reasoning.Enabled
	base.Streaming.Supported = base.Streaming.Supported || extra.Streaming.Supported
	base.Streaming.ForceUpstream = base.Streaming.ForceUpstream || extra.Streaming.ForceUpstream
	base.Streaming.AssembleNonStreaming = base.Streaming.AssembleNonStreaming || extra.Streaming.AssembleNonStreaming
	base.Cache.Prompt.Supported = base.Cache.Prompt.Supported || extra.Cache.Prompt.Supported
	base.Cache.Prompt.Key = base.Cache.Prompt.Key || extra.Cache.Prompt.Key
	base.Cache.Prompt.ExplicitBreakpoint = base.Cache.Prompt.ExplicitBreakpoint || extra.Cache.Prompt.ExplicitBreakpoint
	if base.Cache.Prompt.MinPrefixBytes == 0 || extra.Cache.Prompt.MinPrefixBytes > 0 && extra.Cache.Prompt.MinPrefixBytes < base.Cache.Prompt.MinPrefixBytes { base.Cache.Prompt.MinPrefixBytes = extra.Cache.Prompt.MinPrefixBytes }
	base.Compaction.Versions = appendUniqueCompaction(base.Compaction.Versions, extra.Compaction.Versions...)
	base.Compaction.V1 = base.Compaction.V1 || extra.Compaction.V1
	base.Compaction.V2 = base.Compaction.V2 || extra.Compaction.V2
	base.Compaction.BridgeV1ToV2 = base.Compaction.BridgeV1ToV2 || extra.Compaction.BridgeV1ToV2
	base.Compaction.BridgeV2ToV1 = base.Compaction.BridgeV2ToV1 || extra.Compaction.BridgeV2ToV1
	return base
}
func appendUniqueToolKinds(base []ToolKind, values ...ToolKind) []ToolKind { for _, value := range values { if !containsKind(base,value) { base=append(base,value) } }; return base }
func appendUniqueMediaKinds(base []MediaKind, values ...MediaKind) []MediaKind { for _, value := range values { if !containsMedia(base,value) { base=append(base,value) } }; return base }
func appendUniqueRefs(base []ReferenceKind, values ...ReferenceKind) []ReferenceKind { for _, value := range values { if !containsRef(base,value) { base=append(base,value) } }; return base }
func appendUniqueStrings(base []string, values ...string) []string { for _, value := range values { if !containsString(base,value) { base=append(base,value) } }; return base }
func appendUniqueCompaction(base []CompactionVersion, values ...CompactionVersion) []CompactionVersion { for _, value := range values { if !containsCompaction(base,value) { base=append(base,value) } }; return base }

// EffectiveCompatibilityPolicy returns a defensive, typed view while accepting
// legacy capability records. Explicit typed fields override legacy defaults.
func EffectiveCompatibilityPolicy(caps ProviderCaps, model *ProviderModel) CompatibilityPolicy {
	p := LegacyCompatibilityPolicy(caps)
	if caps.Compatibility.Generation != 0 { p = caps.Compatibility.Clone() } else if caps.Policy.Generation != 0 { p = caps.Policy.Clone() }
	if model != nil {
		if model.Capabilities != nil { child := *model.Capabilities; if child.Compatibility.Generation != 0 || child.Policy.Generation != 0 { p = EffectiveCompatibilityPolicy(child, nil) } else { childPolicy := LegacyCompatibilityPolicy(child); childPolicy.Generation = p.Generation; p = childPolicy } }
		if model.Compatibility != nil { p = model.Compatibility.Clone() } else if model.Policy != nil { p = model.Policy.Clone() }
	}
	if p.Generation == 0 { p.Generation = 1 }
	return p
}
func mergeLegacyModel(base CompatibilityPolicy, caps ProviderCaps) CompatibilityPolicy {
	if caps.Streaming { base.Streaming.Supported = true }; if caps.Reasoning { base.Reasoning.Enabled = true }; if caps.ToolCalls && len(base.Tools.SupportedKinds)==0 { base.Tools.SupportedKinds=[]ToolKind{ToolFunction} }; if caps.Images && len(base.Media.Kinds)==0 { base.Media.Kinds=[]MediaKind{MediaImage} }; if caps.PromptCacheKey { base.Cache.Prompt.Key=true; base.Cache.Prompt.Supported=true }; if caps.ExplicitCache { base.Cache.Prompt.ExplicitBreakpoint=true; base.Cache.Prompt.Supported=true }; return base
}

func (p CompatibilityPolicy) SupportsToolKind(kind ToolKind) bool {
	if containsKind(p.Tools.SupportedKinds, kind) { return true }
	switch kind { case ToolFunction: return p.Tools.Function; case ToolCustom: return p.Tools.Custom; case ToolComputer: return p.Tools.Computer; case ToolHosted: return p.Tools.Hosted; case ToolServer: return p.Tools.Server; case ToolWebSearch: return p.Tools.WebSearch; case ToolImage: return p.Tools.Image; case ToolMCP: return p.Tools.MCP; case ToolProviderNative: return p.Tools.ProviderNative }
	return false
}
func (p CompatibilityPolicy) SupportsMedia(kind MediaKind, ref ReferenceKind, mime string) bool {
	kindSupported := containsMedia(p.Media.Kinds, kind)
	if !kindSupported {
		switch kind { case MediaImage: kindSupported=p.Media.Images; case MediaAudio: kindSupported=p.Media.Audio; case MediaDocument: kindSupported=p.Media.Documents; case MediaPDF: kindSupported=p.Media.PDFs; case MediaFile: kindSupported=p.Media.Files }
	}
	if !kindSupported { return false }
	if len(p.Media.References)>0 && !containsRef(p.Media.References, ref) { return false }
	if len(p.Media.References)==0 && (p.Media.URLs || p.Media.InlineData || p.Media.ProviderFileIDs || p.Media.ProviderFileURLs) { switch ref { case ReferenceURL: if !p.Media.URLs { return false }; case ReferenceInlineData: if !p.Media.InlineData { return false }; case ReferenceProviderFileID: if !p.Media.ProviderFileIDs { return false }; case ReferenceProviderFileURL: if !p.Media.ProviderFileURLs { return false } } }
	if len(p.Media.MIMETypes)>0 && !containsString(p.Media.MIMETypes, mime) { return false }; return true
}
func containsRef(values []ReferenceKind, value ReferenceKind) bool { for _, v := range values { if v == value { return true } }; return false }
func (p CompatibilityPolicy) SupportsCompaction(version CompactionVersion) bool { if containsCompaction(p.Compaction.Versions, version) { return true }; if version == CompactionV1 { return p.Compaction.V1 }; if version == CompactionV2 { return p.Compaction.V2 }; return false }

// PolicyGeneration is the activation unit retained during degraded refresh.
type PolicyGeneration struct { Generation uint64; Policy CompatibilityPolicy }
func (g PolicyGeneration) Validate() error { if g.Generation == 0 || g.Policy.Generation != g.Generation { return errors.New("provider policy generation mismatch") }; return g.Policy.Validate() }
func ValidatePolicyGeneration(previous, current PolicyGeneration) error { if err:=current.Validate(); err!=nil{return err}; if previous.Generation>current.Generation{return errors.New("provider policy generation rollback")}; return nil }
func RetainLastValidPolicy(previous *PolicyGeneration, candidate PolicyGeneration) (PolicyGeneration, error) { if err:=ValidatePolicyGeneration(func() PolicyGeneration { if previous==nil{return PolicyGeneration{}}; return *previous }(), candidate); err!=nil { if previous!=nil{return *previous, err}; return PolicyGeneration{}, err }; return PolicyGeneration{Generation:candidate.Generation, Policy:candidate.Policy.Clone()}, nil }

// RetainLastValidGeneration is the value-oriented form used by catalog
// refreshers that keep the active generation outside this package.
func RetainLastValidGeneration(previous, candidate PolicyGeneration) (PolicyGeneration, error) {
	return RetainLastValidPolicy(&previous, candidate)
}
func (p CompatibilityPolicy) Frozen() CompatibilityPolicy { return p.Clone() }

// CapabilityError is a bounded, stable pre-dispatch capability failure.
type CapabilityError struct { Code string; SourceSurface Surface; Operation string; Feature string; Model string; Requested string; Alternatives []string }
func (e *CapabilityError) Error() string { if e==nil{return ""}; return string(e.Code)+": unsupported "+e.Feature }
func (e *CapabilityError) Validate() error {
	if e == nil || strings.TrimSpace(e.Code) == "" || len(e.Code) > 128 { return errors.New("capability error code is required and bounded") }
	if len(e.Model) > 128 || len(e.Feature) > 128 || len(e.Requested) > 256 || len(e.Alternatives) > 8 { return errors.New("capability error detail is oversized") }
	return nil
}
func (e CapabilityError) Clone() CapabilityError { e.Alternatives=append([]string(nil),e.Alternatives...); return e }
const (
	CapabilityToolKindUnsupported = "capability.tool_kind_unsupported"
	CapabilityToolIDUnsupported = "capability.tool_id_unsupported"
	CapabilityMediaUnsupported = "capability.media_unsupported"
	CapabilityMediaReferenceUnsupported = "capability.media_reference_unsupported"
	CapabilityMediaMIMEUnsupported = "capability.media_mime_unsupported"
	CapabilityDocumentUnsupported = "capability.document_unsupported"
	CapabilityRemoteCompactionV1Unsupported = "capability.remote_compaction_v1_unsupported"
	CapabilityRemoteCompactionV2Unsupported = "capability.remote_compaction_v2_unsupported"
	CapabilityRemoteCompactionBridgeUnsupported = "capability.remote_compaction_bridge_unsupported"
	CapabilityContextManagementUnsupported = "capability.context_management_unsupported"
	CapabilityStreamingUnsupported = "capability.streaming_unsupported"
	CapabilityParameterUnsupported = "capability.parameter_unsupported"
	CapabilityReasoningUnsupported = "capability.reasoning_unsupported"
)

func NewCapabilityError(code, feature string, surface Surface, operation, model, requested string, alternatives []string) *CapabilityError { out:=&CapabilityError{Code:code,Feature:feature,SourceSurface:surface,Operation:operation,Model:model,Requested:requested,Alternatives:append([]string(nil),alternatives...)}; sort.Strings(out.Alternatives); if len(out.Alternatives)>8 { out.Alternatives=out.Alternatives[:8] }; return out }
