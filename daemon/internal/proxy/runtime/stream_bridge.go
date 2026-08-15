package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/transforms"
)

// StreamBridge converts canonical provider events into the SSE framing and
// event ordering required by a client surface. It owns only the downstream
// reader; the source Stream remains responsible for cancellation and pool
// release.
type StreamBridge struct {
	source  *Stream
	surface contracts.Surface
	model   string

	mu       sync.Mutex
	pending  []byte
	finished bool
	closed   bool
	readErr  error
	state    bridgeState
	codecs   *transforms.Registry
}

const maxBridgePendingBytes = 8 << 20

// NewStreamBridge constructs a surface-aware stream reader. A nil source is
// represented as a coded stream failure rather than a panic or silent EOF.
func NewStreamBridge(source *Stream, surface contracts.Surface, model string) *StreamBridge {
	b := &StreamBridge{source: source, surface: surface, model: model}
	if source == nil {
		b.finished = true
		b.readErr = streamError(StreamCodeUpstreamFailure, "stream source is nil", ErrStreamUpstream)
	}
	return b
}

// NewCodecStreamBridge uses canonical response encoders for downstream
// framing while retaining StreamBridge's bounded read/commit lifecycle.
func NewCodecStreamBridge(source *Stream, surface contracts.Surface, model string, codecs *transforms.Registry) *StreamBridge {
	b := NewStreamBridge(source, surface, model)
	b.codecs = codecs
	return b
}

// SurfaceStream is an intentionally descriptive alias for callers that need
// to make the downstream protocol choice explicit.
type SurfaceStream = StreamBridge

func (b *StreamBridge) Read(p []byte) (int, error) {
	return b.ReadContext(context.Background(), p)
}

// ReadContext is the cancellation-aware form used by transports that can
// propagate the request context while preserving the StreamReader contract.
func (b *StreamBridge) ReadContext(ctx context.Context, p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, io.EOF
	}
	for len(b.pending) == 0 && !b.finished {
		ev, err := b.source.Next(ctx)
		if err != nil {
			b.finished = true
			if errors.Is(err, ErrClientDisconnect) {
				b.closed = true
				return 0, err
			}
			b.queueFailure(err)
			break
		}
		var frames []byte
		var encodeErr error
		if b.codecs != nil {
			frames, encodeErr = b.encodeCanonicalEvent(ctx, ev)
		} else {
			frames, encodeErr = b.state.encode(b.surface, ev, b.model)
		}
		if encodeErr != nil {
			b.finished = true
			b.source.Abort(encodeErr)
			b.queueFailure(encodeErr)
			break
		}
		b.pending = append(b.pending, frames...)
		if len(b.pending) > maxBridgePendingBytes {
			b.finished = true
			b.queueFailure(streamError(StreamCodeEventTooLarge, "downstream stream buffer exceeds limit", ErrStreamMalformed))
			break
		}
		if ev.IsTerminal() {
			b.finished = true
			if ev.Reason == "error" || ev.Err != nil {
				if sourceErr := b.source.Err(); sourceErr != nil {
					b.readErr = sourceErr
				} else {
					b.readErr = streamError(StreamCodeUpstreamFailure, "upstream stream failure", ErrStreamUpstream)
				}
			}
		}
	}
	if len(b.pending) > 0 {
		n := copy(p, b.pending)
		b.pending = b.pending[n:]
		return n, nil
	}
	if b.readErr != nil {
		err := b.readErr
		b.readErr = nil
		b.closed = true
		if b.source != nil {
			b.source.Abort(err)
		}
		return 0, err
	}
	b.closed = true
	if b.source != nil {
		_ = b.source.Close()
	}
	return 0, io.EOF
}

func (b *StreamBridge) encodeCanonicalEvent(ctx context.Context, ev StreamEvent) ([]byte, error) {
	if ev.Kind == EventMessageStart {
		return b.state.encode(b.surface, ev, b.model)
	}
	encoder, ok := b.codecs.LookupResponse(contracts.Protocol(b.surface))
	if !ok || encoder == nil {
		return b.state.encode(b.surface, ev, b.model)
	}
	event := NormalizedStreamEvent(ev)
	payload, terr := encoder.EncodeEvent(ctx, &event)
	if terr != nil {
		return nil, terr
	}
	if payload == nil {
		return nil, nil
	}
	frames := frameJSON(payload)
	if ev.IsTerminal() {
		if b.surface == contracts.SurfaceOpenAIChat || b.surface == contracts.SurfaceAnthropic {
			frames = append(frames, frameEvent("message_stop", map[string]any{"type": "message_stop"})...)
		}
		frames = append(frames, frameString("[DONE]")...)
	}
	return frames, nil
}

