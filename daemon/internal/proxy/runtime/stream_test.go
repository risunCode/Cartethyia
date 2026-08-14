package proxy

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func TestStreamReleasesOnTerminalEvent(t *testing.T) {
	events := make(chan StreamEvent, 1)
	events <- StreamEvent{Kind: EventMessageStop}
	close(events)

	cancelled := false
	stream := NewStream(events, func() { cancelled = true }, 0, 0)

	event, err := stream.Next(context.Background())
	if err != nil {
		t.Fatalf("Next returned error: %v", err)
	}
	if !event.IsTerminal() {
		t.Fatalf("expected terminal event, got %q", event.Kind)
	}
	if !cancelled {
		t.Fatal("terminal event did not cancel the producer")
	}
	select {
	case <-stream.Done():
	default:
		t.Fatal("Done was not closed after terminal event")
	}

	if err := stream.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if _, err := stream.Next(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("Next after terminal event = %v, want io.EOF", err)
	}
}

func TestStreamReportsUpstreamTruncation(t *testing.T) {
	events := make(chan StreamEvent)
	close(events)

	stream := NewStream(events, nil, 0, 0)
	if _, err := stream.Next(context.Background()); StreamCodeOf(err) != StreamCodeUpstreamTruncated {
		t.Fatalf("Next code = %q, want %q (err=%v)", StreamCodeOf(err), StreamCodeUpstreamTruncated, err)
	}
	select {
	case <-stream.Done():
	default:
		t.Fatal("Done was not closed after channel truncation")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("repeated Close returned error: %v", err)
	}
}

func TestStreamAbortRecordsErrorAndCancels(t *testing.T) {
	events := make(chan StreamEvent)
	cancelled := false
	stream := NewStream(events, func() { cancelled = true }, 0, 0)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := stream.Next(ctx); !errors.Is(err, ErrClientDisconnect) {
		t.Fatalf("Next = %v, want ErrClientDisconnect", err)
	}
	if !cancelled {
		t.Fatal("abort did not cancel the producer")
	}
	if !errors.Is(stream.Err(), context.Canceled) {
		t.Fatalf("Stream.Err = %v, want context.Canceled", stream.Err())
	}
}

func TestStreamCloseUnblocksBlockedProducer(t *testing.T) {
	events := make(chan StreamEvent)
	producerCtx, cancelProducer := context.WithCancel(context.Background())
	stream := NewStream(events, cancelProducer, 0, 0)
	producerDone := make(chan struct{})
	go func() {
		defer close(producerDone)
		select {
		case events <- StreamEvent{Kind: EventTextDelta, Text: "blocked"}:
		case <-producerCtx.Done():
		}
	}()

	if err := stream.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	select {
	case <-producerDone:
	case <-time.After(time.Second):
		t.Fatal("blocked producer did not stop after stream close")
	}
}
