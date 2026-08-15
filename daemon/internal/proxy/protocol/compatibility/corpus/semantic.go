package corpus

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"sort"
	"strconv"
	"strings"
)

const (
	SemanticDigestVersion = "compat-semantic-v1"
	MaxSemanticBytes      = 256 << 10
	MaxSemanticItems      = 4096
	MaxSemanticDepth      = 32
)

type Semantic struct {
	Operation Operation           `json:"operation"`
	Messages  []SemanticMessage   `json:"messages,omitempty"`
	Tools     []SemanticTool      `json:"tools,omitempty"`
	Reasoning []SemanticReasoning `json:"reasoning,omitempty"`
	Media     []SemanticMedia     `json:"media,omitempty"`
	Usage     *SemanticUsage      `json:"usage,omitempty"`
	Terminal  TerminalExpectation `json:"terminal"`
}

type SemanticMessage struct {
	Role    string            `json:"role"`
	Name    string            `json:"name,omitempty"`
	Content []SemanticContent `json:"content"`
}

type SemanticContent struct {
	Kind           string             `json:"kind"`
	Text           string             `json:"text,omitempty"`
	Tool           *SemanticToolEvent `json:"tool,omitempty"`
	Reasoning      *SemanticReasoning `json:"reasoning,omitempty"`
	Media          *SemanticMedia     `json:"media,omitempty"`
	StructuredJSON json.RawMessage    `json:"structured_json,omitempty"`
}

type SemanticTool struct {
	Kind    string          `json:"kind"`
	Name    string          `json:"name"`
	Schema  json.RawMessage `json:"schema,omitempty"`
	Options json.RawMessage `json:"options,omitempty"`
}

type SemanticToolEvent struct {
	Occurrence  string          `json:"occurrence"`
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	SourceID    string          `json:"source_id,omitempty"`
	TargetID    string          `json:"target_id,omitempty"`
	ItemID      string          `json:"item_id,omitempty"`
	Association string          `json:"association,omitempty"`
	State       string          `json:"state"`
	Arguments   json.RawMessage `json:"arguments,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       bool            `json:"error,omitempty"`
}

type SemanticReasoning struct {
	Kind             string `json:"kind"`
	Text             string `json:"text,omitempty"`
	Summary          string `json:"summary,omitempty"`
	Signature        string `json:"signature,omitempty"`
	EncryptedContent string `json:"encrypted_content,omitempty"`
	Mode             string `json:"mode,omitempty"`
	Budget           int    `json:"budget,omitempty"`
}

type SemanticMedia struct {
	Modality        string `json:"modality"`
	ReferenceKind   string `json:"reference_kind"`
	MIMEType        string `json:"mime_type,omitempty"`
	Filename        string `json:"filename,omitempty"`
	Detail          string `json:"detail,omitempty"`
	Reference       string `json:"reference,omitempty"`
	ReferenceDigest string `json:"reference_digest,omitempty"`
	SizeBytes       int64  `json:"size_bytes,omitempty"`
	ToolOccurrence  string `json:"tool_occurrence,omitempty"`
}

type SemanticUsage struct {
	InputTokens      int `json:"input_tokens,omitempty"`
	OutputTokens     int `json:"output_tokens,omitempty"`
	TotalTokens      int `json:"total_tokens,omitempty"`
	ReasoningTokens  int `json:"reasoning_tokens,omitempty"`
	CacheReadTokens  int `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int `json:"cache_write_tokens,omitempty"`
}