// NormalizedStreamEvent converts the runtime's compact stream event into the
// canonical response codec event without copying large payloads.
func NormalizedStreamEvent(ev StreamEvent) transforms.NormalizedEvent {
	out := transforms.NormalizedEvent{Type: string(ev.Kind), CallID: ev.CallID, ToolCallID: ev.CallID, ToolName: ev.CallName, Text: ev.Text, ToolArguments: ev.Text}
	if ev.Kind == EventCompactionItem {
		out.Type = transforms.EventItemDone
		out.Text = ev.Text
	}
	if ev.Usage != nil {
		out.Usage = &transforms.Usage{InputTokens: ev.Usage.InputTokens, OutputTokens: ev.Usage.OutputTokens, TotalTokens: ev.Usage.TotalTokens, CacheReadTokens: ev.Usage.CacheReadTokens, CacheWriteTokens: ev.Usage.CacheWriteTokens, ReasoningTokens: ev.Usage.ReasoningTokens}
	}
	if ev.IsTerminal() {
		status := transforms.ItemStatusCompleted
		if ev.Reason == "error" || ev.Err != nil {
			status = transforms.ItemStatusFailed
		}
		out.Type = transforms.EventResponseCompleted
		out.Status = status
		reason := transforms.StopCompleted
		if ev.Reason == "length" {
			reason = transforms.StopLength
		} else if ev.Reason == "tool_call" {
			reason = transforms.StopToolCall
		} else if ev.Reason == "error" || ev.Err != nil {
			reason = transforms.StopError
		}
		out.StopReason = &reason
	}
	return out
}

func (b *StreamBridge) queueFailure(err error) {
	if err == nil {
		return
	}
	code := StreamCodeOf(err)
	if code == "" {
		code = StreamCodeUpstreamFailure
		err = streamError(code, "stream terminated without a coded failure", errors.Join(ErrStreamUpstream, err))
	}
	b.readErr = err
	message := err.Error()
	if coded := new(StreamError); errors.As(err, &coded) && coded.Message != "" {
		message = coded.Message
	}
	b.pending = append(b.pending, b.state.failureFrame(b.surface, b.model, code, message)...)
}

// Close is idempotent and always releases the underlying stream.
func (b *StreamBridge) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.pending = nil
	source := b.source
	b.mu.Unlock()
	if source == nil {
		return nil
	}
	return source.Close()
}

// Abort records a downstream failure on the source before releasing it, so
// dispatch lifecycle observers can distinguish writer errors from clean close.
func (b *StreamBridge) Abort(err error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	b.pending = nil
	source := b.source
	b.mu.Unlock()
	if source != nil {
		if StreamCodeOf(err) == "" {
			var downstream interface{ DownstreamFailure() }
			if errors.As(err, &downstream) {
				err = streamError(StreamCodeWriteFailure, "downstream stream write failed", err)
			} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				err = streamError(StreamCodeClientDisconnect, "client disconnected", errors.Join(ErrClientDisconnect, err))
			} else {
				err = streamError(StreamCodeWriteFailure, "downstream stream write failed", err)
			}
		}
		source.Abort(err)
	}
}

// ProviderStreamPayload is one complete bounded SSE event decoded by the
// transport. It exists only at the transport-to-canonical mapping boundary.
type ProviderStreamPayload struct {
	Data  []byte
	Event string
	ID    string
}

