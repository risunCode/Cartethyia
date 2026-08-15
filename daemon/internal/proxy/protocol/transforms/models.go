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
	Filename  string
	Detail    ImageDetail
	SizeBytes Optional[int64]
}

// AudioReference, FileReference, DocumentReference, and PDFReference are
// semantic aliases for MediaReference. The Media field on each value remains
// authoritative, so codecs can preserve URL/inline/file-ID/file-URL without
// fetching or transcoding payloads.
type AudioReference = MediaReference
type FileReference = MediaReference
type DocumentReference = MediaReference
type PDFReference = MediaReference

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
	Kind        ToolKind
	Format      *ToolFormat
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
	BlockText             ContentBlockType = "text"
	BlockImage            ContentBlockType = "image"
	BlockAudio            ContentBlockType = "audio"
	BlockFile             ContentBlockType = "file"
	BlockDocument         ContentBlockType = "document"
	BlockPDF              ContentBlockType = "pdf"
	BlockMediaOutput      ContentBlockType = "media_output"
	BlockRefusal          ContentBlockType = "refusal"
	BlockCitation         ContentBlockType = "citation"
	BlockToolUse          ContentBlockType = "tool_use"
	BlockToolResult       ContentBlockType = "tool_result"
	BlockServerToolUse    ContentBlockType = "server_tool_use"
	BlockServerToolResult ContentBlockType = "server_tool_result"
	BlockReasoning        ContentBlockType = "reasoning"
	BlockCompaction       ContentBlockType = "compaction"
	BlockCompactionTrigger ContentBlockType = "compaction_trigger"
	BlockNative           ContentBlockType = "native"
	BlockUnknown          ContentBlockType = "unknown"
)

// ContentBlock is a single normalized piece of a message.
type ContentBlock struct {
	Type ContentBlockType

	// Text blocks
	Text         string
	CacheControl string // "", "ephemeral"

	// Image blocks
	Image *ImageReference
	Media *MediaReference
	Audio *AudioReference
	File  *FileReference
	Document *DocumentReference
	MediaOutput *MediaReference

	// Refusal and citation/annotation blocks.
	Refusal    *RefusalContent
	Citation   *Citation
	Annotations []Annotation

	// Tool-use blocks
	ToolName      string
	ToolCallID    string
	ToolArguments string // JSON string, never object
	ToolItemID    string
	ToolKind      ToolKind
	ToolStatus    ItemStatus

	// Tool-result blocks
	ToolResultIsError bool
	ToolResult        string
	ToolResultContent []ContentBlock
	ToolResultMedia   []MediaReference
	ToolOccurrenceID  string

	// ServerTool carries typed hosted/search/MCP tool calls and results without
	// collapsing them into ordinary function calls.
	ServerTool *ServerToolContent

	// Reasoning blocks
	ReasoningText             string
	ReasoningSignature        string
	ReasoningEncryptedContent string
	ReasoningSummary          []map[string]any
	ReasoningDetails          []ReasoningDetail

	// Compaction blocks share this representation with compaction operations.
	Compaction *CompactionContent

	// Wire identity and order. Optional retains missing/null/zero distinctions.
	ID             string
	Status         ItemStatus
	Index          Optional[int]
	ContentIndex   Optional[int]
	SequenceNumber Optional[int64]

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
	StructuredOutput       *StructuredOutput
	MaxOutputTokens        *int
	Temperature            *float64
	TopP                   *float64
	Stop                   []string
	ParallelToolCalls      *bool
	Metadata               map[string]any
	CacheKey               string
	PreviousResponseID     string
	ConversationID         string
	ContinuationID         string
	Reasoning              ReasoningFlag
	ReasoningConfig        *ReasoningConfig
	Include                []string
	ContextManagement      *ContextManagement
	MCPServers             []map[string]any
	Images                 []ImageReference
	TrailingReasoningItems []map[string]any
	ServiceTier            string
	Prediction             *Prediction
	Operation              Operation
	ToolLedger             *ToolOccurrenceLedger
	Native                 NativeSidecar

	// Source identifies the wire surface that produced this request. It
	// survives normalization so encoders can apply per-surface rules
	// (e.g. metadata is round-tripped only on the originating surface).
	Source contracts.Protocol
}

// NormalizedEvent is a single canonical stream event.
type NormalizedEvent struct {
	// Type identifies the semantic event. Encoders map it to wire-specific
	// event names.
	Type EventType
	ResponseID string
	ItemID string
	ContentID string
	CallID string
	Status ItemStatus
	Index Optional[int]
	ContentIndex Optional[int]
	SequenceNumber Optional[int64]
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
	ReasoningSignature string
	Refusal *RefusalContent
	Annotations []Annotation
	Media *MediaReference
	Block *ContentBlock
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
	// These aliases retain provider-reported dimensions that predate the
	// nested details structs. A codec may populate either representation.
	ReasoningTokens int
	CacheReadTokens int
	CacheWriteTokens int
	// CacheRead / CacheWrite are optional Anthropic prompt-cache fields.
	CacheRead  int
	CacheWrite int
	InputDetails  InputUsageDetails
	OutputDetails OutputUsageDetails
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
	ID                string
	Model             string
	Status            ItemStatus
	ServiceTier       string
	SystemFingerprint string
	SequenceNumber    Optional[int64]
	Index             Optional[int]
	ContentIndex      Optional[int]
	Events            []NormalizedEvent
	Output            []ContentBlock
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
	ItemID    string
	Name      string
	Kind      ToolKind
	Status    ItemStatus
	Index     Optional[int]
	Arguments string // JSON string
}
