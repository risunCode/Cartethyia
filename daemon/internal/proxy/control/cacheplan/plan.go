package cacheplan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

// Protocol is the canonical provider wire protocol. Cache behavior is
// selected by protocol because OpenAI-compatible providers share the same
// usage/cache contract; it is not duplicated per provider id.
type Protocol = providers.Protocol

const (
	ProtocolOpenAI    = providers.ProtocolOpenAI
	ProtocolAnthropic = providers.ProtocolAnthropic

	// Anthropic's prompt-cache TTLs are provider policy, not resolution-cache
	// TTLs. The default is the five-minute policy.
	AnthropicTTL5Minutes  = 300
	AnthropicTTL1Hour     = 3600
	DefaultTTLSeconds     = AnthropicTTL5Minutes
	AnthropicProviderMode = "anthropic-prompt-cache"
)

// Stable error codes are package-prefixed machine-readable classifications.
const (
	CodeRequestRequired       = "cacheplan.request_required"
	CodeUnsupportedProtocol   = "cacheplan.unsupported_protocol"
	CodeInvalidTTL            = "cacheplan.invalid_ttl"
	CodeInvalidBoundary       = "cacheplan.invalid_boundary"
	CodeInvalidUsage          = "cacheplan.invalid_usage"
	CodeInvalidRequest        = "cacheplan.invalid_request"
	CodeTooManyBreakpoints    = "cacheplan.too_many_breakpoints"
	CodeUnsupportedCapability = "cacheplan.unsupported_capability"
	CodePolicyRequired        = "cacheplan.policy_required"
	CodeTooShortPrefix        = "cacheplan.too_short_prefix"
	CodeVolatileBoundary      = "cacheplan.volatile_boundary"
)

var (
	ErrRequestRequired       = errors.New(CodeRequestRequired)
	ErrUnsupportedProtocol   = errors.New(CodeUnsupportedProtocol)
	ErrInvalidTTL            = errors.New(CodeInvalidTTL)
	ErrInvalidBoundary       = errors.New(CodeInvalidBoundary)
	ErrInvalidUsage          = errors.New(CodeInvalidUsage)
	ErrInvalidRequest        = errors.New(CodeInvalidRequest)
	ErrTooManyBreakpoints    = errors.New(CodeTooManyBreakpoints)
	ErrUnsupportedCapability = errors.New(CodeUnsupportedCapability)
	ErrPolicyRequired        = errors.New(CodePolicyRequired)
	ErrTooShortPrefix        = errors.New(CodeTooShortPrefix)
	ErrVolatileBoundary      = errors.New(CodeVolatileBoundary)
)

// Error is a typed cache planning error. Code remains stable while Reason is
// bounded diagnostic text and never includes prompt content.
type Error struct {
	Code   string
	Reason string
	Cause  error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.Reason == "" {
		return e.Code
	}
	return e.Code + ": " + e.Reason
}
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}
func cacheError(code string, cause error, reason string) error {
	return &Error{Code: code, Cause: cause, Reason: reason}
}

// BoundaryKind identifies a native Anthropic location that can carry a
// cache_control marker. Tool boundaries are represented in the plan even
// though normalized Tool has no marker field; the provider renderer owns that
// wire-only detail.
type BoundaryKind string

const (
	BoundarySystem  BoundaryKind = "system"
	BoundaryTools   BoundaryKind = "tools"
	BoundaryMessage BoundaryKind = "message"
)

// Breakpoint is a deterministic provider-neutral location for an Anthropic
// cache breakpoint. Non-applicable indexes are -1.
type Breakpoint struct {
	Kind         BoundaryKind
	MessageIndex int
	BlockIndex   int
	ToolIndex    int
	TTLSeconds   int
}

// PlanOptions controls provider prompt-cache planning. It intentionally does
// not contain runtime Redis/resolution-cache settings.
type PlanOptions struct {
	TTLSeconds int
}

// Intent is the provider prompt-cache intent. Supported indicates that the
// selected provider capability exists; Eligible indicates that this request
// has a safe native boundary. An ineligible intent is a documented safe
// bypass when no boundary exists; invalid explicit boundaries return an error.
type Intent struct {
	Protocol     Protocol
	StablePrefix string
	CacheKey     string
	Supported    bool
	Eligible     bool
	Fingerprint  string
	ProviderMode string
	Breakpoints  []Breakpoint
	TTLSeconds   int
	TTL          string
	MarkerLast   bool

	DisabledCode   string
	DisabledReason string
}

// FinalWireRequest is the last provider target-wire tree before marshaling.
// Payload is intentionally a JSON tree, not provider-specific request types;
// this keeps cache planning after every lossy/lossless transform. TenantID is
// an opaque scope supplied by the runtime and is never included in diagnostics.
type FinalWireRequest struct {
	Protocol         Protocol
	Surface          string
	ProviderID       string
	ModelID          string
	TenantID         string
	PolicyGeneration uint64
	Payload          map[string]any
}

// TargetWireRequest and WireRequest are descriptive aliases for integrations
// that use those names for the final target tree.
type TargetWireRequest = FinalWireRequest
type WireRequest = FinalWireRequest