// MapProviderPayload converts a complete provider SSE event to canonical
// events before the router's pre-commit gate or downstream encoder sees it.
func MapProviderPayload(payload ProviderStreamPayload) ([]StreamEvent, error) {
	data := make(map[string]any)
	if len(payload.Data) > 0 {
		if err := json.Unmarshal(payload.Data, &data); err != nil {
			return nil, streamError(StreamCodeMalformedEvent, "stream payload is not valid JSON", errors.Join(ErrStreamMalformed, err))
		}
	}
	if len(data) == 0 && payload.Event == "" {
		return nil, streamError(StreamCodeMalformedEvent, "stream payload is empty", ErrStreamMalformed)
	}
	typ, _ := data["type"].(string)
	if typ == "" {
		// OpenAI-compatible chunks do not carry a top-level type.
		if _, ok := data["choices"]; ok {
			typ = "openai.chunk"
		} else if _, ok := data["usage"]; ok {
			typ = "usage"
		} else {
			typ = payload.Event
		}
	}
	if typ == "" {
		return nil, streamError(StreamCodeMalformedEvent, "stream event type is missing", ErrStreamMalformed)
	}
	mapped, err := mapProviderData(typ, data)
	if err != nil {
		return nil, err
	}
	if payload.ID != "" {
		for index := range mapped {
			if mapped[index].Kind == EventMessageStart && mapped[index].CallID == "" {
				mapped[index].CallID = payload.ID
				break
			}
		}
	}
	return mapped, nil
}

