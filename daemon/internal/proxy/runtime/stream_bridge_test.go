package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

func readBridge(t *testing.T, bridge *StreamBridge) (string, error) {
	t.Helper()
	var out bytes.Buffer
	buf := make([]byte, 128)
	for {
		n, err := bridge.Read(buf)
		if n > 0 {
			_, _ = out.Write(buf[:n])
		}
		if err != nil {
			return out.String(), err
		}
	}
}

func TestStreamBridgeOpenAITerminalOrderingAndClose(t *testing.T) {
	events := make(chan StreamEvent, 2)
	events <- StreamEvent{Kind: EventTextDelta, Text: "hello"}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)
	var cancels atomic.Int32
	stream := NewStream(events, func() { cancels.Add(1) }, 0, 0)
	bridge := NewStreamBridge(stream, contracts.SurfaceOpenAIChat, "gpt-test")
	body, err := readBridge(t, bridge)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("bridge read error = %v, want EOF", err)
	}
	role := strings.Index(body, `"role":"assistant"`)
	content := strings.Index(body, `"content":"hello"`)
	finish := strings.Index(body, `"finish_reason":"stop"`)
	done := strings.Index(body, "data: [DONE]")
	if role < 0 || content < 0 || finish < 0 || done < 0 || !(role < content && content < finish && finish < done) {
		t.Fatalf("terminal framing order invalid: %s", body)
	}
	if err := bridge.Close(); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Close(); err != nil {
		t.Fatal(err)
	}
	if got := cancels.Load(); got != 1 {
		t.Fatalf("cancel count = %d, want exactly one", got)
	}
}

func TestStreamBridgeAnthropicClosesBlockBeforeTerminal(t *testing.T) {
	events := make(chan StreamEvent, 2)
	events <- StreamEvent{Kind: EventTextDelta, Text: "hello"}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	close(events)
	bridge := NewStreamBridge(NewStream(events, nil, 0, 0), contracts.SurfaceAnthropic, "claude-test")
	body, err := readBridge(t, bridge)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("bridge read error = %v, want EOF", err)
	}
	blockStop := strings.Index(body, "event: content_block_stop")
	messageDelta := strings.Index(body, "event: message_delta")
	messageStop := strings.Index(body, "event: message_stop")
	if blockStop < 0 || messageDelta < 0 || messageStop < 0 || !(blockStop < messageDelta && messageDelta < messageStop) {
		t.Fatalf("anthropic terminal ordering invalid: %s", body)
	}
}

func TestStreamBridgeMalformedAndTruncatedAreCoded(t *testing.T) {
	malformed := make(chan StreamEvent, 1)
	malformed <- StreamEvent{Kind: EventTextDelta, Payload: []byte(`{}`)}
	close(malformed)
	bridge := NewStreamBridge(NewStream(malformed, nil, 0, 0), contracts.SurfaceOpenAIChat, "gpt")
	body, err := readBridge(t, bridge)
	if StreamCodeOf(err) != StreamCodeMalformedEvent {
		t.Fatalf("malformed code = %q, want %q (body=%s)", StreamCodeOf(err), StreamCodeMalformedEvent, body)
	}
	if !strings.Contains(body, StreamCodeMalformedEvent) && !strings.Contains(body, "stream_error") {
		t.Fatalf("malformed stream did not emit error frame: %s", body)
	}

	truncated := make(chan StreamEvent)
	close(truncated)
	bridge = NewStreamBridge(NewStream(truncated, nil, 0, 0), contracts.SurfaceOpenAIChat, "gpt")
	body, err = readBridge(t, bridge)
	if StreamCodeOf(err) != StreamCodeUpstreamTruncated {
		t.Fatalf("truncated code = %q, want %q (body=%s)", StreamCodeOf(err), StreamCodeUpstreamTruncated, body)
	}
}

func TestStreamBridgeTerminalFailureFramesAndReturnsCode(t *testing.T) {
	events := make(chan StreamEvent, 1)
	events <- StreamEvent{Kind: EventMessageStop, Reason: "error", Err: errors.New("upstream broke")}
	close(events)
	bridge := NewStreamBridge(NewStream(events, nil, 0, 0), contracts.SurfaceOpenAIChat, "gpt")
	body, err := readBridge(t, bridge)
	if StreamCodeOf(err) != StreamCodeUpstreamFailure {
		t.Fatalf("terminal failure code = %q, want %q", StreamCodeOf(err), StreamCodeUpstreamFailure)
	}
	if !strings.Contains(body, "stream_error") || !strings.Contains(body, "[DONE]") {
		t.Fatalf("terminal failure framing missing error and done: %s", body)
	}
}

func TestStreamBridgeDisconnectBeforeHeaders(t *testing.T) {
	events := make(chan StreamEvent)
	var cancels atomic.Int32
	bridge := NewStreamBridge(NewStream(events, func() { cancels.Add(1) }, 0, 0), contracts.SurfaceOpenAIChat, "gpt")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := bridge.ReadContext(ctx, make([]byte, 32)); StreamCodeOf(err) != StreamCodeClientDisconnect {
		t.Fatalf("disconnect code = %q, want %q", StreamCodeOf(err), StreamCodeClientDisconnect)
	}
	if got := cancels.Load(); got != 1 {
		t.Fatalf("cancel count = %d, want one", got)
	}
}

func TestStreamIdleAndTotalTimeouts(t *testing.T) {
	idle := NewStream(make(chan StreamEvent), nil, 10*time.Millisecond, 0)
	if _, err := idle.Next(context.Background()); StreamCodeOf(err) != StreamCodeIdleTimeout {
		t.Fatalf("idle code = %q, want %q", StreamCodeOf(err), StreamCodeIdleTimeout)
	}
	totalEvents := make(chan StreamEvent, 1)
	totalEvents <- StreamEvent{Kind: EventTextDelta, Text: "first"}
	total := NewStream(totalEvents, nil, 0, 15*time.Millisecond)
	if _, err := total.Next(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := total.Next(context.Background()); StreamCodeOf(err) != StreamCodeTotalTimeout {
		t.Fatalf("total code = %q, want %q", StreamCodeOf(err), StreamCodeTotalTimeout)
	}
}

func TestMapProviderOpenAIChunk(t *testing.T) {
	events, err := MapProviderStreamEvent(ProviderStreamEvent{Data: map[string]any{
		"choices": []any{map[string]any{"delta": map[string]any{"content": "hi"}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Kind != EventTextDelta || events[0].Text != "hi" {
		t.Fatalf("mapped events = %#v", events)
	}
}