// PlanFinalWire computes prompt-cache identity and, when explicitly allowed
// by policy, renders the provider marker on the final stable boundary. Safe
// bypasses are returned as an Intent with DisabledCode and no error; malformed
// request trees still return a typed error. The payload is mutated only for
// provider marker/key fields and must be marshaled by the caller afterwards.
func PlanFinalWire(req *FinalWireRequest, policy providers.CompatibilityPolicy) (Intent, error) {
	if req == nil || req.Payload == nil {
		return Intent{}, cacheError(CodeRequestRequired, ErrRequestRequired, "final target-wire request is required")
	}
	if req.Protocol != ProtocolOpenAI && req.Protocol != ProtocolAnthropic {
		return Intent{}, cacheError(CodeUnsupportedProtocol, ErrUnsupportedProtocol, "protocol is not cache-plan capable")
	}
	prompt := policy.Cache.Prompt
	intent := Intent{Protocol: req.Protocol, Supported: prompt.Supported, MarkerLast: true}
	if policy.Generation == 0 && promptPolicyAbsent(prompt) {
		intent.DisabledCode = CodePolicyRequired
		intent.DisabledReason = "provider/model cache policy is absent"
		return intent, nil
	}
	if !prompt.Supported || (!prompt.Key && !prompt.ExplicitBreakpoint) {
		intent.DisabledCode = CodeUnsupportedCapability
		intent.DisabledReason = "provider/model policy does not support prompt caching"
		return intent, nil
	}
	ttl, ttlName, ok := promptTTL(req.Protocol, prompt)
	if !ok {
		intent.DisabledCode = CodeInvalidTTL
		intent.DisabledReason = "provider/model prompt-cache TTL is invalid"
		return intent, nil
	}
	intent.TTLSeconds, intent.TTL = ttl, ttlName
	stable, boundary, volatile := wireStablePrefix(req.Protocol, req.Surface, req.Payload)
	if len(stable) == 0 {
		intent.DisabledCode = CodeInvalidBoundary
		intent.DisabledReason = "final target-wire request has no stable cache boundary"
		return intent, nil
	}
	intent.StablePrefix = string(stable)
	identity := make([]byte, 0, len(stable)+128)
	writePartBytes(&identity, "cacheplan-v2")
	writePartBytes(&identity, req.ProviderID)
	writePartBytes(&identity, req.ModelID)
	writePartBytes(&identity, req.TenantID)
	writePartBytes(&identity, strconv.FormatUint(req.PolicyGeneration, 10))
	if supplied, ok := req.Payload["prompt_cache_key"].(string); ok {
		supplied = strings.TrimSpace(supplied)
		if supplied != "" && !strings.HasPrefix(supplied, "cartethyia:") {
			writePartBytes(&identity, supplied)
		}
	}
	identity = append(identity, stable...)
	sum := sha256.Sum256(identity)
	intent.Fingerprint = hex.EncodeToString(sum[:])
	intent.CacheKey = "cartethyia:" + intent.Fingerprint
	minBytes := prompt.MinPrefixBytes
	if minBytes < 0 {
		minBytes = 0
	}
	if len(stable) < minBytes {
		intent.DisabledCode = CodeTooShortPrefix
		intent.DisabledReason = "stable cache prefix is shorter than provider minimum"
		return intent, nil
	}
	if volatile && boundary == nil {
		intent.DisabledCode = CodeVolatileBoundary
		intent.DisabledReason = "volatile content occurs before a cacheable boundary"
		return intent, nil
	}
	intent.Eligible = true
	if prompt.Key && req.Protocol == ProtocolOpenAI {
		req.Payload["prompt_cache_key"] = intent.CacheKey
	}
	if prompt.ExplicitBreakpoint {
		if boundary == nil || !markerLocationAllowed(prompt.MarkerLocations, boundary.kind) || !renderFinalMarker(req.Protocol, req.Surface, req.Payload, boundary, ttl) {
			intent.Eligible = false
			intent.DisabledCode = CodeInvalidBoundary
			intent.DisabledReason = "provider marker has no valid final stable boundary"
			return intent, nil
		}
		intent.Breakpoints = []Breakpoint{{Kind: boundary.kind, MessageIndex: boundary.messageIndex, BlockIndex: boundary.blockIndex, ToolIndex: boundary.toolIndex, TTLSeconds: ttl}}
	}
	return intent, nil
}

func markerLocationAllowed(locations []string, kind BoundaryKind) bool {
	if len(locations) == 0 {
		return true
	}
	for _, location := range locations {
		if strings.EqualFold(strings.TrimSpace(location), string(kind)) {
			return true
		}
	}
	return false
}

func promptPolicyAbsent(policy providers.PromptCachePolicy) bool {
	return !policy.Supported && !policy.Key && !policy.ExplicitBreakpoint && policy.MinPrefixBytes == 0 && len(policy.MarkerLocations) == 0 && len(policy.TTLs) == 0 && len(policy.Rules) == 0
}

// PlanWire is the short name used by adapter integrations.
func PlanWire(req *FinalWireRequest, policy providers.CompatibilityPolicy) (Intent, error) {
	return PlanFinalWire(req, policy)
}

// PlanFinalWireWithPromptPolicy adapts the provider/model prompt policy while
// keeping generation explicit for callers that do not retain the full policy.
func PlanFinalWireWithPromptPolicy(req *FinalWireRequest, policy providers.PromptCachePolicy, generation uint64) (Intent, error) {
	return PlanFinalWire(req, providers.CompatibilityPolicy{Generation: generation, Cache: providers.CachePolicy{Prompt: policy}})
}

func PlanTargetWire(req *FinalWireRequest, policy providers.CompatibilityPolicy) (Intent, error) {
	return PlanFinalWire(req, policy)
}