func mapProviderData(typ string, data map[string]any) ([]StreamEvent, error) {
	switch typ {
	case "message_start":
		id, _ := nestedString(data, "message", "id")
		if id == "" {
			id, _ = data["id"].(string)
		}
		out := []StreamEvent{{Kind: EventMessageStart, CallID: id}}
		if message, ok := data["message"].(map[string]any); ok {
			if streamUsage, ok := usageFrom(message["usage"]); ok {
				out = append(out, StreamEvent{Kind: EventUsage, Usage: &streamUsage})
			}
		}
		return out, nil
	case "response.created":
		id, _ := nestedString(data, "response", "id")
		return []StreamEvent{{Kind: EventMessageStart, CallID: id}}, nil
	case "response.output_text.delta":
		text, _ := data["delta"].(string)
		if text == "" {
			return nil, streamError(StreamCodeMalformedEvent, "response text delta is empty", ErrStreamMalformed)
		}
		return []StreamEvent{{Kind: EventTextDelta, Text: text}}, nil
	case "response.reasoning_summary_text.delta":
		text, _ := data["delta"].(string)
		if text == "" {
			return nil, streamError(StreamCodeMalformedEvent, "response reasoning delta is empty", ErrStreamMalformed)
		}
		return []StreamEvent{{Kind: EventThinkingDelta, Text: text}}, nil
	case "response.function_call_arguments.delta":
		text, _ := data["delta"].(string)
		callID, _ := data["item_id"].(string)
		return []StreamEvent{{Kind: EventToolCallDelta, CallID: callID, Text: text}}, nil
	case "response.output_item.added":
		item, _ := data["item"].(map[string]any)
		if item == nil {
			return nil, streamError(StreamCodeMalformedEvent, "response output item is missing", ErrStreamMalformed)
		}
		if itemType, _ := item["type"].(string); itemType == "function_call" {
			id, _ := item["call_id"].(string)
			if id == "" {
				id, _ = item["id"].(string)
			}
			name, _ := item["name"].(string)
			return []StreamEvent{{Kind: EventToolCallStart, CallID: id, CallName: name}}, nil
		}
		return nil, nil
	case "response.completed", "response.incomplete":
		reason := "completed"
		if typ == "response.incomplete" {
			reason = "length"
		}
		out := make([]StreamEvent, 0, 2)
		responseID := ""
		if response, ok := data["response"].(map[string]any); ok {
			responseID, _ = response["id"].(string)
			if streamUsage, ok := usageFrom(response["usage"]); ok {
				out = append(out, StreamEvent{Kind: EventUsage, Usage: &streamUsage})
			}
		}
		return append(out, StreamEvent{Kind: EventMessageStop, CallID: responseID, Reason: reason}), nil
	case "response.failed":
		return []StreamEvent{{Kind: EventMessageStop, Reason: "error", Err: ErrStreamUpstream}}, nil
	case "response.compaction", "compaction":
		payload, _ := json.Marshal(data)
		text, _ := data["summary"].(string)
		return []StreamEvent{{Kind: EventCompactionItem, Payload: payload, Text: text}}, nil
	case "message_stop", "[DONE]":
		return []StreamEvent{{Kind: EventMessageStop, Reason: "completed"}}, nil
	case "error":
		message, _ := nestedString(data, "error", "message")
		if message == "" {
			message, _ = data["message"].(string)
		}
		return []StreamEvent{{Kind: EventMessageStop, Reason: "error", Err: errors.New(message)}}, nil
	case "content_block_delta":
		delta, _ := data["delta"].(map[string]any)
		if delta == nil {
			return nil, streamError(StreamCodeMalformedEvent, "content block delta is missing", ErrStreamMalformed)
		}
		index := intValue(data["index"])
		switch delta["type"] {
		case "text_delta":
			text, _ := delta["text"].(string)
			return []StreamEvent{{Kind: EventTextDelta, Text: text, Index: index}}, nil
		case "thinking_delta":
			text, _ := delta["thinking"].(string)
			return []StreamEvent{{Kind: EventThinkingDelta, Text: text, Index: index}}, nil
		case "input_json_delta":
			text, _ := delta["partial_json"].(string)
			return []StreamEvent{{Kind: EventToolCallDelta, Text: text, Index: index}}, nil
		default:
			return nil, streamError(StreamCodeMalformedEvent, "unsupported content block delta", ErrStreamMalformed)
		}
	case "content_block_start":
		block, _ := data["content_block"].(map[string]any)
		if block == nil {
			return nil, streamError(StreamCodeMalformedEvent, "content block is missing", ErrStreamMalformed)
		}
		typ, _ := block["type"].(string)
		if typ == "tool_use" {
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			return []StreamEvent{{Kind: EventToolCallStart, CallID: id, CallName: name, Index: intValue(data["index"])}}, nil
		}
		return nil, nil
	case "content_block_stop":
		return []StreamEvent{{Kind: EventToolCallEnd, Index: intValue(data["index"])}}, nil
	case "message_delta":
		out := make([]StreamEvent, 0, 2)
		if usage, ok := usageFrom(data["usage"]); ok {
			out = append(out, StreamEvent{Kind: EventUsage, Usage: &usage})
		}
		if delta, ok := data["delta"].(map[string]any); ok {
			if reason, ok := delta["stop_reason"].(string); ok && reason != "" {
				out = append(out, StreamEvent{Kind: EventMessageStop, Reason: canonicalReason(reason)})
			}
		}
		if len(out) == 0 {
			return nil, streamError(StreamCodeMalformedEvent, "message delta is empty", ErrStreamMalformed)
		}
		return out, nil
	case "usage":
		usage, ok := usageFrom(data["usage"])
		if !ok {
			usage, ok = usageFrom(data)
		}
		if !ok {
			return nil, streamError(StreamCodeMalformedEvent, "usage payload is invalid", ErrStreamMalformed)
		}
		return []StreamEvent{{Kind: EventUsage, Usage: &usage}}, nil
	case "openai.chunk":
		return mapOpenAIChunk(data)
	default:
		// Canonical events can be supplied by a transport that already decoded
		// the provider payload. This keeps the bridge additive and idempotent.
		switch typ {
		case string(EventMessageStart):
			id, _ := data["id"].(string)
			return []StreamEvent{{Kind: EventMessageStart, CallID: id}}, nil
		case string(EventTextDelta):
			text, _ := data["text"].(string)
			return []StreamEvent{{Kind: EventTextDelta, Text: text}}, nil
		case string(EventThinkingDelta):
			text, _ := data["text"].(string)
			return []StreamEvent{{Kind: EventThinkingDelta, Text: text}}, nil
		case string(EventMessageStop):
			reason, _ := data["reason"].(string)
			id, _ := data["id"].(string)
			return []StreamEvent{{Kind: EventMessageStop, CallID: id, Reason: reason}}, nil
		default:
			return nil, streamError(StreamCodeMalformedEvent, "unsupported provider stream event", ErrStreamMalformed)
		}
	}
}

