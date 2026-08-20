package router

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

const streamSecretSentinel = "credential-SENTINEL-stream-provider-error"

func regressionStream(events ...StreamEvent) *Stream {
	ch := make(chan StreamEvent, len(events))
	for _, event := range events {
		ch <- event
	}
	close(ch)
	return NewStream(ch, nil, 0, 0)
}

func providerPayload(payload string) StreamEvent {
	return providerSSEPayload(payload, "", "")
}

func providerSSEPayload(payload, event, id string) StreamEvent {
	mapped, err := MapProviderPayload(ProviderStreamPayload{Data: []byte(payload), Event: event, ID: id})
	if err != nil {
		return StreamEvent{Kind: EventMessageStop, Reason: "error", Err: err}
	}
	if len(mapped) != 1 {
		panic("provider fixture must map to exactly one canonical event")
	}
	return mapped[0]
}

func TestStreamPreflightCommitBoundaries(t *testing.T) {
	tests := []struct {
		name          string
		events        []StreamEvent
		wantCode      string
		wantReplay    []StreamEventKind
		wantTerminals int
	}{
		{
			name:     "first event provider error remains pre-commit",
			events:   []StreamEvent{providerPayload(`{"type":"error","error":{"message":"upstream body ` + streamSecretSentinel + `"}}`)},
			wantCode: StreamCodeUpstreamFailure,
		},
		{
			name:          "successful terminal only is replayed",
			events:        []StreamEvent{providerSSEPayload(`{"response":{"id":"resp_terminal"}}`, "response.completed", "evt_terminal")},
			wantReplay:    []StreamEventKind{EventMessageStop},
			wantTerminals: 1,
		},
		{
			name: "prelude then provider error remains pre-commit",
			events: []StreamEvent{
				providerPayload(`{"type":"message_start","message":{"id":"msg_prelude"}}`),
				providerPayload(`{"type":"usage","usage":{"input_tokens":3}}`),
				providerPayload(`{"type":"error","error":{"message":"provider refused ` + streamSecretSentinel + `"}}`),
			},
			wantCode: StreamCodeUpstreamFailure,
		},
		{
			name: "semantic output commits and later error is replayed once",
			events: []StreamEvent{
				providerPayload(`{"type":"message_start","message":{"id":"msg_committed"}}`),
				providerPayload(`{"type":"usage","usage":{"input_tokens":2}}`),
				providerPayload(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"visible"}}`),
				providerPayload(`{"type":"error","error":{"message":"late provider failure ` + streamSecretSentinel + `"}}`),
			},
			wantReplay:    []StreamEventKind{EventMessageStart, EventUsage, EventTextDelta, EventMessageStop},
			wantTerminals: 1,
		},
		{
			name: "EOF after prelude is truncation",
			events: []StreamEvent{
				providerPayload(`{"type":"message_start","message":{"id":"msg_eof"}}`),
				providerPayload(`{"type":"usage","usage":{"input_tokens":1}}`),
			},
			wantCode: StreamCodeUpstreamTruncated,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := regressionStream(test.events...)
			defer stream.Close()

			preflightErr := stream.Preflight(context.Background())
			if test.wantCode != "" {
				if got := StreamCodeOf(preflightErr); got != test.wantCode {
					t.Fatalf("Preflight code=%q, want %q (err=%v)", got, test.wantCode, preflightErr)
				}
				if strings.Contains(preflightErr.Error(), streamSecretSentinel) {
					t.Fatalf("preflight error leaked secret sentinel: %q", preflightErr)
				}
				return
			}
			if preflightErr != nil {
				t.Fatalf("Preflight error=%v", preflightErr)
			}
			if len(test.wantReplay) > 1 && !stream.Committed() {
				t.Fatal("semantic preflight did not mark stream committed")
			}

			var gotKinds []StreamEventKind
			terminalCount := 0
			for {
				event, err := stream.Next(context.Background())
				if err != nil {
					if errors.Is(err, io.EOF) {
						break
					}
					t.Fatalf("Next error=%v", err)
				}
				gotKinds = append(gotKinds, event.Kind)
				if event.IsTerminal() {
					terminalCount++
					break
				}
			}
			if len(gotKinds) != len(test.wantReplay) {
				t.Fatalf("replayed kinds=%v, want %v", gotKinds, test.wantReplay)
			}
			for index := range gotKinds {
				if gotKinds[index] != test.wantReplay[index] {
					t.Fatalf("replayed kinds=%v, want %v", gotKinds, test.wantReplay)
				}
			}
			if terminalCount != test.wantTerminals {
				t.Fatalf("terminal output count=%d, want %d", terminalCount, test.wantTerminals)
			}
		})
	}
}

func TestStreamPreflightRejectsOversizedPreludeBeforeCommit(t *testing.T) {
	events := make(chan StreamEvent, maxStreamPreludeEvents+1)
	for index := 0; index <= maxStreamPreludeEvents; index++ {
		events <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: index}}
	}
	close(events)
	stream := NewStream(events, nil, 0, 0)
	defer stream.Close()

	err := stream.Preflight(context.Background())
	if got := StreamCodeOf(err); got != StreamCodePreludeTooLarge {
		t.Fatalf("Preflight code=%q, want %q (err=%v)", got, StreamCodePreludeTooLarge, err)
	}
	if stream.Committed() {
		t.Fatal("oversized prelude crossed the commit point")
	}
}
