package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Contract bounds apply after a surface parser has decoded the request. They
// keep the shared domain independent from wire encodings and unbounded bodies.
const (
	MaxIdentifierBytes     = 256
	MaxTextBytes           = 32 * 1024
	MaxNativePayloadBytes  = 64 * 1024
	MaxToolArgumentBytes   = 64 * 1024
	MaxMetadataEntries     = 64
	MaxMetadataValueBytes  = 1024
	MaxMessageCount        = 4096
	MaxBlocksPerMessage    = 4096
	MaxToolCount           = 128
	MaxImageCount          = 128
	MaxRouteAttempts       = 64
	MaxDiagnosticCount     = 128
	MaxFailureMessageBytes = 512
	MaxRequestBodyBytes    = 16 * 1024 * 1024
	MaxOutputTokenCount    = 1 << 20
	MaxTimeout             = 24 * time.Hour
)

var (
	ErrInvalidContract = errors.New("contracts: invalid domain contract")
	ErrContractBounds  = errors.New("contracts: domain contract exceeds bounds")
)

// JSONFragment is bounded provider-native JSON. It is deliberately not a raw
// request body; callers should construct it with NewJSONFragment.
type JSONFragment []byte

// NewJSONFragment validates and clones a bounded JSON fragment.
func NewJSONFragment(raw []byte) (JSONFragment, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > MaxNativePayloadBytes {
		return nil, fmt.Errorf("%w: json fragment is %d bytes", ErrContractBounds, len(raw))
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("%w: json fragment is malformed", ErrInvalidContract)
	}
	return JSONFragment(bytes.Clone(raw)), nil
}

// Validate checks size and JSON invariants without serializing the fragment.
func (j JSONFragment) Validate(max int) error {
	if len(j) == 0 {
		return nil
	}
	if max <= 0 || len(j) > max {
		return fmt.Errorf("%w: json fragment is %d bytes", ErrContractBounds, len(j))
	}
	if !json.Valid(j) {
		return fmt.Errorf("%w: json fragment is malformed", ErrInvalidContract)
	}
	return nil
}

// Role identifies the sender of a canonical message.
type Role string