func promptTTL(protocol Protocol, policy providers.PromptCachePolicy) (int, string, bool) {
	if protocol == ProtocolOpenAI {
		if len(policy.TTLs) > 0 {
			return 0, "", false
		}
		return 0, "", true
	}
	if len(policy.TTLs) == 0 {
		return DefaultTTLSeconds, ttlName(DefaultTTLSeconds), true
	}
	selected := 0
	for _, ttl := range policy.TTLs {
		seconds := int(ttl / time.Second)
		if ttl <= 0 || ttl != time.Duration(seconds)*time.Second || (seconds != AnthropicTTL5Minutes && seconds != AnthropicTTL1Hour) {
			return 0, "", false
		}
		if selected == 0 || seconds == AnthropicTTL5Minutes {
			selected = seconds
		}
	}
	if selected == 0 {
		return 0, "", false
	}
	return selected, ttlName(selected), true
}

func writePartBytes(dst *[]byte, value string) {
	*dst = append(*dst, strconv.Itoa(len(value))...)
	*dst = append(*dst, ':')
	*dst = append(*dst, value...)
	*dst = append(*dst, '|')
}

type wireBoundary struct {
	kind         BoundaryKind
	messageIndex int
	blockIndex   int
	toolIndex    int
	container    any
}

func wireStablePrefix(protocol Protocol, surface string, payload map[string]any) ([]byte, *wireBoundary, bool) {
	stable := map[string]any{}
	var boundary *wireBoundary
	volatile := false
	if protocol == ProtocolAnthropic {
		if system, ok := wireSlice(payload["system"]); ok {
			prefix := make([]any, 0, len(system))
			for i, raw := range system {
				block, ok := raw.(map[string]any)
				if !ok {
					volatile = true
					break
				}
				text, _ := block["text"].(string)
				if text == "" || containsVolatile(text) {
					volatile = true
					break
				}
				prefix = append(prefix, block)
				boundary = &wireBoundary{kind: BoundarySystem, messageIndex: -1, blockIndex: i, toolIndex: -1, container: system}
			}
			if len(prefix) > 0 {
				stable["system"] = prefix
			}
		}
		if !volatile {
			if tools, ok := wireSlice(payload["tools"]); ok && len(tools) > 0 {
				stable["tools"] = payload["tools"]
				for i := len(tools) - 1; i >= 0; i-- {
					if tool, ok := tools[i].(map[string]any); ok && tool["name"] != nil {
						boundary = &wireBoundary{kind: BoundaryTools, messageIndex: -1, blockIndex: -1, toolIndex: i, container: tools}
						break
					}
				}
			}
		}
		if !volatile {
			if messages, ok := wireSlice(payload["messages"]); ok {
				prefix := make([]any, 0, len(messages))
				for i, raw := range messages {
					message, ok := raw.(map[string]any)
					if !ok {
						volatile = true
						break
					}
					role, _ := message["role"].(string)
					if role != "user" {
						break
					}
					blocks, ok := wireSlice(message["content"])
					if !ok {
						volatile = true
						break
					}
					stableBlocks := make([]any, 0, len(blocks))
					for j, blockRaw := range blocks {
						block, ok := blockRaw.(map[string]any)
						if !ok {
							volatile = true
							break
						}
						text, _ := block["text"].(string)
						if text == "" || containsVolatile(text) {
							volatile = true
							break
						}
						stableBlocks = append(stableBlocks, block)
						boundary = &wireBoundary{kind: BoundaryMessage, messageIndex: i, blockIndex: j, toolIndex: -1, container: blocks}
					}
					if len(stableBlocks) > 0 {
						prefix = append(prefix, map[string]any{"role": role, "content": stableBlocks})
					}
					if volatile {
						break
					}
				}
				if len(prefix) > 0 {
					stable["messages"] = prefix
				}
			}
		}
	} else {
		if tools, ok := payload["tools"]; ok {
			stable["tools"] = tools
		}
		field := "messages"
		if strings.Contains(strings.ToLower(surface), "response") {
			field = "input"
			if instructions, ok := payload["instructions"]; ok {
				stable["instructions"] = instructions
			}
		}
		if items, ok := wireSlice(payload[field]); ok {
			prefix := make([]any, 0, len(items))
			for i, raw := range items {
				record, ok := raw.(map[string]any)
				if !ok {
					if wireValueVolatile(raw) {
						volatile = true
						break
					}
					prefix = append(prefix, raw)
					continue
				}
				role, _ := record["role"].(string)
				if role != "system" && role != "developer" {
					break
				}
				if wireValueVolatile(record) {
					volatile = true
					break
				}
				prefix = append(prefix, record)
				boundary = &wireBoundary{kind: BoundarySystem, messageIndex: i, blockIndex: -1, toolIndex: -1, container: items}
			}
			if len(prefix) > 0 {
				stable[field] = prefix
			}
		}
	}
	encoded, _ := json.Marshal(stable)
	return encoded, boundary, volatile
}

func wireSlice(value any) ([]any, bool) {
	switch values := value.(type) {
	case []any:
		return values, true
	case []map[string]any:
		out := make([]any, len(values))
		for i := range values {
			out[i] = values[i]
		}
		return out, true
	default:
		return nil, false
	}
}

func wireValueVolatile(value any) bool {
	switch current := value.(type) {
	case string:
		return containsVolatile(current)
	case map[string]any:
		for _, child := range current {
			if wireValueVolatile(child) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if wireValueVolatile(child) {
				return true
			}
		}
	case []map[string]any:
		for _, child := range current {
			if wireValueVolatile(child) {
				return true
			}
		}
	}
	return false
}