// SemanticDigest hashes only typed semantic data. It frames every field and
// preserves slice order; JSON-valued tool data is key-order and whitespace
// independent, including equivalent decimal spellings such as 1, 1.0, and 1e0.
func SemanticDigest(semantic Semantic) (string, error) {
	if err := ValidateSemantic(semantic); err != nil {
		return "", err
	}
	h := sha256.New()
	frameString(h, "version", SemanticDigestVersion)
	writeOperation(h, semantic.Operation)
	frameInt(h, "message-count", int64(len(semantic.Messages)))
	for i := range semantic.Messages {
		message := semantic.Messages[i]
		frameString(h, "message-role", message.Role)
		frameString(h, "message-name", message.Name)
		frameInt(h, "content-count", int64(len(message.Content)))
		for j := range message.Content {
			writeContent(h, message.Content[j])
		}
	}
	frameInt(h, "tool-count", int64(len(semantic.Tools)))
	for i := range semantic.Tools {
		writeTool(h, semantic.Tools[i])
	}
	frameInt(h, "reasoning-count", int64(len(semantic.Reasoning)))
	for i := range semantic.Reasoning {
		writeReasoning(h, semantic.Reasoning[i])
	}
	frameInt(h, "media-count", int64(len(semantic.Media)))
	for i := range semantic.Media {
		writeMedia(h, semantic.Media[i])
	}
	if semantic.Usage == nil {
		frameString(h, "usage", "absent")
	} else {
		frameString(h, "usage", "present")
		writeUsage(h, *semantic.Usage)
	}
	writeTerminal(h, semantic.Terminal)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// DigestJSON returns a canonical SHA-256 digest of a bounded JSON value.
func DigestJSON(raw []byte) (string, error) {
	value, err := decodeJSONValue(raw)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if err := writeJSONValue(h, value, 0); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func ValidateSemantic(semantic Semantic) error {
	if err := validateOperation(semantic.Operation); err != nil {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.operation", err)
	}
	budget := semanticBudget{bytes: MaxSemanticBytes, items: MaxSemanticItems}
	for i := range semantic.Messages {
		message := semantic.Messages[i]
		if message.Role != "system" && message.Role != "developer" && message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.messages.role", nil)
		}
		if len(message.Content) == 0 || !budget.take(message.Role, message.Name) {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.messages", nil)
		}
		for j := range message.Content {
			if err := validateContent(message.Content[j], &budget); err != nil {
				return err
			}
		}
	}
	for i := range semantic.Tools {
		if err := validateTool(semantic.Tools[i], &budget); err != nil {
			return err
		}
	}
	for i := range semantic.Reasoning {
		if err := validateReasoning(semantic.Reasoning[i], &budget); err != nil {
			return err
		}
	}
	for i := range semantic.Media {
		if err := validateMedia(semantic.Media[i], &budget); err != nil {
			return err
		}
	}
	if semantic.Usage != nil {
		u := semantic.Usage
		if u.InputTokens < 0 || u.OutputTokens < 0 || u.TotalTokens < 0 || u.ReasoningTokens < 0 || u.CacheReadTokens < 0 || u.CacheWriteTokens < 0 {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.usage", nil)
		}
	}
	if err := validateTerminal(semantic.Terminal); err != nil {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.terminal", err)
	}
	return nil
}

func ValidateSyntheticJSON(raw []byte) error {
	if len(raw) == 0 || len(raw) > MaxFixtureBytes {
		return corpusError(CodeFixtureInvalid, StageFixture, "request", nil)
	}
	value, err := decodeJSONValue(raw)
	if err != nil {
		return corpusError(CodeFixtureInvalid, StageFixture, "request.json", err)
	}
	if _, object := value.(map[string]any); !object {
		return corpusError(CodeFixtureInvalid, StageFixture, "request.object", nil)
	}
	nodes := MaxSemanticItems
	if path, unsafe := findSensitiveValue(value, 0, &nodes, "request"); unsafe {
		return corpusError(CodeFixtureInvalid, StageFixture, path, nil)
	}
	return nil
}

func FirstSemanticMismatch(expected, actual Semantic) string {
	if expected.Operation != actual.Operation {
		return "semantic.operation"
	}
	if len(expected.Messages) != len(actual.Messages) {
		return "semantic.messages.length"
	}
	for i := range expected.Messages {
		left, right := expected.Messages[i], actual.Messages[i]
		prefix := "semantic.messages[" + strconv.Itoa(i) + "]"
		if left.Role != right.Role {
			return prefix + ".role"
		}
		if left.Name != right.Name {
			return prefix + ".name"
		}
		if len(left.Content) != len(right.Content) {
			return prefix + ".content.length"
		}
		for j := range left.Content {
			if !equalCanonical(left.Content[j], right.Content[j]) {
				return prefix + ".content[" + strconv.Itoa(j) + "]"
			}
		}
	}
	if path := firstSliceMismatch("semantic.tools", expected.Tools, actual.Tools); path != "" {
		return path
	}
	if path := firstSliceMismatch("semantic.reasoning", expected.Reasoning, actual.Reasoning); path != "" {
		return path
	}
	if path := firstSliceMismatch("semantic.media", expected.Media, actual.Media); path != "" {
		return path
	}
	if !equalCanonical(expected.Usage, actual.Usage) {
		return "semantic.usage"
	}
	if path := firstTerminalMismatch(expected.Terminal, actual.Terminal); path != "" {
		return "semantic." + path
	}
	return ""
}

func firstSliceMismatch[T any](prefix string, expected, actual []T) string {
	if len(expected) != len(actual) {
		return prefix + ".length"
	}
	for i := range expected {
		if !equalCanonical(expected[i], actual[i]) {
			return prefix + "[" + strconv.Itoa(i) + "]"
		}
	}
	return ""
}

func equalCanonical(left, right any) bool {
	leftBytes, leftErr := json.Marshal(left)
	rightBytes, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	leftDigest, leftErr := DigestJSON(leftBytes)
	rightDigest, rightErr := DigestJSON(rightBytes)
	return leftErr == nil && rightErr == nil && leftDigest == rightDigest
}

func firstTerminalMismatch(expected, actual TerminalExpectation) string {
	switch {
	case expected.Status != actual.Status:
		return "terminal.status"
	case expected.Event != actual.Event:
		return "terminal.event"
	case expected.StopReason != actual.StopReason:
		return "terminal.stop_reason"
	case expected.ErrorCode != actual.ErrorCode:
		return "terminal.error_code"
	case len(expected.Sequence) != len(actual.Sequence):
		return "terminal.sequence.length"
	}
	for i := range expected.Sequence {
		if expected.Sequence[i] != actual.Sequence[i] {
			return "terminal.sequence[" + strconv.Itoa(i) + "]"
		}
	}
	return ""
}

func validateContent(content SemanticContent, budget *semanticBudget) error {
	if !budget.take(content.Kind, content.Text) || suspiciousSyntheticString(content.Text) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content", nil)
	}
	pointers := 0
	if content.Tool != nil {
		pointers++
		if err := validateToolEvent(*content.Tool, budget); err != nil {
			return err
		}
	}
	if content.Reasoning != nil {
		pointers++
		if err := validateReasoning(*content.Reasoning, budget); err != nil {
			return err
		}
	}
	if content.Media != nil {
		pointers++
		if err := validateMedia(*content.Media, budget); err != nil {
			return err
		}
	}
	if len(content.StructuredJSON) > 0 {
		pointers++
		if !budget.take(string(content.StructuredJSON)) {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.structured_json", nil)
		}
		if _, err := DigestJSON(content.StructuredJSON); err != nil {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.structured_json", err)
		}
	}
	switch content.Kind {
	case "text", "refusal", "citation":
		if content.Text == "" || pointers != 0 {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.kind", nil)
		}
	case "tool-call", "tool-result":
		if content.Tool == nil || pointers != 1 {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.tool", nil)
		}
	case "reasoning":
		if content.Reasoning == nil || pointers != 1 {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.reasoning", nil)
		}
	case "image", "audio", "file", "pdf":
		if content.Media == nil || pointers != 1 || content.Media.Modality != content.Kind {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.media", nil)
		}
	case "structured-output", "compaction":
		if len(content.StructuredJSON) == 0 || pointers != 1 {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.structured_json", nil)
		}
	default:
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.content.kind", nil)
	}
	return nil
}

