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

func canonicalProviderEvent(payload string) StreamEvent {
	mapped, err := MapProviderPayload(ProviderStreamPayload{Data: []byte(payload)})
	if err != nil {
		return StreamEvent{Kind: EventMessageStop, Reason: "error", Err: err}
	}
	if len(mapped) != 1 {
		panic("provider fixture must map to exactly one canonical event")
	}
	return mapped[0]
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
	malformed <- canonicalProviderEvent(`{}`)
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

type manualStreamTimer struct {
	ticks      chan time.Time
	resetCalls []time.Duration
	stopCalls  int
	active     bool
}

func newManualStreamTimer() *manualStreamTimer {
	return &manualStreamTimer{ticks: make(chan time.Time, 1), active: true}
}

func (t *manualStreamTimer) channel() <-chan time.Time { return t.ticks }
func (t *manualStreamTimer) Stop() bool {
	t.stopCalls++
	wasActive := t.active
	t.active = false
	return wasActive
}
func (t *manualStreamTimer) Reset(duration time.Duration) bool {
	wasActive := t.active
	t.active = true
	t.resetCalls = append(t.resetCalls, duration)
	return wasActive
}
func (t *manualStreamTimer) fire() {
	t.active = false
	t.ticks <- time.Time{}
}

func TestStreamIdleAndTotalTimeouts(t *testing.T) {
	idleEvents := make(chan StreamEvent, 1)
	idleEvents <- StreamEvent{Kind: EventTextDelta, Text: "first"}
	idleTimer := newManualStreamTimer()
	idle := newStreamWithTimerFactory(idleEvents, nil, time.Minute, 0, func(time.Duration) streamTimer { return idleTimer })
	if _, err := idle.Next(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(idleTimer.resetCalls) != 1 || idleTimer.resetCalls[0] != time.Minute {
		t.Fatalf("idle timer resets=%v, want one reset to %v", idleTimer.resetCalls, time.Minute)
	}
	idleTimer.fire()
	if _, err := idle.Next(context.Background()); StreamCodeOf(err) != StreamCodeIdleTimeout {
		t.Fatalf("idle code = %q, want %q", StreamCodeOf(err), StreamCodeIdleTimeout)
	}
	if idleTimer.stopCalls < 2 {
		t.Fatalf("idle timer stop calls=%d, want reset drain plus final stop", idleTimer.stopCalls)
	}

	totalTimer := newManualStreamTimer()
	total := newStreamWithTimerFactory(make(chan StreamEvent), nil, 0, time.Hour, func(time.Duration) streamTimer { return totalTimer })
	totalTimer.fire()
	if _, err := total.Next(context.Background()); StreamCodeOf(err) != StreamCodeTotalTimeout {
		t.Fatalf("total code = %q, want %q", StreamCodeOf(err), StreamCodeTotalTimeout)
	}
	if len(totalTimer.resetCalls) != 0 {
		t.Fatalf("total timer reset unexpectedly: %v", totalTimer.resetCalls)
	}
	if totalTimer.stopCalls != 1 {
		t.Fatalf("total timer stop calls=%d, want one final stop", totalTimer.stopCalls)
	}
}

func TestStreamBridgeReplaysTerminalOnlyOnceAcrossSurfaces(t *testing.T) {
	tests := []struct {
		name    string
		surface contracts.Surface
		counts  map[string]int
	}{
		{
			name:    "OpenAI Chat",
			surface: contracts.SurfaceOpenAIChat,
			counts: map[string]int{
				`"finish_reason":"stop"`: 1,
				"event: message_stop":    1,
				"data: [DONE]":           1,
			},
		},
		{
			name:    "OpenAI Responses",
			surface: contracts.SurfaceOpenAIResponses,
			counts: map[string]int{
				`"type":"response.completed"`: 1,
				"data: [DONE]":                1,
			},
		},
		{
			name:    "Anthropic",
			surface: contracts.SurfaceAnthropic,
			counts: map[string]int{
				"event: message_delta": 1,
				"event: message_stop":  1,
				"data: [DONE]":         0,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := regressionStream(canonicalProviderEvent(`{"type":"response.completed","response":{"id":"terminal_only"}}`))
			if err := stream.Preflight(context.Background()); err != nil {
				t.Fatalf("Preflight error=%v", err)
			}
			if stream.ResponseID() != "terminal_only" {
				t.Fatalf("response ID=%q, want terminal_only", stream.ResponseID())
			}
			body, err := readBridge(t, NewStreamBridge(stream, test.surface, "fixture-model"))
			if !errors.Is(err, io.EOF) {
				t.Fatalf("bridge read error=%v, want EOF", err)
			}
			for fragment, want := range test.counts {
				if got := strings.Count(body, fragment); got != want {
					t.Fatalf("count(%q)=%d, want %d; body=%s", fragment, got, want, body)
				}
			}
		})
	}
}

func TestStreamBridgeEncodesPostCommitFailureWithoutRepreflight(t *testing.T) {
	tests := []struct {
		name    string
		surface contracts.Surface
		counts  map[string]int
	}{
		{
			name:    "OpenAI Chat",
			surface: contracts.SurfaceOpenAIChat,
			counts: map[string]int{
				`"finish_reason":"error"`: 1,
				"event: message_stop":     1,
				"data: [DONE]":            1,
			},
		},
		{
			name:    "OpenAI Responses",
			surface: contracts.SurfaceOpenAIResponses,
			counts: map[string]int{
				`"type":"response.failed"`: 1,
				"data: [DONE]":             1,
			},
		},
		{
			name:    "Anthropic",
			surface: contracts.SurfaceAnthropic,
			counts: map[string]int{
				"event: error":        1,
				"event: message_stop": 0,
				"data: [DONE]":        0,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := regressionStream(
				canonicalProviderEvent(`{"type":"message_start","message":{"id":"msg_late_failure"}}`),
				canonicalProviderEvent(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}`),
				canonicalProviderEvent(`{"type":`),
			)
			if err := stream.Preflight(context.Background()); err != nil {
				t.Fatalf("Preflight error=%v", err)
			}
			if !stream.Committed() {
				t.Fatal("semantic provider payload did not commit the stream")
			}
			body, err := readBridge(t, NewStreamBridge(stream, test.surface, "fixture-model"))
			if got := StreamCodeOf(err); got != StreamCodeMalformedEvent {
				t.Fatalf("bridge code=%q, want %q (err=%v)", got, StreamCodeMalformedEvent, err)
			}
			for fragment, want := range test.counts {
				if got := strings.Count(body, fragment); got != want {
					t.Fatalf("count(%q)=%d, want %d; body=%s", fragment, got, want, body)
				}
			}
		})
	}
}

type markedDownstreamFailure struct{ cause error }

func (e *markedDownstreamFailure) Error() string    { return e.cause.Error() }
func (e *markedDownstreamFailure) Unwrap() error    { return e.cause }
func (*markedDownstreamFailure) DownstreamFailure() {}

func TestStreamBridgeClassifiesDownstreamAbortExactlyOnce(t *testing.T) {
	source := NewStream(make(chan StreamEvent), nil, 0, 0)
	finalizers := 0
	var finalErr error
	source.AttachFinalizer(func(streamErr, sideEffectErr error) {
		if sideEffectErr != nil {
			t.Errorf("side-effect error=%v, want nil", sideEffectErr)
		}
		finalizers++
		finalErr = streamErr
	})
	bridge := NewStreamBridge(source, contracts.SurfaceOpenAIResponses, "fixture-model")
	writeErr := errors.New("client write failed")
	bridge.Abort(&markedDownstreamFailure{cause: writeErr})
	bridge.Abort(errors.New("late abort"))
	_ = bridge.Close()
	if finalizers != 1 {
		t.Fatalf("finalizer count=%d, want 1", finalizers)
	}
	if StreamCodeOf(finalErr) != StreamCodeWriteFailure || !errors.Is(finalErr, writeErr) {
		t.Fatalf("final error=%v code=%q, want downstream write failure", finalErr, StreamCodeOf(finalErr))
	}
}
