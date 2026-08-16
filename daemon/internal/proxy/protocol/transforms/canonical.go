package transforms

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/cartethyia/daemon/internal/proxy/protocol/jsonclone"
)

const (
	MaxCanonicalIDLength      = 512
	MaxAnnotationCount        = 256
	MaxAnnotationTextLength   = 8 * 1024
	MaxFilenameLength         = 1024
	MaxMediaURLLength         = 8 * 1024
	MaxInlineMediaBytes       = 8 * 1024 * 1024
	MaxReasoningDetailCount   = 256
	MaxToolLedgerOccurrences  = 512
	MaxCompactionInputItems   = MaxMessageCount * 2
	MaxContextManagementEdits = 64
	MaxUsageTokens            = int64(1) << 50
)

// Presence distinguishes an omitted value from an explicit null and a value.
type Presence uint8

const (
	PresenceMissing Presence = iota
	PresenceNull
	PresenceValue
)

// Optional retains missing/null/value wire semantics. Its zero value is missing.
type Optional[T any] struct {
	presence Presence
	value    T
}

func Missing[T any]() Optional[T] { return Optional[T]{} }
func Null[T any]() Optional[T]    { return Optional[T]{presence: PresenceNull} }
func Value[T any](value T) Optional[T] {
	return Optional[T]{presence: PresenceValue, value: value}
}
func (o Optional[T]) Presence() Presence { return o.presence }
func (o Optional[T]) IsMissing() bool    { return o.presence == PresenceMissing }
func (o Optional[T]) IsNull() bool       { return o.presence == PresenceNull }
func (o Optional[T]) Get() (T, bool)     { return o.value, o.presence == PresenceValue }

// ReferenceKind identifies how media bytes are named without fetching them.
type ReferenceKind uint8

const (
	ReferenceURL ReferenceKind = iota + 1
	ReferenceInlineData
	ReferenceProviderFileID
	ReferenceProviderFileURL
)

// MediaKind identifies the semantic modality independently from its reference.
type MediaKind uint8

const (
	MediaImage MediaKind = iota + 1
	MediaAudio
	MediaGenericFile
	MediaTextDocument
	MediaPDF
)

// ImageDetail is the normalized image fidelity hint.
type ImageDetail string

const (
	ImageDetailAuto     ImageDetail = "auto"
	ImageDetailLow      ImageDetail = "low"
	ImageDetailHigh     ImageDetail = "high"
	ImageDetailOriginal ImageDetail = "original"
)

// MediaReferenceOptions contains optional, non-payload media metadata.
type MediaReferenceOptions struct {
	MIMEType  string
	Filename  string
	Detail    ImageDetail
	SizeBytes Optional[int64]
}

// MediaReference is a typed URL, inline-data, provider-file-ID, or file-URL
// reference. Value is never fetched, decoded, resized, or transcoded here.
type MediaReference struct {
	Media     MediaKind
	Reference ReferenceKind
	MIMEType  string
	Filename  string
	Detail    ImageDetail
	Value     string
	SizeBytes Optional[int64]
}

func NewMediaReference(media MediaKind, reference ReferenceKind, value string, options MediaReferenceOptions) (MediaReference, *TransformError) {
	ref := MediaReference{
		Media: media, Reference: reference, Value: value,
		MIMEType: options.MIMEType, Filename: options.Filename,
		Detail: options.Detail, SizeBytes: options.SizeBytes,
	}
	if err := ref.Validate(); err != nil {
		return MediaReference{}, err
	}
	return ref, nil
}

func NewAudioReference(reference ReferenceKind, value string, options MediaReferenceOptions) (AudioReference, *TransformError) {
	return NewMediaReference(MediaAudio, reference, value, options)
}

func NewFileReference(reference ReferenceKind, value string, options MediaReferenceOptions) (FileReference, *TransformError) {
	return NewMediaReference(MediaGenericFile, reference, value, options)
}

func NewDocumentReference(reference ReferenceKind, value string, options MediaReferenceOptions) (DocumentReference, *TransformError) {
	return NewMediaReference(MediaTextDocument, reference, value, options)
}

func NewPDFReference(reference ReferenceKind, value string, options MediaReferenceOptions) (PDFReference, *TransformError) {
	return NewMediaReference(MediaPDF, reference, value, options)
}

func (r MediaReference) Validate() *TransformError {
	if r.Media < MediaImage || r.Media > MediaPDF {
		return canonicalError(CodeInvalidMediaReference, "media.kind", "unsupported media kind")
	}
	if r.Reference < ReferenceURL || r.Reference > ReferenceProviderFileURL {
		return canonicalError(CodeInvalidMediaReference, "media.reference", "unsupported reference kind")
	}
	if strings.TrimSpace(r.Value) == "" {
		return canonicalError(CodeInvalidMediaReference, "media.value", "value is required")
	}
	if len(r.MIMEType) > MaxModelLength {
		return canonicalError(CodeInvalidMediaReference, "media.mime_type", "value exceeds bound")
	}
	if len(r.Filename) > MaxFilenameLength {
		return canonicalError(CodeInvalidMediaReference, "media.filename", "value exceeds bound")
	}
	switch r.Detail {
	case "", ImageDetailAuto, ImageDetailLow, ImageDetailHigh, ImageDetailOriginal:
	default:
		return canonicalError(CodeInvalidMediaReference, "media.detail", "unsupported image detail")
	}
	if r.Media != MediaImage && r.Detail != "" {
		return canonicalError(CodeInvalidMediaReference, "media.detail", "detail is valid only for images")
	}
	if size, ok := r.SizeBytes.Get(); ok && (size < 0 || size > MaxUsageTokens) {
		return canonicalError(CodeInvalidMediaReference, "media.size_bytes", "value out of range")
	}
	switch r.Reference {
	case ReferenceURL, ReferenceProviderFileURL:
		if len(r.Value) > MaxMediaURLLength {
			return canonicalError(CodeInvalidMediaReference, "media.value", "URL exceeds bound")
		}
		parsed, err := url.Parse(r.Value)
		if err != nil || parsed.Scheme == "" {
			return canonicalError(CodeInvalidMediaReference, "media.value", "absolute URL is required")
		}
	case ReferenceInlineData:
		if decodedBase64Length(r.Value) > MaxInlineMediaBytes || !validBase64(r.Value) {
			return canonicalError(CodeInvalidMediaReference, "media.value", "invalid or oversized base64 data")
		}
	case ReferenceProviderFileID:
		if len(r.Value) > MaxCanonicalIDLength {
			return canonicalError(CodeInvalidMediaReference, "media.value", "file ID exceeds bound")
		}
	}
	return nil
}