func mapOpenAIChunk(data map[string]any) ([]StreamEvent, error) {
	out := make([]StreamEvent, 0, 5)
	terminals := make([]StreamEvent, 0, 1)
	if id, _ := data["id"].(string); id != "" {
		out = append(out, StreamEvent{Kind: EventMessageStart, CallID: id})
	}
	choices, _ := data["choices"].([]any)
	for _, raw := range choices {
		choice, _ := raw.(map[string]any)
		if choice == nil {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		if role, _ := delta["role"].(string); role != "" {
			out = append(out, StreamEvent{Kind: EventMessageStart})
		}
		if text, _ := delta["content"].(string); text != "" {
			out = append(out, StreamEvent{Kind: EventTextDelta, Text: text})
		}
		if text, _ := delta["reasoning_content"].(string); text != "" {
			out = append(out, StreamEvent{Kind: EventThinkingDelta, Text: text})
		}
		if calls, ok := delta["tool_calls"].([]any); ok {
			for _, rawCall := range calls {
				call, _ := rawCall.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				id, _ := call["id"].(string)
				name, _ := fn["name"].(string)
				if id != "" || name != "" {
					out = append(out, StreamEvent{Kind: EventToolCallStart, CallID: id, CallName: name})
				}
				if args, _ := fn["arguments"].(string); args != "" {
					out = append(out, StreamEvent{Kind: EventToolCallDelta, CallID: id, Text: args})
				}
			}
		}
		if reason, _ := choice["finish_reason"].(string); reason != "" {
			if len(terminals) == 0 {
				terminals = append(terminals, StreamEvent{Kind: EventMessageStop, Reason: canonicalReason(reason)})
			}
		}
	}
	if usage, ok := usageFrom(data["usage"]); ok {
		out = append(out, StreamEvent{Kind: EventUsage, Usage: &usage})
	}
	out = append(out, terminals...)
	if len(out) == 0 {
		return nil, streamError(StreamCodeMalformedEvent, "OpenAI stream chunk has no supported fields", ErrStreamMalformed)
	}
	return out, nil
}

func canonicalReason(reason string) string {
	switch reason {
	case "stop", "end_turn", "completed":
		return "completed"
	case "length", "max_tokens", "max_output_tokens":
		return "length"
	case "tool_calls", "tool_use":
		return "tool_call"
	case "content_filter", "refusal":
		return "content_filter"
	default:
		return reason
	}
}

func usageFrom(raw any) (StreamUsage, bool) {
	obj, _ := raw.(map[string]any)
	if obj == nil {
		return StreamUsage{}, false
	}
	read := func(keys ...string) int {
		for _, key := range keys {
			if value, ok := obj[key]; ok {
				switch number := value.(type) {
				case float64:
					return int(number)
				case json.Number:
					n, _ := number.Int64()
					return int(n)
				}
			}
		}
		return 0
	}
	return StreamUsage{
		InputTokens:      read("input_tokens", "prompt_tokens"),
		OutputTokens:     read("output_tokens", "completion_tokens"),
		TotalTokens:      read("total_tokens"),
		CacheReadTokens:  read("cache_read_input_tokens", "cached_tokens"),
		CacheWriteTokens: read("cache_creation_input_tokens", "cache_write_tokens"),
		ReasoningTokens:  read("reasoning_tokens"),
	}, true
}

func nestedString(obj map[string]any, keys ...string) (string, bool) {
	var current any = obj
	for _, key := range keys {
		part, ok := current.(map[string]any)
		if !ok {
			return "", false
		}
		current, ok = part[key]
		if !ok {
			return "", false
		}
	}
	value, ok := current.(string)
	return value, ok
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case json.Number:
		n, _ := number.Int64()
		return int(n)
	default:
		return 0
	}
}

type bridgeState struct {
	id          string
	created     int64
	started     bool
	finished    bool
	sawTool     bool
	seq         int
	textOpen    bool
	text        string
	thinkOpen   bool
	think       string
	tools       map[string]toolState
	toolByIndex map[int]string
}
type toolState struct {
	index int
	name  string
	args  string
}

func (s *bridgeState) init() {
	if s.id == "" {
		s.id = randomID()
	}
	if s.created == 0 {
		s.created = time.Now().Unix()
	}
	if s.tools == nil {
		s.tools = map[string]toolState{}
	}
	if s.toolByIndex == nil {
		s.toolByIndex = map[int]string{}
	}
}
func (s *bridgeState) encode(surface contracts.Surface, ev StreamEvent, model string) ([]byte, error) {
	if ev.Kind == EventMessageStart && ev.CallID != "" {
		s.id = ev.CallID
	}
	s.init()
	if ev.IsTerminal() {
		return s.terminal(surface, ev, model), nil
	}
	switch surface {
	case contracts.SurfaceAnthropic:
		return s.anthropic(ev, model), nil
	case contracts.SurfaceOpenAIResponses:
		return s.responses(ev, model), nil
	case contracts.SurfaceOpenAIChat:
		return s.chat(ev, model), nil
	default:
		return s.generic(ev)
	}
}