const (
	RoleSystem    Role = "system"
	RoleDeveloper Role = "developer"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

func (r Role) IsValid() bool {
	switch r {
	case RoleSystem, RoleDeveloper, RoleUser, RoleAssistant, RoleTool:
		return true
	default:
		return false
	}
}

// BlockKind identifies the semantic payload carried by a content block.
type BlockKind string

const (
	BlockText       BlockKind = "text"
	BlockImage      BlockKind = "image"
	BlockToolUse    BlockKind = "tool-use"
	BlockToolResult BlockKind = "tool-result"
	BlockReasoning  BlockKind = "reasoning"
	BlockNative     BlockKind = "native"
)

func (k BlockKind) IsValid() bool {
	switch k {
	case BlockText, BlockImage, BlockToolUse, BlockToolResult, BlockReasoning, BlockNative:
		return true
	default:
		return false
	}
}

// ImageKind identifies how an image is referenced. The value is metadata or a
// bounded data URI; the contract never resolves or stores file contents.
type ImageKind string

const (
	ImageURL  ImageKind = "url"
	ImageData ImageKind = "data"
	ImageFile ImageKind = "file"
)

// Image is the canonical image reference.
type Image struct {
	Kind      ImageKind
	Value     string
	MediaType string
}

func (i Image) Validate() error {
	if i.Kind != ImageURL && i.Kind != ImageData && i.Kind != ImageFile {
		return fmt.Errorf("%w: invalid image kind %q", ErrInvalidContract, i.Kind)
	}
	if err := boundedString("image value", i.Value, MaxNativePayloadBytes, true); err != nil {
		return err
	}
	return boundedString("image media type", i.MediaType, MaxIdentifierBytes, false)
}

// ToolCall carries either a tool invocation or its bounded result. Arguments
// and result are JSON fragments, not arbitrary unbounded provider bodies.
type ToolCall struct {
	ID        string
	Name      string
	Arguments JSONFragment
	Result    JSONFragment
	IsError   bool
}

func (t ToolCall) Validate() error {
	if err := boundedString("tool call id", t.ID, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if err := boundedString("tool call name", t.Name, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if err := t.Arguments.Validate(MaxToolArgumentBytes); err != nil {
		return fmt.Errorf("tool call arguments: %w", err)
	}
	if err := t.Result.Validate(MaxNativePayloadBytes); err != nil {
		return fmt.Errorf("tool call result: %w", err)
	}
	return nil
}

// Tool is a canonical tool declaration.
type Tool struct {
	Name        string
	Description string
	InputSchema JSONFragment
	NativeType  string
	Native      JSONFragment
}

func (t Tool) Validate() error {
	if err := boundedString("tool name", t.Name, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if err := boundedString("tool description", t.Description, MaxTextBytes, false); err != nil {
		return err
	}
	if err := boundedString("native tool type", t.NativeType, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if err := t.InputSchema.Validate(MaxNativePayloadBytes); err != nil {
		return fmt.Errorf("tool input schema: %w", err)
	}
	if err := t.Native.Validate(MaxNativePayloadBytes); err != nil {
		return fmt.Errorf("tool native payload: %w", err)
	}
	return nil
}

// CacheBoundary identifies a provider prompt-cache boundary without carrying
// provider headers or credentials.
type CacheBoundary struct {
	Mode       CacheMode
	TTLSeconds int
}

// CacheMode is the cache policy accepted by the canonical contract.
type CacheMode string

const (
	CacheNone      = "none"
	CacheAutomatic = "automatic"
	CacheExplicit  = "explicit"
	CacheEphemeral = "ephemeral"
)

func (c CacheBoundary) Validate() error {
	switch c.Mode {
	case CacheNone, CacheAutomatic, CacheExplicit, CacheEphemeral:
	default:
		return fmt.Errorf("%w: invalid cache mode %q", ErrInvalidContract, c.Mode)
	}
	if c.TTLSeconds < 0 || c.TTLSeconds > int(MaxTimeout/time.Second) {
		return fmt.Errorf("%w: cache ttl is out of range", ErrContractBounds)
	}
	return nil
}

// ContentBlock is one semantic unit of a canonical message. Exactly one
// payload family is accepted for each Kind; Native is always bounded JSON.
type ContentBlock struct {
	Kind   BlockKind
	Text   string
	Image  *Image
	Tool   *ToolCall
	Native JSONFragment
	Cache  *CacheBoundary
}

func (b ContentBlock) Validate() error {
	if !b.Kind.IsValid() {
		return fmt.Errorf("%w: invalid content block kind %q", ErrInvalidContract, b.Kind)
	}
	if err := boundedString("content text", b.Text, MaxTextBytes, false); err != nil {
		return err
	}
	if err := b.Native.Validate(MaxNativePayloadBytes); err != nil {
		return fmt.Errorf("content native payload: %w", err)
	}
	if b.Cache != nil {
		if err := b.Cache.Validate(); err != nil {
			return err
		}
		if b.Kind != BlockText {
			return fmt.Errorf("%w: cache boundary requires a text block", ErrInvalidContract)
		}
	}
	switch b.Kind {
	case BlockText:
		if b.Image != nil || b.Tool != nil || len(b.Native) != 0 {
			return fmt.Errorf("%w: text block has an incompatible payload", ErrInvalidContract)
		}
	case BlockImage:
		if b.Image == nil {
			return fmt.Errorf("%w: image block is missing image", ErrInvalidContract)
		}
		if err := b.Image.Validate(); err != nil {
			return err
		}
	case BlockToolUse, BlockToolResult:
		if b.Tool == nil {
			return fmt.Errorf("%w: tool block is missing tool call", ErrInvalidContract)
		}
		if err := b.Tool.Validate(); err != nil {
			return err
		}
	case BlockReasoning:
		if b.Image != nil || b.Tool != nil {
			return fmt.Errorf("%w: reasoning block has an incompatible payload", ErrInvalidContract)
		}
	case BlockNative:
		if len(b.Native) == 0 {
			return fmt.Errorf("%w: native block is missing payload", ErrInvalidContract)
		}
	}
	return nil
}

// Message is a canonical conversation message.
type Message struct {
	Role   Role
	Blocks []ContentBlock
	Name   string
}

func (m Message) Validate() error {
	if !m.Role.IsValid() {
		return fmt.Errorf("%w: invalid message role %q", ErrInvalidContract, m.Role)
	}
	if err := boundedString("message name", m.Name, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if len(m.Blocks) == 0 || len(m.Blocks) > MaxBlocksPerMessage {
		return fmt.Errorf("%w: message block count is %d", ErrContractBounds, len(m.Blocks))
	}
	for i, block := range m.Blocks {
		if err := block.Validate(); err != nil {
			return fmt.Errorf("message block %d: %w", i, err)
		}
	}
	return nil
}

// ReasoningIntent contains provider-neutral reasoning controls.
type ReasoningIntent struct {
	Enabled   bool
	Effort    string
	Summary   string
	MaxTokens int
}

func (r ReasoningIntent) Validate() error {
	if err := boundedString("reasoning effort", r.Effort, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if err := boundedString("reasoning summary", r.Summary, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if r.MaxTokens < 0 || r.MaxTokens > MaxOutputTokenCount {
		return fmt.Errorf("%w: reasoning max tokens is out of range", ErrContractBounds)
	}
	return nil
}

// SearchIntent is a provider-neutral request for search capability.
type SearchIntent struct {
	Enabled bool
	Query   string
}

func (s SearchIntent) Validate() error {
	return boundedString("search query", s.Query, MaxTextBytes, false)
}

// Continuation is an opaque, scoped response continuation reference.
type Continuation struct {
	ID    string
	Scope string
}

func (c Continuation) Validate() error {
	if err := boundedString("continuation id", c.ID, MaxIdentifierBytes, true); err != nil {
		return err
	}
	return boundedString("continuation scope", c.Scope, MaxIdentifierBytes, true)
}

// Limits carries request and execution bounds without embedding raw HTTP data.
type Limits struct {
	MaxBodyBytes     int
	MaxOutputTokens  int
	ConnectTimeout   time.Duration
	FirstByteTimeout time.Duration
	IdleTimeout      time.Duration
	TotalTimeout     time.Duration
}

func (l Limits) Validate() error {
	if l.MaxBodyBytes < 0 || l.MaxBodyBytes > MaxRequestBodyBytes {
		return fmt.Errorf("%w: body limit is out of range", ErrContractBounds)
	}
	if l.MaxOutputTokens < 0 || l.MaxOutputTokens > MaxOutputTokenCount {
		return fmt.Errorf("%w: output token limit is out of range", ErrContractBounds)
	}
	for name, timeout := range map[string]time.Duration{
		"connect":    l.ConnectTimeout,
		"first_byte": l.FirstByteTimeout,
		"idle":       l.IdleTimeout,
		"total":      l.TotalTimeout,
	} {
		if timeout < 0 || timeout > MaxTimeout {
			return fmt.Errorf("%w: %s timeout is out of range", ErrContractBounds, name)
		}
	}
	return nil
}

// CachePolicy is the request-level cache preference.
type CachePolicy string

// RequestMetadata is bounded diagnostic identity, not a header or payload bag.
type RequestMetadata struct {
	RequestID string
	Client    string
	Values    map[string]string
}

func (m RequestMetadata) Validate() error {
	if err := boundedString("request id", m.RequestID, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if err := boundedString("client", m.Client, MaxIdentifierBytes, false); err != nil {
		return err
	}
	if len(m.Values) > MaxMetadataEntries {
		return fmt.Errorf("%w: metadata entry count is %d", ErrContractBounds, len(m.Values))
	}
	for key, value := range m.Values {
		if err := boundedString("metadata key", key, MaxIdentifierBytes, true); err != nil {
			return err
		}
		if err := boundedString("metadata value", value, MaxMetadataValueBytes, false); err != nil {
			return err
		}
	}
	return nil
}

// Exchange is the canonical request shared by parsers, routing, and transforms.
// It intentionally contains no raw body, HTTP headers, or credential material.
type Exchange struct {
	Surface        Surface
	RequestedModel string
	Messages       []Message
	Tools          []Tool
	Images         []Image
	Reasoning      ReasoningIntent
	Search         SearchIntent
	Stream         bool
	Continuation   *Continuation
	Limits         Limits
	CachePolicy    CachePolicy
	Metadata       RequestMetadata
}

func (e Exchange) Validate() error {
	if !e.Surface.IsValid() {
		return fmt.Errorf("%w: invalid exchange surface %q", ErrInvalidContract, e.Surface)
	}
	if err := boundedString("requested model", e.RequestedModel, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if len(e.Messages) == 0 || len(e.Messages) > MaxMessageCount {
		return fmt.Errorf("%w: message count is %d", ErrContractBounds, len(e.Messages))
	}
	if len(e.Tools) > MaxToolCount {
		return fmt.Errorf("%w: tool count is %d", ErrContractBounds, len(e.Tools))
	}
	if len(e.Images) > MaxImageCount {
		return fmt.Errorf("%w: image count is %d", ErrContractBounds, len(e.Images))
	}
	for i, message := range e.Messages {
		if err := message.Validate(); err != nil {
			return fmt.Errorf("message %d: %w", i, err)
		}
	}
	for i, tool := range e.Tools {
		if err := tool.Validate(); err != nil {
			return fmt.Errorf("tool %d: %w", i, err)
		}
	}
	for i, image := range e.Images {
		if err := image.Validate(); err != nil {
			return fmt.Errorf("image %d: %w", i, err)
		}
	}
	if err := e.Reasoning.Validate(); err != nil {
		return err
	}
	if err := e.Search.Validate(); err != nil {
		return err
	}
	if e.Continuation != nil {
		if err := e.Continuation.Validate(); err != nil {
			return err
		}
	}
	if err := e.Limits.Validate(); err != nil {
		return err
	}
	if e.CachePolicy != CacheNone && e.CachePolicy != CacheAutomatic &&
		e.CachePolicy != CacheExplicit && e.CachePolicy != CacheEphemeral {
		return fmt.Errorf("%w: invalid cache policy %q", ErrInvalidContract, e.CachePolicy)
	}
	return e.Metadata.Validate()
}

// CredentialRef is an opaque persisted reference. It cannot carry request-time
// API keys or OAuth tokens because its value is only created and compared as a
// reference by the domain package.
type CredentialRef struct{ value string }

// NewCredentialRef creates a bounded opaque credential reference.
func NewCredentialRef(value string) (CredentialRef, error) {
	if err := boundedString("credential reference", value, MaxIdentifierBytes, true); err != nil {
		return CredentialRef{}, err
	}
	return CredentialRef{value: value}, nil
}

// String returns the opaque reference identifier, never credential material.
func (r CredentialRef) String() string { return r.value }

// MarshalJSON emits the safe opaque identifier. The type has no JSON
// unmarshal path, so callers cannot inject request-time secret material into
// a canonical candidate through decoding.
func (r CredentialRef) MarshalJSON() ([]byte, error) {
	return json.Marshal(r.value)
}

func (r CredentialRef) IsZero() bool { return r.value == "" }

// Candidate is a route candidate. CredentialRef is intentionally opaque and
// no request-time secret field exists on this type.
type Candidate struct {
	ID            string
	ProviderID    string
	ModelID       string
	Surface       Surface
	CredentialRef CredentialRef
	Enabled       bool
	Authorized    bool
	Compatible    bool
}

func (c Candidate) Validate() error {
	for name, value := range map[string]string{
		"candidate id": c.ID,
		"provider id":  c.ProviderID,
		"model id":     c.ModelID,
	} {
		if err := boundedString(name, value, MaxIdentifierBytes, true); err != nil {
			return err
		}
	}
	if !c.Surface.IsValid() {
		return fmt.Errorf("%w: invalid candidate surface %q", ErrInvalidContract, c.Surface)
	}
	if !c.CredentialRef.IsZero() {
		if _, err := NewCredentialRef(c.CredentialRef.String()); err != nil {
			return err
		}
	}
	return nil
}

// TransformDiagnostic is bounded, secret-free transform metadata.
type TransformDiagnostic struct {
	Stage        string
	Action       string
	Reason       string
	SizeEstimate int
}

func (d TransformDiagnostic) Validate() error {
	if err := boundedString("diagnostic stage", d.Stage, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if err := boundedString("diagnostic action", d.Action, MaxIdentifierBytes, true); err != nil {
		return err
	}
	if err := boundedString("diagnostic reason", d.Reason, MaxFailureMessageBytes, false); err != nil {
		return err
	}
	if d.SizeEstimate < 0 || d.SizeEstimate > MaxNativePayloadBytes {
		return fmt.Errorf("%w: diagnostic size estimate is out of range", ErrContractBounds)
	}
	return nil
}

// TransformReport records only bounded transform decisions.
type TransformReport struct {
	Diagnostics []TransformDiagnostic
}

func (r TransformReport) Validate() error {
	if len(r.Diagnostics) > MaxDiagnosticCount {
		return fmt.Errorf("%w: diagnostic count is %d", ErrContractBounds, len(r.Diagnostics))
	}
	for i, diagnostic := range r.Diagnostics {
		if err := diagnostic.Validate(); err != nil {
			return fmt.Errorf("diagnostic %d: %w", i, err)
		}
	}
	return nil
}

// RoutePlan is the immutable routing decision consumed by the proxy engine.
type RoutePlan struct {
	SnapshotGeneration uint64
	Candidate          Candidate
	Attempts           []Candidate
	CacheIntent        CachePolicy
	TransformReport    TransformReport
}

func (p RoutePlan) Validate() error {
	if p.SnapshotGeneration == 0 {
		return fmt.Errorf("%w: route snapshot generation is zero", ErrInvalidContract)
	}
	if err := p.Candidate.Validate(); err != nil {
		return fmt.Errorf("candidate: %w", err)
	}
	if len(p.Attempts) == 0 || len(p.Attempts) > MaxRouteAttempts {
		return fmt.Errorf("%w: route attempt count is %d", ErrContractBounds, len(p.Attempts))
	}
	seen := make(map[string]struct{}, len(p.Attempts))
	for i, candidate := range p.Attempts {
		if err := candidate.Validate(); err != nil {
			return fmt.Errorf("attempt %d: %w", i, err)
		}
		if _, exists := seen[candidate.ID]; exists {
			return fmt.Errorf("%w: duplicate route candidate %q", ErrInvalidContract, candidate.ID)
		}
		seen[candidate.ID] = struct{}{}
	}
	if p.CacheIntent != CacheNone && p.CacheIntent != CacheAutomatic &&
		p.CacheIntent != CacheExplicit && p.CacheIntent != CacheEphemeral {
		return fmt.Errorf("%w: invalid route cache intent %q", ErrInvalidContract, p.CacheIntent)
	}
	return p.TransformReport.Validate()
}

// FailureCode is the stable domain classification consumed by retry and health
// policy. Detailed precedence remains owned by proxy failure classification.
type FailureCode string

const (
	FailureInvalidRequest   FailureCode = "invalid_request"
	FailureAuthentication   FailureCode = "authentication"
	FailureQuota            FailureCode = "quota"
	FailureRateLimit        FailureCode = "rate_limit"
	FailureContext          FailureCode = "context"
	FailureTransport        FailureCode = "transport"
	FailureTimeout          FailureCode = "timeout"
	FailureStream           FailureCode = "stream"
	FailureCancelled        FailureCode = "cancelled"
	FailureProviderProtocol FailureCode = "provider_protocol"
)

func (c FailureCode) IsValid() bool {
	switch c {
	case FailureInvalidRequest, FailureAuthentication, FailureQuota, FailureRateLimit,
		FailureContext, FailureTransport, FailureTimeout, FailureStream,
		FailureCancelled, FailureProviderProtocol:
		return true
	default:
		return false
	}
}

// Failure is a bounded, secret-free routing failure contract.
type Failure struct {
	Code       FailureCode
	StatusCode int
	ProviderID string
	Retryable  bool
	Message    string
}

func (f Failure) Validate() error {
	if !f.Code.IsValid() {
		return fmt.Errorf("%w: invalid failure code %q", ErrInvalidContract, f.Code)
	}
	if f.StatusCode != 0 && (f.StatusCode < 100 || f.StatusCode > 599) {
		return fmt.Errorf("%w: failure status code is %d", ErrInvalidContract, f.StatusCode)
	}
	if err := boundedString("failure provider", f.ProviderID, MaxIdentifierBytes, false); err != nil {
		return err
	}
	return boundedString("failure message", f.Message, MaxFailureMessageBytes, true)
}

func boundedString(field, value string, max int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalidContract, field)
	}
	if len(value) > max {
		return fmt.Errorf("%w: %s is %d bytes", ErrContractBounds, field, len(value))
	}
	return nil
}