func renderFinalMarker(protocol Protocol, surface string, payload map[string]any, boundary *wireBoundary, ttl int) bool {
	marker := map[string]any{"type": "ephemeral"}
	if protocol == ProtocolAnthropic && ttl == AnthropicTTL1Hour {
		marker["ttl"] = "1h"
	}
	if protocol == ProtocolAnthropic {
		if boundary.kind == BoundaryTools {
			tools, ok := wireSlice(boundary.container)
			if !ok || boundary.toolIndex < 0 || boundary.toolIndex >= len(tools) {
				return false
			}
			tool, ok := tools[boundary.toolIndex].(map[string]any)
			if !ok {
				return false
			}
			tool["cache_control"] = marker
			return true
		}
		if boundary.kind == BoundarySystem {
			blocks, ok := wireSlice(boundary.container)
			if !ok || boundary.blockIndex < 0 || boundary.blockIndex >= len(blocks) {
				return false
			}
			block, ok := blocks[boundary.blockIndex].(map[string]any)
			if !ok {
				return false
			}
			block["cache_control"] = marker
			return true
		}
		messages, ok := wireSlice(payload["messages"])
		if !ok || boundary.messageIndex < 0 || boundary.messageIndex >= len(messages) {
			return false
		}
		message, ok := messages[boundary.messageIndex].(map[string]any)
		if !ok {
			return false
		}
		blocks, ok := wireSlice(message["content"])
		if !ok || boundary.blockIndex < 0 || boundary.blockIndex >= len(blocks) {
			return false
		}
		block, ok := blocks[boundary.blockIndex].(map[string]any)
		if !ok {
			return false
		}
		block["cache_control"] = marker
		return true
	}
	if strings.Contains(strings.ToLower(surface), "response") {
		items, ok := wireSlice(payload["input"])
		if !ok || boundary.messageIndex < 0 || boundary.messageIndex >= len(items) {
			return false
		}
		record, ok := items[boundary.messageIndex].(map[string]any)
		if !ok {
			return false
		}
		content, ok := wireSlice(record["content"])
		if !ok {
			text, ok := record["content"].(string)
			if !ok || text == "" {
				return false
			}
			record["content"] = []any{map[string]any{"type": "input_text", "text": text, "prompt_cache_breakpoint": map[string]any{"mode": "explicit"}}}
			payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
			return true
		}
		for i := len(content) - 1; i >= 0; i-- {
			block, ok := content[i].(map[string]any)
			if ok {
				if _, exists := block["text"]; exists {
					block["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
					payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
					return true
				}
			}
		}
		return false
	}
	items, ok := wireSlice(payload["messages"])
	if !ok || boundary.messageIndex < 0 || boundary.messageIndex >= len(items) {
		return false
	}
	record, ok := items[boundary.messageIndex].(map[string]any)
	if !ok {
		return false
	}
	content, ok := wireSlice(record["content"])
	if !ok {
		text, ok := record["content"].(string)
		if !ok || text == "" {
			return false
		}
		record["content"] = []any{map[string]any{"type": "text", "text": text, "prompt_cache_breakpoint": map[string]any{"mode": "explicit"}}}
		payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
		return true
	}
	for i := len(content) - 1; i >= 0; i-- {
		block, ok := content[i].(map[string]any)
		if ok {
			if _, exists := block["text"]; exists {
				block["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
				payload["prompt_cache_options"] = map[string]any{"mode": "explicit"}
				return true
			}
		}
	}
	return false
}

// Usage preserves provider evidence. A nil field means the provider omitted
// that field (unknown); zero is never fabricated for a missing value.
type Usage struct {
	Read   *int64
	Write  *int64
	Source string

	// CreationByTTL contains only TTL breakdowns actually supplied by
	// Anthropic, keyed by "5m" or "1h".
	CreationByTTL map[string]*int64
	Creation5m    *int64
	Creation1h    *int64
}

// CacheIntent is the design-level name for an Intent. Keeping the alias here
// lets callers use the provider-neutral contract name without introducing a
// second cache abstraction.
type CacheIntent = Intent

// Plan uses the default provider prompt-cache policy.
func Plan(protocol Protocol, req *transforms.NormalizedRequest, supported bool) (Intent, error) {
	return PlanWithOptions(protocol, req, supported, PlanOptions{})
}

// PlanWithOptions is Plan with an explicit provider TTL policy. TTL is an
// Anthropic-only field; OpenAI prompt-cache requests do not receive an
// Anthropic TTL by accident.
func PlanWithOptions(protocol Protocol, req *transforms.NormalizedRequest, supported bool, options PlanOptions) (Intent, error) {
	if req == nil {
		return Intent{}, cacheError(CodeRequestRequired, ErrRequestRequired, "request is required")
	}
	if protocol != ProtocolOpenAI && protocol != ProtocolAnthropic {
		return Intent{}, cacheError(CodeUnsupportedProtocol, ErrUnsupportedProtocol, "protocol is not cache-plan capable")
	}
	if protocol == ProtocolAnthropic {
		ttl, err := normalizeTTL(options.TTLSeconds)
		if err != nil {
			return Intent{}, err
		}
		if !supported {
			return Intent{
				Protocol:       protocol,
				DisabledCode:   CodeUnsupportedCapability,
				DisabledReason: "provider capability does not support prompt caching",
			}, nil
		}
		return planAnthropic(req, ttl)
	}
	if options.TTLSeconds != 0 {
		return Intent{}, cacheError(CodeInvalidTTL, ErrInvalidTTL, "OpenAI prompt cache does not accept Anthropic TTL values")
	}
	if !supported {
		return Intent{
			Protocol:       protocol,
			DisabledCode:   CodeUnsupportedCapability,
			DisabledReason: "selected model capability does not support OpenAI prompt caching",
		}, nil
	}
	return planOpenAI(req)
}

// PlanOpenAI is the explicit OpenAI entry point. The supported argument must
// be derived from the selected provider/model capability, not a runtime Redis
// or memory-cache setting.
func PlanOpenAI(req *transforms.NormalizedRequest, supported bool) (Intent, error) {
	return Plan(ProtocolOpenAI, req, supported)
}

// planOpenAI computes the provider-neutral stable prefix. OpenAI's prompt
// cache key is safe for every model whose capability advertises prompt
// caching; explicit breakpoint fields are restricted to models that declare
// that extension (GPT-5.6 and later, matching the existing wire convention).
func planOpenAI(req *transforms.NormalizedRequest) (Intent, error) {
	prefix, point, hasPrefix, err := openAIStablePrefix(req)
	if err != nil {
		return Intent{}, err
	}
	intent := Intent{
		Protocol:     ProtocolOpenAI,
		StablePrefix: prefix,
		Supported:    true,
		ProviderMode: "openai-prompt-cache",
		MarkerLast:   true,
	}
	if !hasPrefix {
		intent.DisabledCode = CodeInvalidBoundary
		intent.DisabledReason = "request has no stable cacheable prefix"
		return intent, nil
	}
	sum := sha256.Sum256([]byte(prefix))
	intent.Fingerprint = hex.EncodeToString(sum[:])
	intent.CacheKey = req.CacheKey
	if intent.CacheKey == "" {
		intent.CacheKey = intent.Fingerprint
	}
	intent.Eligible = true
	if SupportsOpenAIPromptBreakpoints(req.Model) && point.MessageIndex >= 0 {
		intent.Breakpoints = []Breakpoint{point}
	}
	return intent, nil
}

func PlanAnthropic(req *transforms.NormalizedRequest, supported bool) (Intent, error) {
	return Plan(ProtocolAnthropic, req, supported)
}
func PlanAnthropicWithTTL(req *transforms.NormalizedRequest, supported bool, ttlSeconds int) (Intent, error) {
	return PlanWithOptions(ProtocolAnthropic, req, supported, PlanOptions{TTLSeconds: ttlSeconds})
}

func normalizeTTL(seconds int) (int, error) {
	if seconds == 0 {
		return DefaultTTLSeconds, nil
	}
	if seconds != AnthropicTTL5Minutes && seconds != AnthropicTTL1Hour {
		return 0, cacheError(CodeInvalidTTL, ErrInvalidTTL, "ttl must be 300 or 3600 seconds")
	}
	return seconds, nil
}
func ttlName(seconds int) string {
	if seconds == AnthropicTTL1Hour {
		return "1h"
	}
	return "5m"
}

func planAnthropic(req *transforms.NormalizedRequest, ttl int) (Intent, error) {
	intent := Intent{
		Protocol:     ProtocolAnthropic,
		Supported:    true,
		ProviderMode: AnthropicProviderMode,
		TTLSeconds:   ttl,
		TTL:          ttlName(ttl),
		MarkerLast:   true,
	}
	prefix := anthropicStablePrefix(req)
	intent.StablePrefix = prefix
	sum := sha256.Sum256([]byte(prefix))
	intent.Fingerprint = hex.EncodeToString(sum[:])
	intent.CacheKey = req.CacheKey
	if intent.CacheKey == "" {
		intent.CacheKey = intent.Fingerprint
	}

	breakpoints, reason, code := anthropicBreakpoints(req, ttl)
	if code != "" {
		intent.DisabledCode = code
		intent.DisabledReason = reason
		intent.Breakpoints = nil
		intent.CacheKey = ""
		var sentinel error = ErrInvalidBoundary
		if code == CodeTooManyBreakpoints {
			sentinel = ErrTooManyBreakpoints
		}
		return intent, cacheError(code, sentinel, reason)
	}
	if len(breakpoints) == 0 {
		intent.DisabledCode = CodeInvalidBoundary
		intent.DisabledReason = "request has no cacheable system, tool, or message boundary"
		intent.CacheKey = ""
		return intent, nil
	}
	intent.Breakpoints = breakpoints
	intent.Eligible = true
	return intent, nil
}

// anthropicBreakpoints uses explicit transformed markers when present. If no
// marker is present, it derives at most one safe breakpoint per wire section.
// It never mutates req: provider marker rendering must be the final transform
// stage, after all lossy/lossless transforms have completed.
func anthropicBreakpoints(req *transforms.NormalizedRequest, ttl int) ([]Breakpoint, string, string) {
	explicit := make([]Breakpoint, 0, 4)
	for messageIndex, message := range req.Messages {
		for blockIndex, block := range message.Content {
			if block.CacheControl == "" {
				continue
			}
			if block.CacheControl != "ephemeral" {
				return nil, "cache marker uses an unsupported policy", CodeInvalidBoundary
			}
			if message.Role != transforms.RoleSystem && message.Role != transforms.RoleDeveloper && message.Role != transforms.RoleUser {
				return nil, "cache marker is not at a system or user message boundary", CodeInvalidBoundary
			}
			if block.Type != transforms.BlockText || block.Text == "" || containsVolatile(block.Text) {
				return nil, "cache marker is not on stable text", CodeInvalidBoundary
			}
			explicit = append(explicit, Breakpoint{Kind: boundaryForRole(message.Role), MessageIndex: messageIndex, BlockIndex: blockIndex, ToolIndex: -1, TTLSeconds: ttl})
		}
	}
	if len(explicit) > 0 {
		if len(explicit) > 4 {
			return nil, "request exceeds Anthropic's four-breakpoint limit", CodeTooManyBreakpoints
		}
		return explicit, "", ""
	}

	breakpoints := make([]Breakpoint, 0, 3)
	for messageIndex, message := range req.Messages {
		if message.Role != transforms.RoleSystem && message.Role != transforms.RoleDeveloper {
			continue
		}
		for blockIndex, block := range message.Content {
			if block.Type != transforms.BlockText || block.Text == "" || containsVolatile(block.Text) {
				return nil, "system cache boundary contains non-stable content", CodeInvalidBoundary
			}
			breakpoints = appendOrReplaceSectionBreakpoint(breakpoints, Breakpoint{Kind: BoundarySystem, MessageIndex: messageIndex, BlockIndex: blockIndex, ToolIndex: -1, TTLSeconds: ttl})
		}
	}

	for toolIndex, tool := range req.Tools {
		// Native server tools have provider-specific semantics and cannot be
		// assumed to accept a cache_control field.
		if tool.NativeType != "" {
			continue
		}
		if tool.Name == "" || tool.InputSchema == nil {
			return nil, "tool cache boundary has an incomplete definition", CodeInvalidBoundary
		}
		breakpoints = appendOrReplaceSectionBreakpoint(breakpoints, Breakpoint{Kind: BoundaryTools, MessageIndex: -1, BlockIndex: -1, ToolIndex: toolIndex, TTLSeconds: ttl})
	}

	for messageIndex, message := range req.Messages {
		if message.Role != transforms.RoleUser {
			continue
		}
		for blockIndex, block := range message.Content {
			if block.Type != transforms.BlockText {
				if block.Type == transforms.BlockImage || block.Type == transforms.BlockToolResult || block.Type == transforms.BlockToolUse || block.Type == transforms.BlockNative {
					return nil, "message cache boundary follows dynamic content", CodeInvalidBoundary
				}
				continue
			}
			if block.Text == "" || containsVolatile(block.Text) {
				return nil, "message cache boundary is not stable", CodeInvalidBoundary
			}
			breakpoints = appendOrReplaceSectionBreakpoint(breakpoints, Breakpoint{Kind: BoundaryMessage, MessageIndex: messageIndex, BlockIndex: blockIndex, ToolIndex: -1, TTLSeconds: ttl})
		}
	}
	return breakpoints, "", ""
}

func appendOrReplaceSectionBreakpoint(existing []Breakpoint, candidate Breakpoint) []Breakpoint {
	for i := range existing {
		if existing[i].Kind == candidate.Kind {
			existing[i] = candidate
			return existing
		}
	}
	return append(existing, candidate)
}
func boundaryForRole(role transforms.Role) BoundaryKind {
	if role == transforms.RoleSystem || role == transforms.RoleDeveloper {
		return BoundarySystem
	}
	return BoundaryMessage
}

var (
	volatileTimestamp     = regexp.MustCompile(`(?i)\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?\b`)
	volatileUUID          = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	volatilePEM           = regexp.MustCompile(`-----BEGIN [A-Z][A-Z ]*-----`)
	openAIBreakpointModel = regexp.MustCompile(`(?i)(?:^|/)gpt-5\.(\d+)(?:$|[-.])`)
)

func containsVolatile(text string) bool {
	return volatileTimestamp.MatchString(text) || volatileUUID.MatchString(text) || volatilePEM.MatchString(text)
}

const minVolatileStablePrefixLength = 128

// ParseUsage parses provider evidence without estimating missing values. For
// Anthropic it also preserves the optional cache_creation TTL breakdown.
func ParseUsage(protocol Protocol, body map[string]any) Usage {
	if body == nil {
		return Usage{Source: "missing"}
	}
	rawUsage, ok := body["usage"]
	if !ok || rawUsage == nil {
		return Usage{Source: "missing"}
	}
	usage, ok := rawUsage.(map[string]any)
	if !ok || usage == nil {
		return Usage{Source: "missing"}
	}
	u := Usage{Source: "provider"}
	if protocol == ProtocolOpenAI {
		details, detailsOK := usage["prompt_tokens_details"].(map[string]any)
		if detailsOK {
			if value, ok := number(details["cached_tokens"]); ok {
				u.Read = int64Ptr(value)
			}
			if value, ok := number(details["cache_write_tokens"]); ok {
				u.Write = int64Ptr(value)
			} else if value, ok := number(details["cache_write_input_tokens"]); ok {
				u.Write = int64Ptr(value)
			} else if value, ok := number(details["cache_creation_input_tokens"]); ok {
				u.Write = int64Ptr(value)
			}
		}
		if u.Read == nil {
			if value, ok := number(usage["cached_tokens"]); ok {
				u.Read = int64Ptr(value)
			}
		}
		if u.Write == nil {
			if value, ok := number(usage["cache_write_tokens"]); ok {
				u.Write = int64Ptr(value)
			} else if value, ok := number(usage["cache_write_input_tokens"]); ok {
				u.Write = int64Ptr(value)
			} else if value, ok := number(usage["cache_creation_input_tokens"]); ok {
				u.Write = int64Ptr(value)
			}
		}
		return u
	}
	if protocol != ProtocolAnthropic {
		return u
	}
	if value, ok := number(usage["cache_read_input_tokens"]); ok {
		u.Read = int64Ptr(value)
	}
	if value, ok := number(usage["cache_creation_input_tokens"]); ok {
		u.Write = int64Ptr(value)
	}
	if creation, ok := usage["cache_creation"].(map[string]any); ok {
		u.CreationByTTL = map[string]*int64{}
		if value, ok := number(creation["ephemeral_5m_input_tokens"]); ok {
			u.Creation5m = int64Ptr(value)
			u.CreationByTTL["5m"] = int64Ptr(value)
		}
		if value, ok := number(creation["ephemeral_1h_input_tokens"]); ok {
			u.Creation1h = int64Ptr(value)
			u.CreationByTTL["1h"] = int64Ptr(value)
		}
		if len(u.CreationByTTL) == 0 {
			u.CreationByTTL = nil
		}
	}
	// Accept flattened breakdowns emitted by some Anthropic-compatible gateways.
	if value, ok := number(usage["ephemeral_5m_input_tokens"]); ok && u.Creation5m == nil {
		u.Creation5m = int64Ptr(value)
		if u.CreationByTTL == nil {
			u.CreationByTTL = map[string]*int64{}
		}
		u.CreationByTTL["5m"] = int64Ptr(value)
	}
	if value, ok := number(usage["ephemeral_1h_input_tokens"]); ok && u.Creation1h == nil {
		u.Creation1h = int64Ptr(value)
		if u.CreationByTTL == nil {
			u.CreationByTTL = map[string]*int64{}
		}
		u.CreationByTTL["1h"] = int64Ptr(value)
	}
	return u
}
func int64Ptr(value int64) *int64 { return &value }

// ParseUsageChecked is the error-returning form for integrations that need to
// reject an unknown protocol or malformed usage envelope. ParseUsage remains
// the compatibility helper because missing provider usage is an optional,
// non-error absence.
func ParseUsageChecked(protocol Protocol, body map[string]any) (Usage, error) {
	if protocol != ProtocolOpenAI && protocol != ProtocolAnthropic {
		return Usage{}, cacheError(CodeUnsupportedProtocol, ErrUnsupportedProtocol, "protocol is not usage-capable")
	}
	if body == nil {
		return Usage{Source: "missing"}, nil
	}
	if raw, present := body["usage"]; present && raw != nil {
		usage, ok := raw.(map[string]any)
		if !ok {
			return Usage{}, cacheError(CodeInvalidUsage, ErrInvalidUsage, "usage must be an object")
		}
		if protocol == ProtocolOpenAI {
			if err := validateOpenAIUsage(usage); err != nil {
				return Usage{}, err
			}
		}
	}
	return ParseUsage(protocol, body), nil
}

func validateOpenAIUsage(usage map[string]any) error {
	if raw, present := usage["prompt_tokens_details"]; present && raw != nil {
		details, ok := raw.(map[string]any)
		if !ok {
			return cacheError(CodeInvalidUsage, ErrInvalidUsage, "prompt_tokens_details must be an object")
		}
		for _, field := range []string{"cached_tokens", "cache_write_tokens", "cache_write_input_tokens", "cache_creation_input_tokens"} {
			if value, present := details[field]; present && value != nil {
				if _, ok := number(value); !ok {
					return cacheError(CodeInvalidUsage, ErrInvalidUsage, "OpenAI cache usage field must be a non-negative integer")
				}
			}
		}
	}
	for _, field := range []string{"cached_tokens", "cache_write_tokens", "cache_write_input_tokens", "cache_creation_input_tokens"} {
		if value, present := usage[field]; present && value != nil {
			if _, ok := number(value); !ok {
				return cacheError(CodeInvalidUsage, ErrInvalidUsage, "OpenAI cache usage field must be a non-negative integer")
			}
		}
	}
	return nil
}
func number(v any) (int64, bool) {
	var value int64
	switch n := v.(type) {
	case int:
		value = int64(n)
	case int8:
		value = int64(n)
	case int16:
		value = int64(n)
	case int32:
		value = int64(n)
	case int64:
		value = n
	case uint:
		if uint64(n) > math.MaxInt64 {
			return 0, false
		}
		value = int64(n)
	case uint8:
		value = int64(n)
	case uint16:
		value = int64(n)
	case uint32:
		value = int64(n)
	case uint64:
		if n > math.MaxInt64 {
			return 0, false
		}
		value = int64(n)
	case float32:
		f := float64(n)
		if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > math.MaxInt64 {
			return 0, false
		}
		value = int64(f)
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 0 || n > math.MaxInt64 {
			return 0, false
		}
		value = int64(n)
	case json.Number:
		number, err := strconv.ParseInt(string(n), 10, 64)
		if err != nil || number < 0 {
			return 0, false
		}
		value = number
	default:
		return 0, false
	}
	if value < 0 {
		return 0, false
	}
	return value, true
}

// SupportsOpenAIPromptBreakpoints reports whether the selected model supports
// the explicit prompt-cache breakpoint extension. Automatic prompt caching
// remains separately capability-gated by Plan's supported argument.
func SupportsOpenAIPromptBreakpoints(model string) bool {
	match := openAIBreakpointModel.FindStringSubmatch(model)
	if len(match) != 2 {
		return false
	}
	version, err := strconv.Atoi(match[1])
	return err == nil && version >= 6
}

// openAIStablePrefix returns a deterministic prefix and its final text
// boundary. Volatile material is a suffix: the first timestamp, UUID, or PEM
// marker ends the reusable prefix, and all later content is deliberately
// excluded. Dynamic blocks likewise end the prefix rather than being hashed.
func openAIStablePrefix(req *transforms.NormalizedRequest) (string, Breakpoint, bool, error) {
	point := Breakpoint{Kind: BoundaryMessage, MessageIndex: -1, BlockIndex: -1, ToolIndex: -1}
	if req == nil {
		return "", point, false, cacheError(CodeRequestRequired, ErrRequestRequired, "request is required")
	}
	var b strings.Builder
	hasPrefix := false
	inPrefix := true
	for messageIndex, message := range req.Messages {
		if !inPrefix {
			break
		}
		switch message.Role {
		case transforms.RoleSystem, transforms.RoleDeveloper, transforms.RoleUser, transforms.RoleAssistant:
		default:
			inPrefix = false
			continue
		}
		for blockIndex, block := range message.Content {
			if !inPrefix {
				break
			}
			if block.CacheControl != "" && block.CacheControl != "ephemeral" {
				return "", point, false, cacheError(CodeInvalidBoundary, ErrInvalidBoundary, "cache marker uses an unsupported policy")
			}
			if block.Type != transforms.BlockText {
				inPrefix = false
				continue
			}
			text, volatile := stableTextPrefix(block.Text)
			if text == "" {
				inPrefix = false
				continue
			}
			writePart(&b, "message", strconv.Itoa(messageIndex))
			writePart(&b, "role", string(message.Role))
			writePart(&b, "block", strconv.Itoa(blockIndex))
			writePart(&b, "type", string(block.Type))
			writePart(&b, "text", text)
			hasPrefix = true
			if message.Role != transforms.RoleAssistant {
				point = Breakpoint{
					Kind:         boundaryForRole(message.Role),
					MessageIndex: messageIndex,
					BlockIndex:   blockIndex,
					ToolIndex:    -1,
				}
			}
			if volatile || block.CacheControl == "ephemeral" {
				inPrefix = false
			}
		}
	}
	for toolIndex, tool := range req.Tools {
		if tool.Name == "" || tool.InputSchema == nil {
			return "", point, false, cacheError(CodeInvalidRequest, ErrInvalidRequest, "tool cache input is incomplete")
		}
		schema, err := canonicalJSONChecked(tool.InputSchema)
		if err != nil {
			return "", point, false, cacheError(CodeInvalidRequest, ErrInvalidRequest, "tool schema cannot be serialized")
		}
		writePart(&b, "tool", strconv.Itoa(toolIndex))
		writePart(&b, "name", tool.Name)
		writePart(&b, "description", tool.Description)
		writePart(&b, "schema", schema)
		hasPrefix = true
	}
	if !hasPrefix {
		return "", point, false, nil
	}
	return b.String(), point, true, nil
}

func stableTextPrefix(text string) (string, bool) {
	matches := []int{}
	for _, expression := range []*regexp.Regexp{volatileTimestamp, volatileUUID, volatilePEM} {
		if match := expression.FindStringIndex(text); match != nil {
			matches = append(matches, match[0])
		}
	}
	if len(matches) == 0 {
		return text, false
	}
	first := matches[0]
	for _, index := range matches[1:] {
		if index < first {
			first = index
		}
	}
	prefix := strings.TrimRight(text[:first], " \t\r\n")
	if len(prefix) < minVolatileStablePrefixLength {
		return "", true
	}
	return prefix, true
}

// legacyStablePrefix is retained for package-local compatibility with older
// callers; planning uses openAIStablePrefix so serialization failures cannot
// silently turn into a colliding empty schema.
func legacyStablePrefix(req *transforms.NormalizedRequest) string {
	prefix, _, _, _ := openAIStablePrefix(req)
	return prefix
}

func anthropicStablePrefix(req *transforms.NormalizedRequest) string {
	if req == nil {
		return ""
	}
	var b strings.Builder
	for messageIndex, message := range req.Messages {
		if message.Role != transforms.RoleSystem && message.Role != transforms.RoleDeveloper {
			continue
		}
		for blockIndex, block := range message.Content {
			if block.Type != transforms.BlockText || block.Text == "" || containsVolatile(block.Text) {
				continue
			}
			writePart(&b, "system", strconv.Itoa(messageIndex)+":"+strconv.Itoa(blockIndex))
			writePart(&b, "text", block.Text)
		}
	}
	for toolIndex, tool := range req.Tools {
		if tool.NativeType != "" {
			continue
		}
		writePart(&b, "tool", strconv.Itoa(toolIndex))
		writePart(&b, "name", tool.Name)
		writePart(&b, "description", tool.Description)
		writePart(&b, "schema", canonicalJSON(tool.InputSchema))
	}
	for messageIndex, message := range req.Messages {
		if message.Role != transforms.RoleUser {
			continue
		}
		for blockIndex, block := range message.Content {
			if block.Type != transforms.BlockText || block.Text == "" || containsVolatile(block.Text) {
				break
			}
			writePart(&b, "message", strconv.Itoa(messageIndex)+":"+strconv.Itoa(blockIndex))
			writePart(&b, "text", block.Text)
		}
	}
	return b.String()
}
func writePart(b *strings.Builder, key, value string) {
	b.WriteString(key)
	b.WriteByte('=')
	b.WriteString(strconv.Itoa(len(value)))
	b.WriteByte(':')
	b.WriteString(value)
	b.WriteByte(';')
}
func canonicalJSON(value map[string]any) string {
	encoded, _ := canonicalJSONChecked(value)
	return encoded
}

func canonicalJSONChecked(value map[string]any) (string, error) {
	if value == nil {
		return "", nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