func validateTool(tool SemanticTool, budget *semanticBudget) error {
	if !knownToolKind(tool.Kind) || !validToken(tool.Name) || !budget.take(tool.Kind, tool.Name, string(tool.Schema), string(tool.Options)) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tools", nil)
	}
	if len(tool.Schema) > 0 {
		if _, err := DigestJSON(tool.Schema); err != nil {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tools.schema", err)
		}
	}
	if len(tool.Options) > 0 {
		if _, err := DigestJSON(tool.Options); err != nil {
			return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tools.options", err)
		}
	}
	return nil
}

func validateToolEvent(event SemanticToolEvent, budget *semanticBudget) error {
	if !knownToolKind(event.Kind) || !validToken(event.Occurrence) || !validToken(event.Name) || !budget.take(event.Occurrence, event.Kind, event.Name, event.SourceID, event.TargetID, event.ItemID, event.Association, event.State, string(event.Arguments), string(event.Result)) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tool_event", nil)
	}
	if event.State != "call" && event.State != "result" && event.State != "interrupted" {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tool_event.state", nil)
	}
	if event.State == "result" && event.Association == "" {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tool_event.association", nil)
	}
	for _, raw := range []json.RawMessage{event.Arguments, event.Result} {
		if len(raw) > 0 {
			if _, err := DigestJSON(raw); err != nil {
				return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.tool_event.json", err)
			}
		}
	}
	return nil
}