func (s *bridgeState) chat(ev StreamEvent, model string) []byte {
	s.init()
	var frames []byte
	first := !s.started
	if first {
		s.started = true
	}
	if first || ev.Kind == EventMessageStart {
		frames = append(frames, frameJSON(map[string]any{
			"id": "chatcmpl-" + s.id, "object": "chat.completion.chunk",
			"created": s.created, "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": ""}, "finish_reason": nil}},
		})...)
	}
	switch ev.Kind {
	case EventThinkingDelta:
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"reasoning_content": ev.Text}, nil))...)
	case EventTextDelta:
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"content": ev.Text}, nil))...)
	case EventToolCallStart:
		s.sawTool = true
		index := len(s.tools)
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"tool_calls": []any{map[string]any{"index": index, "id": ev.CallID, "type": "function", "function": map[string]any{"name": ev.CallName, "arguments": ""}}}}, nil))...)
		s.tools[ev.CallID] = toolState{index: index, name: ev.CallName}
	case EventToolCallDelta:
		s.sawTool = true
		tool := s.tools[ev.CallID]
		tool.args += ev.Text
		s.tools[ev.CallID] = tool
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"tool_calls": []any{map[string]any{"index": tool.index, "function": map[string]any{"arguments": ev.Text}}}}, nil))...)
	case EventToolCallEnd:
		if tool, ok := s.tools[ev.CallID]; ok {
			if tool.args == "" {
				frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"tool_calls": []any{map[string]any{"index": tool.index, "function": map[string]any{"arguments": "{}"}}}}, nil))...)
			}
		}
	case EventUsage:
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{}, usageObject(ev.Usage)))...)
	case EventServerToolResult:
		frames = append(frames, frameJSON(s.chatChunk(model, map[string]any{"content": string(ev.Payload)}, nil))...)
	}
	return frames
}

func (s *bridgeState) chatChunk(model string, delta map[string]any, usage map[string]any) map[string]any {
	out := map[string]any{"id": "chatcmpl-" + s.id, "object": "chat.completion.chunk", "created": s.created, "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}}}
	if usage != nil {
		out["usage"] = usage
	}
	return out
}
func (s *bridgeState) chatFinishChunk(model, finish string) map[string]any {
	return map[string]any{
		"id": "chatcmpl-" + s.id, "object": "chat.completion.chunk",
		"created": s.created, "model": model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}},
	}
}