func decodedBase64Length(value string) int {
	padding := 0
	if strings.HasSuffix(value, "=") {
		padding++
	}
	if strings.HasSuffix(value, "==") {
		padding++
	}
	return (len(value)*3)/4 - padding
}

func validBase64(value string) bool {
	if value == "" || len(value)%4 == 1 {
		return false
	}
	padding := 0
	for i := len(value); i > 0 && value[i-1] == '='; i-- {
		padding++
	}
	if padding > 2 || (padding > 0 && len(value)%4 != 0) {
		return false
	}
	for i, char := range []byte(value) {
		if char == '=' {
			if i < len(value)-padding {
				return false
			}
			continue
		}
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || char == '+' || char == '/' || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

// ToolKind preserves tool declaration and call semantics across surfaces.
type ToolKind string

const (
	ToolKindFunction       ToolKind = "function"
	ToolKindCustom         ToolKind = "custom"
	ToolKindComputer       ToolKind = "computer"
	ToolKindHosted         ToolKind = "hosted"
	ToolKindServer         ToolKind = "server"
	ToolKindWebSearch      ToolKind = "web_search"
	ToolKindImage          ToolKind = "image"
	ToolKindMCP            ToolKind = "mcp"
	ToolKindNative         ToolKind = "native"
	ToolKindWeb            ToolKind = ToolKindWebSearch
	ToolKindProviderNative ToolKind = ToolKindNative
)

// ServerToolContent preserves provider-hosted/search/MCP tool envelopes. The
// argument and result strings are intentionally bounded wire representations;
// JSON validation is applied only when a target declares JSON arguments.
type ServerToolContent struct {
	Kind      ToolKind
	Name      string
	CallID    string
	ItemID    string
	Arguments string
	Result    string
	IsError   bool
	Media     []MediaReference
}

func (s *ServerToolContent) Validate(field string) *TransformError {
	if s == nil {
		return canonicalError(CodeInvalidCanonical, field, "server tool content must not be nil")
	}
	if !validToolKind(s.Kind, false) || s.Kind == ToolKindFunction || s.Kind == ToolKindCustom {
		return canonicalError(CodeInvalidCanonical, field+".kind", "server tool requires a hosted/server/native tool kind")
	}
	for _, fieldValue := range []struct {
		name     string
		value    string
		max      int
		required bool
	}{{"name", s.Name, MaxToolNameLength, false}, {"call_id", s.CallID, MaxCanonicalIDLength, false}, {"item_id", s.ItemID, MaxCanonicalIDLength, false}, {"arguments", s.Arguments, MaxToolArgumentBytes, false}, {"result", s.Result, MaxNativePayloadBytes, false}} {
		if err := boundedValue(field+"."+fieldValue.name, fieldValue.value, fieldValue.max, fieldValue.required); err != nil {
			return canonicalError(CodeInvalidCanonical, field+"."+fieldValue.name, err.Error())
		}
	}
	if len(s.Media) > MaxBlocksPerMessage {
		return canonicalError(CodeInvalidCanonical, field+".media", "too many media references")
	}
	for i := range s.Media {
		if err := s.Media[i].Validate(); err != nil {
			return canonicalError(CodeInvalidCanonical, field+".media["+itoa(i)+"]", err.Reason)
		}
	}
	return nil
}

// ToolFormatKind distinguishes JSON-schema arguments from freeform payloads.
type ToolFormatKind string

const (
	ToolFormatJSON    ToolFormatKind = "json"
	ToolFormatGrammar ToolFormatKind = "grammar"
	ToolFormatText    ToolFormatKind = "text"
)

// ToolFormat is a bounded typed tool input/output format.
type ToolFormat struct {
	Kind   ToolFormatKind
	Name   string
	Schema json.RawMessage
}

func NewToolFormat(kind ToolFormatKind, name string, schema json.RawMessage) (*ToolFormat, *TransformError) {
	format := &ToolFormat{Kind: kind, Name: name, Schema: cloneRaw(schema)}
	if err := format.Validate(); err != nil {
		return nil, err
	}
	return format, nil
}

func (f *ToolFormat) Validate() *TransformError {
	if f == nil {
		return canonicalError(CodeInvalidCanonical, "tool.format", "format must not be nil")
	}
	switch f.Kind {
	case ToolFormatJSON, ToolFormatGrammar, ToolFormatText:
	default:
		return canonicalError(CodeInvalidCanonical, "tool.format.kind", "unsupported tool format")
	}
	if len(f.Name) > MaxToolNameLength {
		return canonicalError(CodeInvalidCanonical, "tool.format.name", "value exceeds bound")
	}
	if len(f.Schema) > MaxNativePayloadBytes || (len(f.Schema) > 0 && !json.Valid(f.Schema)) {
		return canonicalError(CodeInvalidCanonical, "tool.format.schema", "invalid or oversized JSON")
	}
	return nil
}

// StructuredOutput carries response-format semantics without an unbounded map.
type StructuredOutput struct {
	Format      ResponseFormat
	Name        string
	Description string
	Schema      json.RawMessage
	Strict      Optional[bool]
}

func NewStructuredOutput(format ResponseFormat, name, description string, schema json.RawMessage, strict Optional[bool]) (*StructuredOutput, *TransformError) {
	output := &StructuredOutput{Format: format, Name: name, Description: description, Schema: cloneRaw(schema), Strict: strict}
	if err := output.Validate(); err != nil {
		return nil, err
	}
	return output, nil
}

func (o *StructuredOutput) Validate() *TransformError {
	if o == nil {
		return canonicalError(CodeInvalidCanonical, "structured_output", "value must not be nil")
	}
	switch o.Format {
	case FormatText, FormatJSONObject, FormatJSONSchema:
	default:
		return canonicalError(CodeInvalidCanonical, "structured_output.format", "unsupported response format")
	}
	if len(o.Name) > MaxToolNameLength || len(o.Description) > MaxTextBlockLength {
		return canonicalError(CodeInvalidCanonical, "structured_output", "name or description exceeds bound")
	}
	if len(o.Schema) > MaxNativePayloadBytes || (len(o.Schema) > 0 && !json.Valid(o.Schema)) {
		return canonicalError(CodeInvalidCanonical, "structured_output.schema", "invalid or oversized JSON")
	}
	if o.Format == FormatJSONSchema && len(o.Schema) == 0 {
		return canonicalError(CodeInvalidCanonical, "structured_output.schema", "schema is required")
	}
	return nil
}

// RefusalContent is explicit model refusal text, separate from ordinary text.
type RefusalContent struct {
	Text string
	Code string
}

func NewRefusalContent(text, code string) (*RefusalContent, *TransformError) {
	refusal := &RefusalContent{Text: text, Code: code}
	if err := boundedValue("refusal.text", text, MaxTextBlockLength, true); err != nil {
		return nil, canonicalError(CodeInvalidCanonical, "refusal.text", err.Error())
	}
	if err := boundedValue("refusal.code", code, MaxModelLength, false); err != nil {
		return nil, canonicalError(CodeInvalidCanonical, "refusal.code", err.Error())
	}
	return refusal, nil
}

// Citation is a source citation with optional inclusive/exclusive indexes.
type Citation struct {
	URL        string
	Title      string
	Text       string
	FileID     string
	StartIndex Optional[int]
	EndIndex   Optional[int]
}

func NewCitation(citation Citation) (*Citation, *TransformError) {
	if err := validateCitation(citation, "citation"); err != nil {
		return nil, canonicalError(CodeInvalidCanonical, "citation", err.Error())
	}
	copyCitation := citation
	return &copyCitation, nil
}

// AnnotationKind distinguishes URL/file citations and other typed annotations.
type AnnotationKind string

const (
	AnnotationURLCitation  AnnotationKind = "url_citation"
	AnnotationFileCitation AnnotationKind = "file_citation"
	AnnotationCitation     AnnotationKind = "citation"
)

// Annotation attaches citation semantics to a content item in source order.
type Annotation struct {
	Kind     AnnotationKind
	Citation Citation
}

// ItemStatus preserves provider item/response lifecycle state.
type ItemStatus string

const (
	ItemStatusInProgress ItemStatus = "in_progress"
	ItemStatusCompleted  ItemStatus = "completed"
	ItemStatusIncomplete ItemStatus = "incomplete"
	ItemStatusFailed     ItemStatus = "failed"
	ItemStatusCanceled   ItemStatus = "canceled"
)

// EventType is an alias so existing string-based callers remain source-compatible
// while encoders and decoders share package-owned constants.
type EventType = string

const (
	EventResponseStart      EventType = "response_start"
	EventResponseCompleted  EventType = "response_completed"
	EventResponseIncomplete EventType = "response_incomplete"
	EventResponseFailed     EventType = "response_failed"
	EventItemStart          EventType = "item_start"
	EventItemDelta          EventType = "item_delta"
	EventItemDone           EventType = "item_done"
	EventContentStart       EventType = "content_start"
	EventContentDelta       EventType = "content_delta"
	EventContentDone        EventType = "content_done"
	EventTextDelta          EventType = "text_delta"
	EventRefusalDelta       EventType = "refusal_delta"
	EventReasoningDelta     EventType = "reasoning_delta"
	EventToolCallDelta      EventType = "tool_call_delta"
	EventToolResult         EventType = "tool_result"
	EventUsage              EventType = "usage"
	EventError              EventType = "error"
)

// ReasoningDetail preserves ordered reasoning text, summary, signatures, and
// encrypted artifacts without converting them to provider-native maps.
type ReasoningDetail struct {
	Type             string
	Text             string
	Summary          string
	Signature        string
	EncryptedContent string
	ID               string
	Status           ItemStatus
	Index            Optional[int]
}

// InputUsageDetails and OutputUsageDetails retain optional provider dimensions.
type InputUsageDetails struct {
	CachedTokens     Optional[int64]
	CacheWriteTokens Optional[int64]
	AudioTokens      Optional[int64]
	ImageTokens      Optional[int64]
	TextTokens       Optional[int64]
}

type OutputUsageDetails struct {
	ReasoningTokens          Optional[int64]
	AudioTokens              Optional[int64]
	ImageTokens              Optional[int64]
	TextTokens               Optional[int64]
	AcceptedPredictionTokens Optional[int64]
	RejectedPredictionTokens Optional[int64]
}

// Prediction is a typed predicted-output hint.
type Prediction struct {
	Type    string
	Content []ContentBlock
}

// OperationKind is endpoint/body-authoritative and independent of client profile.
type OperationKind uint8

const (
	OperationGenerate OperationKind = iota + 1
	OperationCompactV1
	OperationCompactV2
)

// CompactionVersion identifies the remote compaction wire contract.
type CompactionVersion uint8

const (
	CompactionV1 CompactionVersion = iota + 1
	CompactionV2
)

// CompactionItemKind identifies the one terminal compaction payload kind.
type CompactionItemKind string

const (
	CompactionItemEncrypted CompactionItemKind = "compaction"
	CompactionItemSummary   CompactionItemKind = "compaction_summary"
	CompactionItemTrigger   CompactionItemKind = "compaction_trigger"
)

// CompactionContent is embedded in ContentBlock. CompactionItem aliases that
// block so ordinary history and compaction operations cannot diverge.
type CompactionContent struct {
	Version          CompactionVersion
	Kind             CompactionItemKind
	Summary          string
	EncryptedContent string
	Signature        string
}

type CompactionItem = ContentBlock

// CompactionRequest is the bounded canonical V1/V2 operation request.
type CompactionRequest struct {
	Version               CompactionVersion
	Model                 string
	Input                 []CompactionItem
	Instructions          string
	Tools                 []Tool
	Reasoning             *ReasoningConfig
	Include               []string
	SessionKey            string
	PromptCacheKey        string
	RetainedMessageBudget Optional[int]
}

// CompactionRequestInput is the constructor input copied into immutable-owned slices.
type CompactionRequestInput = CompactionRequest

func NewCompactionRequest(input CompactionRequestInput) (*CompactionRequest, *TransformError) {
	request := input
	request.Input = cloneContentBlocks(input.Input)
	request.Tools = cloneTools(input.Tools)
	request.Include = append([]string(nil), input.Include...)
	if input.Reasoning != nil {
		reasoning := *input.Reasoning
		request.Reasoning = &reasoning
	}
	if err := request.Validate(); err != nil {
		return nil, err
	}
	return &request, nil
}

func (r *CompactionRequest) Validate() *TransformError {
	if r == nil {
		return canonicalError(CodeInvalidCompaction, "compaction", "request must not be nil")
	}
	if r.Version != CompactionV1 && r.Version != CompactionV2 {
		return canonicalError(CodeInvalidCompaction, "compaction.version", "unsupported version")
	}
	if strings.TrimSpace(r.Model) == "" || len(r.Model) > MaxModelLength {
		return canonicalError(CodeInvalidCompaction, "compaction.model", "model is required and bounded")
	}
	if len(r.Input) == 0 || len(r.Input) > MaxCompactionInputItems {
		return canonicalError(CodeInvalidCompaction, "compaction.input", "input count out of range")
	}
	for i := range r.Input {
		if err := validateContentBlock(r.Input[i], "compaction.input["+itoa(i)+"]"); err != nil {
			return canonicalError(CodeInvalidCompaction, "compaction.input["+itoa(i)+"]", err.Error())
		}
	}
	if len(r.Instructions) > MaxTextBlockLength || len(r.Tools) > MaxToolCount || len(r.Include) > MaxBlocksPerMessage {
		return canonicalError(CodeInvalidCompaction, "compaction", "request field exceeds bound")
	}
	for i := range r.Tools {
		if err := validateNormalizedTool(r.Tools[i], "compaction.tools["+itoa(i)+"]"); err != nil {
			return canonicalError(CodeInvalidCompaction, "compaction.tools["+itoa(i)+"]", err.Error())
		}
	}
	if err := validateReasoning(ReasoningDefault, r.Reasoning); err != nil {
		return canonicalError(CodeInvalidCompaction, "compaction.reasoning", err.Error())
	}
	for _, include := range r.Include {
		if include == "" || len(include) > MaxModelLength {
			return canonicalError(CodeInvalidCompaction, "compaction.include", "include value is required and bounded")
		}
	}
	if len(r.SessionKey) > MaxCanonicalIDLength || len(r.PromptCacheKey) > MaxCanonicalIDLength {
		return canonicalError(CodeInvalidCompaction, "compaction.identity", "identity exceeds bound")
	}
	if budget, ok := r.RetainedMessageBudget.Get(); ok && (budget < 0 || budget > MaxOutputTokens) {
		return canonicalError(CodeInvalidCompaction, "compaction.retained_message_budget", "value out of range")
	}
	return nil
}

// CompactionResult contains exactly one canonical compaction item and usage.
type CompactionResult struct {
	Item  CompactionItem
	Usage *Usage
}

func NewCompactionResult(item CompactionItem, usage *Usage) (*CompactionResult, *TransformError) {
	result := &CompactionResult{Item: cloneContentBlock(item), Usage: cloneUsage(usage)}
	if err := result.Validate(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *CompactionResult) Validate() *TransformError {
	if r == nil {
		return canonicalError(CodeInvalidCompaction, "compaction.result", "result must not be nil")
	}
	if r.Item.Type != BlockCompaction || r.Item.Compaction == nil {
		return canonicalError(CodeInvalidCompaction, "compaction.result.item", "exactly one typed compaction item is required")
	}
	if err := validateCompactionContent(r.Item.Compaction, "compaction.result.item"); err != nil {
		return canonicalError(CodeInvalidCompaction, "compaction.result.item", err.Error())
	}
	if r.Item.Compaction.Kind == CompactionItemTrigger {
		return canonicalError(CodeInvalidCompaction, "compaction.result.item.kind", "trigger is not a result")
	}
	if r.Usage != nil {
		if err := r.Usage.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Operation carries ordinary generation or one validated compaction request.
type Operation struct {
	Kind       OperationKind
	Compaction *CompactionRequest
}

func NewGenerateOperation() Operation { return Operation{Kind: OperationGenerate} }

func NewCompactionOperation(request *CompactionRequest) (Operation, *TransformError) {
	if request == nil {
		return Operation{}, canonicalError(CodeInvalidCompaction, "operation.compaction", "request must not be nil")
	}
	if err := request.Validate(); err != nil {
		return Operation{}, err
	}
	kind := OperationCompactV1
	if request.Version == CompactionV2 {
		kind = OperationCompactV2
	}
	copyRequest, err := NewCompactionRequest(*request)
	if err != nil {
		return Operation{}, err
	}
	return Operation{Kind: kind, Compaction: copyRequest}, nil
}

func (o Operation) Validate() *TransformError {
	kind := o.Kind
	if kind == 0 {
		kind = OperationGenerate
	}
	if kind == OperationGenerate {
		if o.Compaction != nil {
			return canonicalError(CodeInvalidCompaction, "operation.compaction", "generation cannot carry compaction")
		}
		return nil
	}
	if kind != OperationCompactV1 && kind != OperationCompactV2 {
		return canonicalError(CodeInvalidCompaction, "operation.kind", "unsupported operation")
	}
	if o.Compaction == nil {
		return canonicalError(CodeInvalidCompaction, "operation.compaction", "compaction request is required")
	}
	if err := o.Compaction.Validate(); err != nil {
		return err
	}
	if (kind == OperationCompactV1) != (o.Compaction.Version == CompactionV1) {
		return canonicalError(CodeInvalidCompaction, "operation.kind", "operation and compaction version disagree")
	}
	return nil
}

// ToolOccurrenceState tracks a single call/result occurrence, not just a reused wire ID.
type ToolOccurrenceState string

const (
	ToolOccurrenceCalled      ToolOccurrenceState = "called"
	ToolOccurrenceCompleted   ToolOccurrenceState = "completed"
	ToolOccurrenceErrored     ToolOccurrenceState = "errored"
	ToolOccurrenceInterrupted ToolOccurrenceState = "interrupted"
)

// ToolOccurrence is the bounded identity mapping for one canonical tool call.
type ToolOccurrence struct {
	OccurrenceID  uint32
	SourceWireID  string
	TargetWireID  string
	ItemID        string
	CallID        string
	Kind          ToolKind
	Name          string
	State         ToolOccurrenceState
	ResultIsError bool
	MessageIndex  Optional[int]
	BlockIndex    Optional[int]
	ResponseIndex Optional[int]
}

// ToolOccurrenceLedger is immutable after construction; Occurrences returns a copy.
type ToolOccurrenceLedger struct {
	occurrences []ToolOccurrence
}

func NewToolOccurrenceLedger(occurrences []ToolOccurrence) (*ToolOccurrenceLedger, *TransformError) {
	ledger := &ToolOccurrenceLedger{occurrences: append([]ToolOccurrence(nil), occurrences...)}
	if err := ledger.Validate(); err != nil {
		return nil, err
	}
	return ledger, nil
}

func (l *ToolOccurrenceLedger) Occurrences() []ToolOccurrence {
	if l == nil {
		return nil
	}
	return append([]ToolOccurrence(nil), l.occurrences...)
}

func (l *ToolOccurrenceLedger) Len() int {
	if l == nil {
		return 0
	}
	return len(l.occurrences)
}

// Find returns a defensive value copy for a canonical occurrence identity.
func (l *ToolOccurrenceLedger) Find(id uint32) (ToolOccurrence, bool) {
	if l == nil || id == 0 {
		return ToolOccurrence{}, false
	}
	for _, occurrence := range l.occurrences {
		if occurrence.OccurrenceID == id {
			return occurrence, true
		}
	}
	return ToolOccurrence{}, false
}

func (l *ToolOccurrenceLedger) Validate() *TransformError {
	if l == nil {
		return canonicalError(CodeInvalidToolLedger, "tool_ledger", "ledger must not be nil")
	}
	if len(l.occurrences) > MaxToolLedgerOccurrences {
		return canonicalError(CodeInvalidToolLedger, "tool_ledger", "too many occurrences")
	}
	seen := make(map[uint32]struct{}, len(l.occurrences))
	for _, occurrence := range l.occurrences {
		if occurrence.OccurrenceID == 0 {
			return canonicalError(CodeInvalidToolLedger, "tool_ledger.occurrence_id", "value must be non-zero")
		}
		if _, exists := seen[occurrence.OccurrenceID]; exists {
			return canonicalError(CodeInvalidToolLedger, "tool_ledger.occurrence_id", "duplicate occurrence")
		}
		seen[occurrence.OccurrenceID] = struct{}{}
		if len(occurrence.SourceWireID) > MaxCanonicalIDLength || len(occurrence.TargetWireID) > MaxCanonicalIDLength ||
			len(occurrence.ItemID) > MaxCanonicalIDLength || len(occurrence.CallID) > MaxCanonicalIDLength || len(occurrence.Name) > MaxToolNameLength {
			return canonicalError(CodeInvalidToolLedger, "tool_ledger.identity", "identity exceeds bound")
		}
		if !validToolKind(occurrence.Kind, false) {
			return canonicalError(CodeInvalidToolLedger, "tool_ledger.kind", "unsupported tool kind")
		}
		switch occurrence.State {
		case ToolOccurrenceCalled, ToolOccurrenceCompleted, ToolOccurrenceErrored, ToolOccurrenceInterrupted:
		default:
			return canonicalError(CodeInvalidToolLedger, "tool_ledger.state", "unsupported occurrence state")
		}
		for _, position := range []Optional[int]{occurrence.MessageIndex, occurrence.BlockIndex, occurrence.ResponseIndex} {
			if value, ok := position.Get(); ok && value < 0 {
				return canonicalError(CodeInvalidToolLedger, "tool_ledger.index", "index must be non-negative")
			}
		}
	}
	return nil
}

// ContextManagementEnvelope retains whether a surface uses an object or list.
type ContextManagementEnvelope uint8

const (
	ContextManagementObject ContextManagementEnvelope = iota + 1
	ContextManagementArray
)

// ContextManagementEdit retains a typed edit name and its bounded canonical JSON.
type ContextManagementEdit struct {
	Type  string
	Value json.RawMessage
}

// ContextManagement remains distinct from remote compaction.
type ContextManagement struct {
	Envelope ContextManagementEnvelope
	Edits    []ContextManagementEdit
}

func DecodeContextManagement(raw any) (*ContextManagement, *TransformError) {
	encoded, err := json.Marshal(raw)
	if err != nil || len(encoded) > MaxNativePayloadBytes {
		return nil, canonicalError(CodeInvalidContextManagement, "context_management", "invalid or oversized value")
	}
	var envelope ContextManagementEnvelope
	var edits []json.RawMessage
	switch firstNonSpace(encoded) {
	case '[':
		envelope = ContextManagementArray
		if err := json.Unmarshal(encoded, &edits); err != nil {
			return nil, canonicalError(CodeInvalidContextManagement, "context_management", "expected edit array")
		}
	case '{':
		envelope = ContextManagementObject
		var object struct {
			Edits []json.RawMessage `json:"edits"`
		}
		if err := json.Unmarshal(encoded, &object); err != nil || object.Edits == nil {
			return nil, canonicalError(CodeInvalidContextManagement, "context_management.edits", "expected edits array")
		}
		edits = object.Edits
	default:
		return nil, canonicalError(CodeInvalidContextManagement, "context_management", "expected object or array")
	}
	if len(edits) > MaxContextManagementEdits {
		return nil, canonicalError(CodeInvalidContextManagement, "context_management.edits", "too many edits")
	}
	result := &ContextManagement{Envelope: envelope, Edits: make([]ContextManagementEdit, 0, len(edits))}
	for _, value := range edits {
		var header struct {
			Type string `json:"type"`
		}
		if len(value) > MaxNativePayloadBytes || json.Unmarshal(value, &header) != nil || header.Type == "" || len(header.Type) > MaxModelLength {
			return nil, canonicalError(CodeInvalidContextManagement, "context_management.edits.type", "edit type is required and bounded")
		}
		result.Edits = append(result.Edits, ContextManagementEdit{Type: header.Type, Value: cloneRaw(value)})
	}
	return result, nil
}

func (c *ContextManagement) Validate() *TransformError {
	if c == nil {
		return canonicalError(CodeInvalidContextManagement, "context_management", "value must not be nil")
	}
	if c.Envelope != ContextManagementObject && c.Envelope != ContextManagementArray {
		return canonicalError(CodeInvalidContextManagement, "context_management", "unsupported envelope")
	}
	if len(c.Edits) > MaxContextManagementEdits {
		return canonicalError(CodeInvalidContextManagement, "context_management.edits", "too many edits")
	}
	for _, edit := range c.Edits {
		if edit.Type == "" || len(edit.Type) > MaxModelLength || len(edit.Value) > MaxNativePayloadBytes || !json.Valid(edit.Value) {
			return canonicalError(CodeInvalidContextManagement, "context_management.edits", "invalid edit")
		}
		var header struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(edit.Value, &header) != nil || header.Type != edit.Type {
			return canonicalError(CodeInvalidContextManagement, "context_management.edits.type", "typed edit disagrees with payload")
		}
	}
	return nil
}

// WireValue produces the original surface envelope with defensive byte copies.
func (c *ContextManagement) WireValue() (any, *TransformError) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	values := make([]json.RawMessage, len(c.Edits))
	for i := range c.Edits {
		values[i] = cloneRaw(c.Edits[i].Value)
	}
	if c.Envelope == ContextManagementObject {
		return map[string]any{"edits": values}, nil
	}
	return values, nil
}

func (u *Usage) Validate() *TransformError {
	if u == nil {
		return canonicalError(CodeInvalidCanonical, "usage", "usage must not be nil")
	}
	if u.InputTokens < 0 || u.OutputTokens < 0 || u.TotalTokens < 0 || u.CacheRead < 0 || u.CacheWrite < 0 || u.ReasoningTokens < 0 || u.CacheReadTokens < 0 || u.CacheWriteTokens < 0 {
		return canonicalError(CodeInvalidCanonical, "usage", "token counts must be non-negative")
	}
	if int64(u.InputTokens) > MaxUsageTokens || int64(u.OutputTokens) > MaxUsageTokens || int64(u.TotalTokens) > MaxUsageTokens || int64(u.CacheRead) > MaxUsageTokens || int64(u.CacheWrite) > MaxUsageTokens || int64(u.ReasoningTokens) > MaxUsageTokens || int64(u.CacheReadTokens) > MaxUsageTokens || int64(u.CacheWriteTokens) > MaxUsageTokens {
		return canonicalError(CodeInvalidCanonical, "usage", "token counts exceed bound")
	}
	values := []Optional[int64]{
		u.InputDetails.CachedTokens, u.InputDetails.CacheWriteTokens, u.InputDetails.AudioTokens,
		u.InputDetails.ImageTokens, u.InputDetails.TextTokens, u.OutputDetails.ReasoningTokens,
		u.OutputDetails.AudioTokens, u.OutputDetails.ImageTokens, u.OutputDetails.TextTokens,
		u.OutputDetails.AcceptedPredictionTokens, u.OutputDetails.RejectedPredictionTokens,
	}
	for _, value := range values {
		if count, ok := value.Get(); ok && (count < 0 || count > MaxUsageTokens) {
			return canonicalError(CodeInvalidCanonical, "usage.details", "token count out of range")
		}
	}
	return nil
}

func validToolKind(kind ToolKind, allowEmpty bool) bool {
	if kind == "" {
		return allowEmpty
	}
	switch kind {
	case ToolKindFunction, ToolKindCustom, ToolKindComputer, ToolKindHosted, ToolKindServer,
		ToolKindWebSearch, ToolKindImage, ToolKindMCP, ToolKindNative:
		return true
	default:
		return false
	}
}

func validateCompactionContent(content *CompactionContent, field string) *protoErr {
	if content == nil {
		return &protoErr{field: field, reason: "compaction content is required"}
	}
	if content.Version != CompactionV1 && content.Version != CompactionV2 {
		return &protoErr{field: field + ".version", reason: "unsupported compaction version"}
	}
	switch content.Kind {
	case CompactionItemEncrypted:
		if content.EncryptedContent == "" {
			return &protoErr{field: field + ".encrypted_content", reason: "encrypted content is required"}
		}
	case CompactionItemSummary:
		if content.Summary == "" {
			return &protoErr{field: field + ".summary", reason: "summary is required"}
		}
	case CompactionItemTrigger:
	default:
		return &protoErr{field: field + ".kind", reason: "unsupported compaction item kind"}
	}
	if len(content.Summary) > MaxTextBlockLength || len(content.EncryptedContent) > MaxNativePayloadBytes || len(content.Signature) > MaxNativePayloadBytes {
		return &protoErr{field: field, reason: "compaction content exceeds bound"}
	}
	return nil
}

func validateItemStatus(status ItemStatus, field string) *protoErr {
	switch status {
	case "", ItemStatusInProgress, ItemStatusCompleted, ItemStatusIncomplete, ItemStatusFailed, ItemStatusCanceled:
		return nil
	default:
		return &protoErr{field: field, reason: "unsupported status"}
	}
}

func validateAnnotations(annotations []Annotation, field string) *protoErr {
	if len(annotations) > MaxAnnotationCount {
		return &protoErr{field: field, reason: "too many annotations"}
	}
	for i, annotation := range annotations {
		switch annotation.Kind {
		case AnnotationURLCitation, AnnotationFileCitation, AnnotationCitation:
		default:
			return &protoErr{field: field + "[" + itoa(i) + "].kind", reason: "unsupported annotation kind"}
		}
		citation := annotation.Citation
		if len(citation.URL) > MaxMediaURLLength || len(citation.Title) > MaxAnnotationTextLength ||
			len(citation.Text) > MaxAnnotationTextLength || len(citation.FileID) > MaxCanonicalIDLength {
			return &protoErr{field: field + "[" + itoa(i) + "]", reason: "citation exceeds bound"}
		}
		start, hasStart := citation.StartIndex.Get()
		end, hasEnd := citation.EndIndex.Get()
		if (hasStart && start < 0) || (hasEnd && end < 0) || (hasStart && hasEnd && end < start) {
			return &protoErr{field: field + "[" + itoa(i) + "].index", reason: "invalid citation range"}
		}
	}
	return nil
}

func cloneRaw(input json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), input...)
}

func firstNonSpace(input []byte) byte {
	for _, char := range input {
		if char != ' ' && char != '\t' && char != '\n' && char != '\r' {
			return char
		}
	}
	return 0
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	for value > 0 {
		pos--
		buf[pos] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[pos:])
}

func canonicalError(code TransformErrorCode, field, reason string) *TransformError {
	return newTransformError(code, "validate-canonical", "", field, reason, nil)
}

func cloneContentBlock(input ContentBlock) ContentBlock {
	output := input
	if input.Image != nil {
		image := *input.Image
		output.Image = &image
	}
	if input.Media != nil {
		media := *input.Media
		output.Media = &media
	}
	if input.Audio != nil {
		audio := *input.Audio
		output.Audio = &audio
	}
	if input.File != nil {
		file := *input.File
		output.File = &file
	}
	if input.Document != nil {
		document := *input.Document
		output.Document = &document
	}
	if input.MediaOutput != nil {
		mediaOutput := *input.MediaOutput
		output.MediaOutput = &mediaOutput
	}
	if input.Refusal != nil {
		refusal := *input.Refusal
		output.Refusal = &refusal
	}
	if input.Citation != nil {
		citation := *input.Citation
		output.Citation = &citation
	}
	output.Annotations = append([]Annotation(nil), input.Annotations...)
	output.ReasoningDetails = append([]ReasoningDetail(nil), input.ReasoningDetails...)
	output.ToolResultContent = cloneContentBlocks(input.ToolResultContent)
	output.ToolResultMedia = append([]MediaReference(nil), input.ToolResultMedia...)
	if input.ServerTool != nil {
		serverTool := *input.ServerTool
		serverTool.Media = append([]MediaReference(nil), input.ServerTool.Media...)
		output.ServerTool = &serverTool
	}
	if input.Compaction != nil {
		compaction := *input.Compaction
		output.Compaction = &compaction
	}
	output.ReasoningSummary = jsonclone.CloneMapList(input.ReasoningSummary)
	output.NativePayload = jsonclone.CloneMap(input.NativePayload)
	output.Raw = jsonclone.CloneMap(input.Raw)
	return output
}

func cloneContentBlocks(input []ContentBlock) []ContentBlock {
	output := make([]ContentBlock, len(input))
	for i := range input {
		output[i] = cloneContentBlock(input[i])
	}
	return output
}

func cloneTools(input []Tool) []Tool {
	output := append([]Tool(nil), input...)
	for i := range output {
		output[i].InputSchema = jsonclone.CloneMap(input[i].InputSchema)
		output[i].NativeOptions = jsonclone.CloneMap(input[i].NativeOptions)
		output[i].AllowedCallers = append([]string(nil), input[i].AllowedCallers...)
		output[i].InputExamples = jsonclone.CloneMapList(input[i].InputExamples)
		if input[i].Format != nil {
			format := *input[i].Format
			format.Schema = cloneRaw(input[i].Format.Schema)
			output[i].Format = &format
		}
	}
	return output
}

func cloneUsage(input *Usage) *Usage {
	if input == nil {
		return nil
	}
	output := *input
	return &output
}

func (e NormalizedEvent) Validate(field string) *TransformError {
	if len(e.ResponseID) > MaxCanonicalIDLength || len(e.ItemID) > MaxCanonicalIDLength || len(e.ContentID) > MaxCanonicalIDLength || len(e.CallID) > MaxCanonicalIDLength {
		return canonicalError(CodeInvalidCanonical, field+".identity", "event identity exceeds bound")
	}
	if err := validateItemStatus(e.Status, field+".status"); err != nil {
		return canonicalError(CodeInvalidCanonical, field+".status", err.Error())
	}
	if index, ok := e.Index.Get(); ok && index < 0 {
		return canonicalError(CodeInvalidCanonical, field+".index", "index must be non-negative")
	}
	if index, ok := e.ContentIndex.Get(); ok && index < 0 {
		return canonicalError(CodeInvalidCanonical, field+".content_index", "index must be non-negative")
	}
	if sequence, ok := e.SequenceNumber.Get(); ok && sequence < 0 {
		return canonicalError(CodeInvalidCanonical, field+".sequence_number", "sequence must be non-negative")
	}
	for _, fieldValue := range []struct {
		name, value string
		max         int
	}{
		{"text", e.Text, MaxTextBlockLength},
		{"tool_arguments", e.ToolArguments, MaxToolArgumentBytes},
		{"reasoning_text", e.ReasoningText, MaxTextBlockLength},
		{"reasoning_encrypted_content", e.ReasoningEncryptedContent, MaxNativePayloadBytes},
		{"reasoning_signature", e.ReasoningSignature, MaxNativePayloadBytes},
	} {
		if len(fieldValue.value) > fieldValue.max {
			return canonicalError(CodeInvalidCanonical, field+"."+fieldValue.name, "value exceeds bound")
		}
	}
	if e.Refusal != nil {
		if err := boundedValue(field+".refusal.text", e.Refusal.Text, MaxTextBlockLength, true); err != nil {
			return canonicalError(CodeInvalidCanonical, field+".refusal.text", err.Error())
		}
	}
	if err := validateAnnotations(e.Annotations, field+".annotations"); err != nil {
		return canonicalError(CodeInvalidCanonical, field+".annotations", err.Error())
	}
	if e.Media != nil {
		if err := e.Media.Validate(); err != nil {
			return err
		}
	}
	if e.Block != nil {
		if err := validateContentBlock(*e.Block, field+".block"); err != nil {
			return canonicalError(CodeInvalidCanonical, field+".block", err.Error())
		}
	}
	if e.Usage != nil {
		if err := e.Usage.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (r *NormalizedResponse) Validate() *TransformError {
	if r == nil {
		return canonicalError(CodeInvalidCanonical, "response", "response must not be nil")
	}
	if len(r.ID) > MaxCanonicalIDLength || len(r.Model) > MaxModelLength || len(r.ServiceTier) > MaxModelLength || len(r.SystemFingerprint) > MaxCanonicalIDLength {
		return canonicalError(CodeInvalidCanonical, "response.identity", "response identity exceeds bound")
	}
	if err := validateItemStatus(r.Status, "response.status"); err != nil {
		return canonicalError(CodeInvalidCanonical, "response.status", err.Error())
	}
	if index, ok := r.Index.Get(); ok && index < 0 {
		return canonicalError(CodeInvalidCanonical, "response.index", "index must be non-negative")
	}
	if index, ok := r.ContentIndex.Get(); ok && index < 0 {
		return canonicalError(CodeInvalidCanonical, "response.content_index", "index must be non-negative")
	}
	if sequence, ok := r.SequenceNumber.Get(); ok && sequence < 0 {
		return canonicalError(CodeInvalidCanonical, "response.sequence_number", "sequence must be non-negative")
	}
	if len(r.Events) > MaxMessageCount*2 || len(r.Output) > MaxMessageCount*2 || len(r.ToolCalls) > MaxToolLedgerOccurrences {
		return canonicalError(CodeInvalidCanonical, "response", "response item count exceeds bound")
	}
	for i := range r.Events {
		if err := r.Events[i].Validate("response.events[" + itoa(i) + "]"); err != nil {
			return err
		}
	}
	for i := range r.Output {
		if err := validateContentBlock(r.Output[i], "response.output["+itoa(i)+"]"); err != nil {
			return canonicalError(CodeInvalidCanonical, "response.output["+itoa(i)+"]", err.Error())
		}
	}
	for i, call := range r.ToolCalls {
		if len(call.ID) > MaxCanonicalIDLength || len(call.ItemID) > MaxCanonicalIDLength || len(call.Name) > MaxToolNameLength || len(call.Arguments) > MaxToolArgumentBytes {
			return canonicalError(CodeInvalidCanonical, "response.tool_calls["+itoa(i)+"]", "tool call exceeds bound")
		}
		if !validToolKind(call.Kind, true) {
			return canonicalError(CodeInvalidCanonical, "response.tool_calls["+itoa(i)+"].kind", "unsupported tool kind")
		}
		if err := validateItemStatus(call.Status, "response.tool_calls["+itoa(i)+"].status"); err != nil {
			return canonicalError(CodeInvalidCanonical, "response.tool_calls["+itoa(i)+"].status", err.Error())
		}
	}
	if r.Usage != nil {
		if err := r.Usage.Validate(); err != nil {
			return err
		}
	}
	if r.RawBody != nil {
		if err := boundedMap("response.raw_body", r.RawBody); err != nil {
			return canonicalError(CodeInvalidCanonical, "response.raw_body", err.Error())
		}
	}
	return nil
}