func validateReasoning(reasoning SemanticReasoning, budget *semanticBudget) error {
	if reasoning.Kind == "" || reasoning.Budget < 0 || !budget.take(reasoning.Kind, reasoning.Text, reasoning.Summary, reasoning.Signature, reasoning.EncryptedContent, reasoning.Mode) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.reasoning", nil)
	}
	if suspiciousSyntheticString(reasoning.Text) || suspiciousSyntheticString(reasoning.Summary) || suspiciousSyntheticString(reasoning.Signature) || suspiciousSyntheticString(reasoning.EncryptedContent) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.reasoning.synthetic", nil)
	}
	return nil
}

func validateMedia(media SemanticMedia, budget *semanticBudget) error {
	if media.Modality != "image" && media.Modality != "audio" && media.Modality != "file" && media.Modality != "pdf" {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.media.modality", nil)
	}
	if media.ReferenceKind != "url" && media.ReferenceKind != "inline-data" && media.ReferenceKind != "provider-file-id" && media.ReferenceKind != "provider-file-url" {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.media.reference_kind", nil)
	}
	if media.SizeBytes < 0 || (media.Reference == "" && media.ReferenceDigest == "") || (media.Reference != "" && media.ReferenceDigest != "") {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.media.reference", nil)
	}
	if media.ReferenceDigest != "" && !validSHA256(media.ReferenceDigest) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.media.reference_digest", nil)
	}
	if !budget.take(media.Modality, media.ReferenceKind, media.MIMEType, media.Filename, media.Detail, media.Reference, media.ReferenceDigest, media.ToolOccurrence) || suspiciousSyntheticString(media.Reference) {
		return corpusError(CodeFixtureInvalid, StageFixture, "expected_semantic.media", nil)
	}
	return nil
}

func knownToolKind(kind string) bool {
	switch kind {
	case "function", "custom", "computer", "hosted", "server", "web-search", "image", "mcp", "provider-native":
		return true
	default:
		return false
	}
}

type semanticBudget struct {
	bytes int
	items int
}

func (b *semanticBudget) take(values ...string) bool {
	b.items--
	if b.items < 0 {
		return false
	}
	for _, value := range values {
		b.bytes -= len(value)
		if b.bytes < 0 {
			return false
		}
	}
	return true
}

func writeOperation(h hash.Hash, operation Operation) {
	frameString(h, "operation-kind", string(operation.Kind))
	frameString(h, "compaction-version", string(operation.CompactionVersion))
}

func writeContent(h hash.Hash, content SemanticContent) {
	frameString(h, "content-kind", content.Kind)
	frameString(h, "content-text", content.Text)
	writeOptional(h, "content-tool", content.Tool, func() { writeToolEvent(h, *content.Tool) })
	writeOptional(h, "content-reasoning", content.Reasoning, func() { writeReasoning(h, *content.Reasoning) })
	writeOptional(h, "content-media", content.Media, func() { writeMedia(h, *content.Media) })
	writeRawJSON(h, "content-json", content.StructuredJSON)
}

func writeTool(h hash.Hash, tool SemanticTool) {
	frameString(h, "tool-kind", tool.Kind)
	frameString(h, "tool-name", tool.Name)
	writeRawJSON(h, "tool-schema", tool.Schema)
	writeRawJSON(h, "tool-options", tool.Options)
}

