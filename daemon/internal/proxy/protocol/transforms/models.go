package transforms

import (
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

// Role identifies the normalized message role shared across all surfaces.
type Role string

const (
	RoleSystem    Role = "system"
	RoleDeveloper Role = "developer"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ReasoningFlag describes the reasoning state carried in a canonical request.
type ReasoningFlag string

const (
	ReasoningDefault  ReasoningFlag = "default"
	ReasoningEnabled  ReasoningFlag = "enabled"
	ReasoningDisabled ReasoningFlag = "disabled"
)

// ReasoningEffort is a normalized effort value understood by all surfaces.
type ReasoningEffort string

const (
	EffortXHigh   ReasoningEffort = "xhigh"
	EffortHigh    ReasoningEffort = "high"
	EffortMedium  ReasoningEffort = "medium"
	EffortLow     ReasoningEffort = "low"
	EffortMinimal ReasoningEffort = "minimal"
	EffortNone    ReasoningEffort = "none"
)

// ReasoningSummary is a normalized summary verbosity.
type ReasoningSummary string

const (
	SummaryAuto     ReasoningSummary = "auto"
	SummaryConcise  ReasoningSummary = "concise"
	SummaryDetailed ReasoningSummary = "detailed"
)

// ReasoningMode is the Responses-only execution mode hint.
type ReasoningMode string

const (
	ReasoningModeStandard ReasoningMode = "standard"
	ReasoningModePro      ReasoningMode = "pro"
)

// ReasoningContext is the Responses-only history context hint.
type ReasoningContext string

const (
	ReasoningContextAuto        ReasoningContext = "auto"
	ReasoningContextCurrentTurn ReasoningContext = "current_turn"
	ReasoningContextAllTurns    ReasoningContext = "all_turns"
)

// ReasoningConfig is the canonical reasoning control block. All surfaces
// project their native shape onto this struct; nil fields are omitted from
// the wire payload.
type ReasoningConfig struct {
	Effort    ReasoningEffort
	Summary   ReasoningSummary
	Mode      ReasoningMode
	Context   ReasoningContext
	MaxTokens int
	Exclude   bool
	Enabled   bool
}

// ImageKind classifies how an image is referenced.
type ImageKind string

const (
	ImageURL  ImageKind = "url"
	ImageData ImageKind = "data"
	ImageFile ImageKind = "file"
)

// ImageReference is a normalized image source. File-kind references are
// preserved on decode but cannot be inlined to upstream providers.
type ImageReference struct {
	Kind      ImageKind
	Value     string
	MediaType string
}

// ToolChoice is the normalized tool choice. Strings map to provider-supported
// literals; an Object carries an arbitrary provider extension.
type ToolChoice struct {
	Mode   string
	Object map[string]any
}

// Tool is the normalized tool definition.
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	// NativeType is set when the tool is provider-native (e.g. web_search,
	// mcp_toolset). Encoders on incompatible surfaces reject the request.
	NativeType     string
	NativeOptions  map[string]any
	DeferLoading   *bool
	AllowedCallers []string
	InputExamples  []map[string]any
}

// ContentBlockType classifies a normalized content block.
type ContentBlockType string

const (
	BlockText       ContentBlockType = "text"
	BlockImage      ContentBlockType = "image"
	BlockToolUse    ContentBlockType = "tool_use"
	BlockToolResult ContentBlockType = "tool_result"
	BlockReasoning  ContentBlockType = "reasoning"
	BlockCompaction ContentBlockType = "compaction"
	BlockNative     ContentBlockType = "native"
	BlockUnknown    ContentBlockType = "unknown"
)

// ContentBlock is a single normalized piece of a message.
type ContentBlock struct {
	Type ContentBlockType

	// Text blocks
	Text         string
	CacheControl string // "", "ephemeral"

	// Image blocks
	Image *ImageReference

	// Tool-use blocks
	ToolName      string
	ToolCallID    string
	ToolArguments string // JSON string, never object

	// Tool-result blocks
	ToolResultIsError bool

	// Reasoning blocks
	ReasoningText             string
	ReasoningSignature        string
	ReasoningEncryptedContent string
	ReasoningSummary          []map[string]any

	// Native / unknown passthrough
	NativeType    string
	NativePayload map[string]any

	// Raw original object for round-trip / passthrough
	Raw map[string]any
}

// NormalizedMessage is a single message in a canonical conversation.
type NormalizedMessage struct {
	Role    Role
	Content []ContentBlock
	// ReasoningContent is the assistant reasoning payload, used by OpenAI
	// Chat to round-trip history thinking.
	ReasoningContent string
	// ReasoningItemsBefore is the Responses-only prefix of reasoning items
	// that precede this message.
	ReasoningItemsBefore []map[string]any
	// Phase is the Responses-only commentary/final_answer marker.
	Phase string
}

// ResponseFormat is the canonical response shape hint.
type ResponseFormat string

const (
	FormatText       ResponseFormat = "text"
	FormatJSONObject ResponseFormat = "json_object"
	FormatJSONSchema ResponseFormat = "json_schema"
)

// NormalizedRequest is the canonical request shared by all encoders.
type NormalizedRequest struct {
	Model                  string
	Stream                 bool
	Messages               []NormalizedMessage
	Tools                  []Tool
	ToolChoice             *ToolChoice
	ResponseFormat         ResponseFormat
	ResponseFormatSchema   map[string]any
	MaxOutputTokens        *int
	Temperature            *float64
	TopP                   *float64
	Stop                   []string
	ParallelToolCalls      *bool
	Metadata               map[string]any
	CacheKey               string
	Reasoning              ReasoningFlag
	ReasoningConfig        *ReasoningConfig
	Include                []string
	ContextManagement      any
	MCPServers             []map[string]any
	Images                 []ImageReference
	TrailingReasoningItems []map[string]any

	// Source identifies the wire surface that produced this request. It
	// survives normalization so encoders can apply per-surface rules
	// (e.g. metadata is round-tripped only on the originating surface).
	Source contracts.Protocol
}

// NormalizedEvent is a single canonical stream event.
type NormalizedEvent struct {
	// Type identifies the semantic event. Encoders map it to wire-specific
	// event names.
	Type string
	// Text is the textual delta, if any.
	Text string
	// ToolCallID / ToolName / ToolArguments fragment identify a streaming
	// tool call in progress.
	ToolCallID    string
	ToolName      string
	ToolArguments string
	// ReasoningText carries a thinking delta.
	ReasoningText string
	// ReasoningEncryptedContent carries an opaque reasoning artifact.
	ReasoningEncryptedContent string
	// Usage is set on the final usage event.
	Usage *Usage
	// StopReason is set on the final event of a non-streaming decode.
	StopReason *StopReason
	// Raw is the original provider event for passthrough.
	Raw map[string]any
}

// Usage is the canonical token usage record.
type Usage struct {
	InputTokens  int
	OutputTokens int
	TotalTokens  int
	// CacheRead / CacheWrite are optional Anthropic prompt-cache fields.
	CacheRead  int
	CacheWrite int
}

// StopReason is the canonical stop classification.
type StopReason string

const (
	StopCompleted     StopReason = "completed"
	StopLength        StopReason = "length"
	StopToolCall      StopReason = "tool_call"
	StopContentFilter StopReason = "content_filter"
	StopError         StopReason = "error"
)

// NormalizedResponse is the canonical response document.
type NormalizedResponse struct {
	Model  string
	Events []NormalizedEvent
	// Text / ToolCalls are convenience aggregations for non-streaming decoders.
	Text       string
	ToolCalls  []NormalizedToolCall
	Usage      *Usage
	StopReason StopReason
	// RawBody is the original provider body for passthrough encoding.
	RawBody map[string]any
}

// NormalizedToolCall is a single emitted tool call on the response side.
type NormalizedToolCall struct {
	ID        string
	Name      string
	Arguments string // JSON string
}