func (s *bridgeState) anthropic(ev StreamEvent, model string) []byte {
	var frames []byte
	if !s.started {
		s.started = true
		frames = append(frames, frameEvent("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_" + s.id, "type": "message", "role": "assistant",
				"model": model, "content": []any{}, "stop_reason": nil,
				"stop_sequence": nil, "usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
			},
		})...)
	}
	switch ev.Kind {
	case EventThinkingDelta:
		if !s.thinkOpen {
			s.closeAnthropicBlocks(&frames)
			s.thinkOpen = true
			frames = append(frames, frameEvent("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "thinking", "thinking": ""}})...)
		}
		frames = append(frames, frameEvent("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "thinking_delta", "thinking": ev.Text}})...)
	case EventTextDelta:
		if !s.textOpen {
			s.closeAnthropicBlocks(&frames)
			s.textOpen = true
			frames = append(frames, frameEvent("content_block_start", map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "text", "text": ""}})...)
		}
		frames = append(frames, frameEvent("content_block_delta", map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "text_delta", "text": ev.Text}})...)
	case EventToolCallStart:
		s.closeAnthropicBlocks(&frames)
		index := ev.Index
		if index == 0 {
			index = len(s.tools) + 2
		}
		s.tools[ev.CallID] = toolState{index: index, name: ev.CallName}
		s.toolByIndex[index] = ev.CallID
		frames = append(frames, frameEvent("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": ev.CallID, "name": ev.CallName, "input": map[string]any{}}})...)
	case EventToolCallDelta:
		callID := ev.CallID
		if callID == "" {
			callID = s.toolByIndex[ev.Index]
		}
		if tool, ok := s.tools[callID]; ok {
			tool.args += ev.Text
			s.tools[callID] = tool
			frames = append(frames, frameEvent("content_block_delta", map[string]any{"type": "content_block_delta", "index": tool.index, "delta": map[string]any{"type": "input_json_delta", "partial_json": ev.Text}})...)
		}
	case EventToolCallEnd:
		callID := ev.CallID
		if callID == "" {
			callID = s.toolByIndex[ev.Index]
		}
		if tool, ok := s.tools[callID]; ok {
			frames = append(frames, frameEvent("content_block_stop", map[string]any{"type": "content_block_stop", "index": tool.index})...)
			delete(s.tools, callID)
			delete(s.toolByIndex, tool.index)
		}
	case EventServerToolResult:
		s.closeAnthropicBlocks(&frames)
		var block any = map[string]any{"type": "text", "text": string(ev.Payload)}
		if len(ev.Payload) > 0 {
			_ = json.Unmarshal(ev.Payload, &block)
		}
		index := len(s.tools) + 2
		frames = append(frames, frameEvent("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": block})...)
		frames = append(frames, frameEvent("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})...)
	case EventUsage:
		frames = append(frames, frameEvent("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{}, "usage": anthropicUsage(ev.Usage)})...)
	}
	return frames
}

func (s *bridgeState) closeAnthropicBlocks(frames *[]byte) {
	if s.thinkOpen {
		*frames = append(*frames, frameEvent("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})...)
		s.thinkOpen = false
	}
	if s.textOpen {
		*frames = append(*frames, frameEvent("content_block_stop", map[string]any{"type": "content_block_stop", "index": 1})...)
		s.textOpen = false
	}
}

func (s *bridgeState) responses(ev StreamEvent, model string) []byte {
	var frames []byte
	if !s.started {
		s.started = true
		frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.created", "response": map[string]any{"id": "resp_" + s.id, "object": "response", "created_at": s.created, "model": model, "status": "in_progress", "output": []any{}}})...)
		s.seq++
	}
	switch ev.Kind {
	case EventTextDelta:
		frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.output_text.delta", "delta": ev.Text})...)
		s.seq++
	case EventThinkingDelta:
		frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.reasoning_summary_text.delta", "delta": ev.Text})...)
		s.seq++
	case EventToolCallStart:
		s.sawTool = true
		s.tools[ev.CallID] = toolState{index: len(s.tools), name: ev.CallName}
		frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.output_item.added", "output_index": len(s.tools) - 1, "item": map[string]any{"type": "function_call", "id": ev.CallID, "call_id": ev.CallID, "name": ev.CallName, "arguments": ""}})...)
		s.seq++
	case EventToolCallDelta:
		if tool, ok := s.tools[ev.CallID]; ok {
			tool.args += ev.Text
			s.tools[ev.CallID] = tool
			frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.function_call_arguments.delta", "item_id": ev.CallID, "output_index": tool.index, "delta": ev.Text})...)
			s.seq++
		}
	case EventUsage: /* response usage is included in the terminal object */
	}
	return frames
}

func (s *bridgeState) terminal(surface contracts.Surface, ev StreamEvent, model string) []byte {
	if s.finished {
		return nil
	}
	s.finished = true
	reason := canonicalReason(ev.Reason)
	if reason == "" {
		reason = "completed"
	}
	code := StreamCodeUpstreamFailure
	message := "Stream interrupted"
	var coded *StreamError
	if errors.As(ev.Err, &coded) && coded != nil {
		code = coded.Code
		if coded.Message != "" {
			message = coded.Message
		}
	}
	if ev.Err == nil && ev.Reason != "error" {
		code, message = "", ""
	}
	var frames []byte
	switch surface {
	case contracts.SurfaceAnthropic:
		s.closeAnthropicBlocks(&frames)
		for _, tool := range s.tools {
			frames = append(frames, frameEvent("content_block_stop", map[string]any{"type": "content_block_stop", "index": tool.index})...)
		}
		if ev.Reason == "error" || ev.Err != nil {
			frames = append(frames, frameEvent("error", map[string]any{"type": "error", "error": map[string]any{"type": code, "message": message}})...)
		} else {
			frames = append(frames, frameEvent("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": anthropicStop(reason), "stop_sequence": nil}, "usage": map[string]any{}})...)
			frames = append(frames, frameEvent("message_stop", map[string]any{"type": "message_stop"})...)
		}
	case contracts.SurfaceOpenAIResponses:
		if ev.Reason == "error" || ev.Err != nil {
			frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response.failed", "response": map[string]any{"id": "resp_" + s.id, "object": "response", "status": "failed", "error": map[string]any{"code": code, "message": message}}})...)
			s.seq++
		} else {
			status := "completed"
			if reason == "length" || reason == "content_filter" {
				status = "incomplete"
			}
			frames = append(frames, frameJSON(map[string]any{"sequence_number": s.seq, "type": "response." + status, "response": map[string]any{"id": "resp_" + s.id, "object": "response", "status": status, "model": model, "output": []any{}}})...)
			s.seq++
		}
		frames = append(frames, frameString("[DONE]")...)
	default:
		if ev.Reason == "error" || ev.Err != nil {
			frames = append(frames, frameJSON(map[string]any{"error": map[string]any{"message": message, "type": "stream_error", "code": code}, "choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "error"}}})...)
		} else {
			finish := openAIStop(reason, s.sawTool)
			frames = append(frames, frameJSON(s.chatFinishChunk(model, finish))...)
		}
		frames = append(frames, frameEvent("message_stop", map[string]any{"type": "message_stop"})...)
		frames = append(frames, frameString("[DONE]")...)
	}
	return frames
}

func (s *bridgeState) failureFrame(surface contracts.Surface, model, code, message string) []byte {
	return s.terminal(surface, StreamEvent{
		Kind: EventMessageStop, Reason: "error",
		Err: streamError(code, message, ErrStreamUpstream),
	}, model)
}

func (s *bridgeState) generic(ev StreamEvent) ([]byte, error) {
	return frameJSON(map[string]any{"type": ev.Kind, "text": ev.Text}), nil
}

func frameJSON(value any) []byte {
	data, _ := json.Marshal(value)
	frame := make([]byte, len("data: ")+len(data)+2)
	n := copy(frame, "data: ")
	n += copy(frame[n:], data)
	frame[n] = '\n'
	frame[n+1] = '\n'
	return frame
}
func frameEvent(event string, value any) []byte {
	data, _ := json.Marshal(value)
	frame := make([]byte, len("event: ")+len(event)+1+len("data: ")+len(data)+2)
	n := copy(frame, "event: ")
	n += copy(frame[n:], event)
	frame[n] = '\n'
	n++
	n += copy(frame[n:], "data: ")
	n += copy(frame[n:], data)
	frame[n] = '\n'
	frame[n+1] = '\n'
	return frame
}
func frameString(value string) []byte {
	frame := make([]byte, len("data: ")+len(value)+2)
	n := copy(frame, "data: ")
	n += copy(frame[n:], value)
	frame[n] = '\n'
	frame[n+1] = '\n'
	return frame
}
func usageObject(usage *StreamUsage) map[string]any {
	if usage == nil {
		return map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}
	total := usage.TotalTokens
	if total == 0 {
		total = usage.InputTokens + usage.OutputTokens
	}
	return map[string]any{"prompt_tokens": usage.InputTokens, "completion_tokens": usage.OutputTokens, "total_tokens": total, "prompt_tokens_details": map[string]any{"cached_tokens": usage.CacheReadTokens}}
}
func anthropicUsage(usage *StreamUsage) map[string]any {
	if usage == nil {
		return map[string]any{}
	}
	return map[string]any{"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens, "cache_read_input_tokens": usage.CacheReadTokens, "cache_creation_input_tokens": usage.CacheWriteTokens}
}
func openAIStop(reason string, tool bool) string {
	if reason == "error" {
		return "error"
	}
	if reason == "length" {
		return "length"
	}
	if reason == "tool_call" || tool {
		return "tool_calls"
	}
	if reason == "content_filter" {
		return "content_filter"
	}
	return "stop"
}
func anthropicStop(reason string) string {
	switch reason {
	case "length":
		return "max_tokens"
	case "tool_call":
		return "tool_use"
	case "content_filter":
		return "refusal"
	case "compaction":
		return "compaction"
	case "pause_turn":
		return "pause_turn"
	default:
		return "end_turn"
	}
}
func randomID() string {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return hex.EncodeToString(buf[:])
}
