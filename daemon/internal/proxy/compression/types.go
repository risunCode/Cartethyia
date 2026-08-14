package compression

// BlockKind identifies a content block within a normalized message. Only the
// kinds that are relevant to compression are enumerated explicitly; anything
// else is preserved as-is.
type BlockKind string

const (
	BlockText       BlockKind = "text"
	BlockToolResult BlockKind = "tool_result"
	// BlockOther covers any block type that the saver must not touch.
	BlockOther BlockKind = "other"
)

// Block is a single piece of content within a message. Text is the only
// mutable field for compression purposes; other fields are preserved verbatim.
type Block struct {
	Kind            BlockKind
	Text            string
	ToolResultIsErr bool
	ToolName        string
	ToolCallID      string
	IsUserAuthored  bool // true when the owning message has role="user"
}

// Clone returns a deep copy of b. Callers mutate clones to avoid sharing the
// backing string across stages.
func (b Block) Clone() Block {
	return b
}

// Message is one entry in a normalized request's message list. Role is opaque
// here so this package does not need to import the contracts package.
type Message struct {
	Role    string
	Content []Block
}

// Clone returns a deep copy with cloned blocks.
func (m Message) Clone() Message {
	out := Message{Role: m.Role, Content: make([]Block, len(m.Content))}
	for i, b := range m.Content {
		out.Content[i] = b.Clone()
	}
	return out
}

// Request is the minimal view of an upstream chat request the compression
// stages need. It is intentionally framework-free so the proxy runtime can
// convert from contracts.Request without pulling extra dependencies.
type Request struct {
	Model    string
	Messages []Message
}

// Clone returns a deep copy of the request.
func (r Request) Clone() Request {
	out := Request{Model: r.Model, Messages: make([]Message, len(r.Messages))}
	for i, m := range r.Messages {
		out.Messages[i] = m.Clone()
	}
	return out
}

// Reason enumerates the explicit, machine-readable reasons a stage can be
// skipped. The full set is enumerated so callers can render, log, and assert
// on individual reasons instead of comparing free-form strings.
type Reason string

const (
	ReasonDisabled    Reason = "disabled"
	ReasonEmpty       Reason = "empty_request"
	ReasonNoShrink    Reason = "no_shrink"
	ReasonCacheMiss   Reason = "cache_miss"
	ReasonCacheError  Reason = "cache_error"
	ReasonCacheStored Reason = "cache_stored"
)

// Summary captures the result metadata of a single compression stage. Attempted
// is true only when the stage actually consulted its backing service. Reason
// is non-nil when Attempted is false (the explicit skip reason) and nil on
// success. Byte and block deltas are reported for both branches to keep
// downstream accounting uniform.
type Summary struct {
	Attempted        bool
	CompressedBlocks int
	BytesBefore      int
	BytesAfter       int
	Reason           Reason
	Filter           string // non-empty when a local smart filter was applied
}

// Outcome is the paired (request, summary) result of a compression stage. The
// Request is the same value as the input on skip paths so callers can chain
// stages without nil checks.
type Outcome struct {
	Request Request
	Summary Summary
}

// Skip builds an Outcome that leaves the request unchanged. It is the single
// canonical way to express "compression did not happen" so the metadata is
// always populated.
func Skip(in Request, reason Reason) Outcome {
	return Outcome{
		Request: in,
		Summary: Summary{
			Attempted: false,
			Reason:    reason,
		},
	}
}

// Compressed builds an Outcome that reports successful compression. Before/After
// may be equal when the stage applied a lossless filter; the summary still
// records Attempted=true.
func Compressed(req Request, before, after int, blocks int, filter string) Outcome {
	return Outcome{
		Request: req,
		Summary: Summary{
			Attempted:        true,
			CompressedBlocks: blocks,
			BytesBefore:      before,
			BytesAfter:       after,
			Filter:           filter,
		},
	}
}

// HasShrunk reports whether the stage reduced payload size. It returns false
// for skipped stages and for lossless transforms that did not save bytes.
func (s Summary) HasShrunk() bool {
	return s.Attempted && s.BytesAfter < s.BytesBefore
}