func writeToolEvent(h hash.Hash, event SemanticToolEvent) {
	frameString(h, "occurrence", event.Occurrence)
	frameString(h, "tool-kind", event.Kind)
	frameString(h, "tool-name", event.Name)
	frameString(h, "source-id", event.SourceID)
	frameString(h, "target-id", event.TargetID)
	frameString(h, "item-id", event.ItemID)
	frameString(h, "association", event.Association)
	frameString(h, "state", event.State)
	frameBool(h, "error", event.Error)
	writeRawJSON(h, "arguments", event.Arguments)
	writeRawJSON(h, "result", event.Result)
}

func writeReasoning(h hash.Hash, reasoning SemanticReasoning) {
	frameString(h, "reasoning-kind", reasoning.Kind)
	frameString(h, "reasoning-text", reasoning.Text)
	frameString(h, "reasoning-summary", reasoning.Summary)
	frameString(h, "reasoning-signature", reasoning.Signature)
	frameString(h, "reasoning-encrypted", reasoning.EncryptedContent)
	frameString(h, "reasoning-mode", reasoning.Mode)
	frameInt(h, "reasoning-budget", int64(reasoning.Budget))
}

func writeMedia(h hash.Hash, media SemanticMedia) {
	frameString(h, "media-modality", media.Modality)
	frameString(h, "media-reference-kind", media.ReferenceKind)
	frameString(h, "media-mime", media.MIMEType)
	frameString(h, "media-filename", media.Filename)
	frameString(h, "media-detail", media.Detail)
	frameString(h, "media-reference", media.Reference)
	frameString(h, "media-reference-digest", media.ReferenceDigest)
	frameInt(h, "media-size", media.SizeBytes)
	frameString(h, "media-tool-occurrence", media.ToolOccurrence)
}

func writeUsage(h hash.Hash, usage SemanticUsage) {
	frameInt(h, "usage-input", int64(usage.InputTokens))
	frameInt(h, "usage-output", int64(usage.OutputTokens))
	frameInt(h, "usage-total", int64(usage.TotalTokens))
	frameInt(h, "usage-reasoning", int64(usage.ReasoningTokens))
	frameInt(h, "usage-cache-read", int64(usage.CacheReadTokens))
	frameInt(h, "usage-cache-write", int64(usage.CacheWriteTokens))
}

func writeTerminal(h hash.Hash, terminal TerminalExpectation) {
	frameString(h, "terminal-status", terminal.Status)
	frameString(h, "terminal-event", terminal.Event)
	frameString(h, "terminal-stop", terminal.StopReason)
	frameString(h, "terminal-error", terminal.ErrorCode)
	frameInt(h, "terminal-sequence-count", int64(len(terminal.Sequence)))
	for _, event := range terminal.Sequence {
		frameString(h, "terminal-sequence", event)
	}
}

func writeOptional[T any](h hash.Hash, tag string, value *T, write func()) {
	if value == nil {
		frameString(h, tag, "absent")
		return
	}
	frameString(h, tag, "present")
	write()
}

func writeRawJSON(h hash.Hash, tag string, raw json.RawMessage) {
	if len(raw) == 0 {
		frameString(h, tag, "absent")
		return
	}
	frameString(h, tag, "present")
	value, _ := decodeJSONValue(raw)
	_ = writeJSONValue(h, value, 0)
}

func frameString(h hash.Hash, tag, value string) {
	frameBytes(h, tag, []byte(value))
}

func frameInt(h hash.Hash, tag string, value int64) {
	var data [8]byte
	binary.BigEndian.PutUint64(data[:], uint64(value))
	frameBytes(h, tag, data[:])
}

func frameBool(h hash.Hash, tag string, value bool) {
	if value {
		frameString(h, tag, "1")
	} else {
		frameString(h, tag, "0")
	}
}

func frameBytes(h hash.Hash, tag string, value []byte) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(tag)))
	_, _ = h.Write(size[:])
	_, _ = h.Write([]byte(tag))
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = h.Write(size[:])
	_, _ = h.Write(value)
}

func decodeJSONValue(raw []byte) (any, error) {
	if len(raw) == 0 || len(raw) > MaxFixtureBytes {
		return nil, errors.New("JSON value exceeds bounds")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("JSON value has trailing data")
	}
	return value, nil
}

func writeJSONValue(h hash.Hash, value any, depth int) error {
	if depth > MaxSemanticDepth {
		return errors.New("JSON nesting exceeds limit")
	}
	switch typed := value.(type) {
	case nil:
		frameString(h, "json-null", "")
	case bool:
		frameBool(h, "json-bool", typed)
	case string:
		frameString(h, "json-string", typed)
	case json.Number:
		number, err := canonicalNumber(string(typed))
		if err != nil {
			return err
		}
		frameString(h, "json-number", number)
	case []any:
		frameInt(h, "json-array", int64(len(typed)))
		for i := range typed {
			if err := writeJSONValue(h, typed[i], depth+1); err != nil {
				return err
			}
		}
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		frameInt(h, "json-object", int64(len(keys)))
		for _, key := range keys {
			frameString(h, "json-key", key)
			if err := writeJSONValue(h, typed[key], depth+1); err != nil {
				return err
			}
		}
	default:
		return errors.New("unsupported JSON value")
	}
	return nil
}

func canonicalNumber(number string) (string, error) {
	if number == "" {
		return "", errors.New("empty JSON number")
	}
	sign := ""
	if number[0] == '-' {
		sign = "-"
		number = number[1:]
	}
	exponent := 0
	if index := strings.IndexAny(number, "eE"); index >= 0 {
		parsed, err := strconv.Atoi(number[index+1:])
		if err != nil || parsed > 1000000 || parsed < -1000000 {
			return "", errors.New("invalid JSON number exponent")
		}
		exponent = parsed
		number = number[:index]
	}
	fraction := 0
	if index := strings.IndexByte(number, '.'); index >= 0 {
		fraction = len(number) - index - 1
		number = number[:index] + number[index+1:]
	}
	for len(number) > 0 && number[0] == '0' {
		number = number[1:]
	}
	for len(number) > 0 && number[len(number)-1] == '0' {
		number = number[:len(number)-1]
		exponent++
	}
	if number == "" {
		return "0", nil
	}
	exponent -= fraction
	if exponent == 0 {
		return sign + number, nil
	}
	return sign + number + "e" + strconv.Itoa(exponent), nil
}

var forbiddenSyntheticKeys = map[string]struct{}{
	"authorization": {}, "proxy-authorization": {}, "api-key": {}, "apikey": {},
	"access-token": {}, "refresh-token": {}, "client-secret": {}, "password": {},
	"cookie": {}, "set-cookie": {},
}

func findSensitiveValue(value any, depth int, nodes *int, path string) (string, bool) {
	*nodes--
	if depth > MaxSemanticDepth || *nodes < 0 {
		return path, true
	}
	switch typed := value.(type) {
	case string:
		return path, suspiciousSyntheticString(typed)
	case []any:
		for i := range typed {
			if found, unsafe := findSensitiveValue(typed[i], depth+1, nodes, path+"[]"); unsafe {
				return found, true
			}
		}
	case map[string]any:
		for key, child := range typed {
			normalized := strings.ToLower(strings.ReplaceAll(key, "_", "-"))
			if _, forbidden := forbiddenSyntheticKeys[normalized]; forbidden {
				return path + "." + boundedLabel(key, MaxTokenBytes), true
			}
			if found, unsafe := findSensitiveValue(child, depth+1, nodes, path+"."+boundedLabel(key, MaxTokenBytes)); unsafe {
				return found, true
			}
		}
	}
	return "", false
}

func suspiciousSyntheticString(value string) bool {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	return strings.HasPrefix(lower, "bearer ") ||
		(strings.HasPrefix(lower, "sk-") && len(trimmed) > 12) ||
		(strings.HasPrefix(lower, "ghp_") && len(trimmed) > 12) ||
		(strings.HasPrefix(lower, "xox") && len(trimmed) > 12) ||
		(strings.HasPrefix(trimmed, "AIza") && len(trimmed) > 20)
}
