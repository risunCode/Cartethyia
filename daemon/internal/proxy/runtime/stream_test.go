package proxy

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
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
	if !stream.closed.Load() {
		t.Fatal("stream was not closed after terminal event")
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
	if !stream.closed.Load() {
		t.Fatal("stream was not closed after channel truncation")
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

type streamQuotaSpy struct {
	reconciles int
	releases   int
	tokens     usage.Tokens
	err        error
}

func (s *streamQuotaSpy) Reconcile(_ context.Context, tokens usage.Tokens) error {
	s.reconciles++
	s.tokens = tokens
	return s.err
}

func (s *streamQuotaSpy) Release(context.Context, tokenbudget.ReleaseReason) error {
	s.releases++
	return nil
}

func TestStreamReconcilesDurableReservationOnceForEveryOutcome(t *testing.T) {
	for _, test := range []struct {
		name    string
		outcome observability.StreamOutcome
		trigger func(*Stream)
	}{
		{name: "clean", outcome: observability.StreamClean, trigger: func(stream *Stream) {
			stream.ch <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
			_, _ = stream.Next(context.Background())
		}},
		{name: "failed", outcome: observability.StreamFailed, trigger: func(stream *Stream) {
			stream.ch <- StreamEvent{Kind: EventMessageStop, Reason: "error", Err: ErrStreamUpstream}
			_, _ = stream.Next(context.Background())
		}},
		{name: "canceled", outcome: observability.StreamCanceled, trigger: func(stream *Stream) { stream.Abort(context.Canceled) }},
		{name: "stalled", outcome: observability.StreamStalled, trigger: func(stream *Stream) {
			stream.Abort(streamError(StreamCodeIdleTimeout, "stream idle timeout", ErrStreamStall))
		}},
		{name: "truncated", outcome: observability.StreamTruncated, trigger: func(stream *Stream) {
			close(stream.ch)
			_, _ = stream.Next(context.Background())
		}},
		{name: "downstream write", outcome: observability.StreamDownstreamWrite, trigger: func(stream *Stream) {
			stream.Abort(streamError(StreamCodeWriteFailure, "downstream stream write failed", io.ErrShortWrite))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			reservation := &streamQuotaSpy{}
			sink := &observability.CountingSink{}
			recorder := observability.NewRecorder(context.Background(), sink, observability.WithCapacity(4))
			registry := observability.NewRegistry().WithRecorder(recorder)
			stream := NewStream(make(chan StreamEvent, 1), nil, 0, 0)
			stream.AttachTokenReservation(context.Background(), reservation)
			stream.AttachFinalizationEvidence(registry, observability.StreamFinalizationEvidence{
				RequestID: test.name, Provider: "provider", Model: "model",
				AccountID: "authorization=stream-secret-sentinel", Surface: "stream",
			})
			test.trigger(stream)
			_ = stream.Close()
			stream.Abort(errors.New("late abort"))
			if err := recorder.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			events := sink.Events()
			if len(events) != 1 || events[0].Stage != observability.StageStreamFinalization {
				t.Fatalf("finalization evidence=%#v, want exactly one event", events)
			}
			if events[0].StreamOutcome != test.outcome {
				t.Fatalf("stream outcome=%q want=%q", events[0].StreamOutcome, test.outcome)
			}
			if events[0].AccountID != "[redacted]" {
				t.Fatalf("finalization account identity=%q", events[0].AccountID)
			}
			if reservation.reconciles != 1 || reservation.releases != 0 {
				t.Fatalf("reconciles/releases=%d/%d, want 1/0", reservation.reconciles, reservation.releases)
			}
			if reservation.tokens != (usage.Tokens{}) {
				t.Fatalf("unknown usage=%+v, want all-nil token evidence", reservation.tokens)
			}
		})
	}
}

func TestStreamFinalizerAccumulatesCanonicalUsageAndResponseIdentity(t *testing.T) {
	events := make(chan StreamEvent, 4)
	events <- StreamEvent{Kind: EventMessageStart, CallID: "resp_canonical"}
	events <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{InputTokens: 11, CacheReadTokens: 3}}
	events <- StreamEvent{Kind: EventUsage, Usage: &StreamUsage{OutputTokens: 7, CacheWriteTokens: 2, ReasoningTokens: 5}}
	events <- StreamEvent{Kind: EventMessageStop, Reason: "completed"}
	reservation := &streamQuotaSpy{}
	finalizers := 0
	stream := NewStream(events, nil, 0, 0)
	stream.AttachTokenReservation(context.Background(), reservation)
	stream.AttachFinalizer(func(streamErr, sideEffectErr error) {
		if streamErr != nil || sideEffectErr != nil {
			t.Errorf("finalizer errors=%v/%v, want nil", streamErr, sideEffectErr)
		}
		finalizers++
	})
	for {
		event, err := stream.Next(context.Background())
		if err != nil {
			t.Fatalf("Next error=%v", err)
		}
		if event.IsTerminal() {
			break
		}
	}
	_ = stream.Close()
	stream.Abort(errors.New("late abort"))
	if finalizers != 1 || reservation.reconciles != 1 {
		t.Fatalf("finalizers/reconciles=%d/%d, want 1/1", finalizers, reservation.reconciles)
	}
	if stream.ResponseID() != "resp_canonical" {
		t.Fatalf("response ID=%q, want resp_canonical", stream.ResponseID())
	}
	assertToken := func(name string, got *int64, want int64) {
		t.Helper()
		if got == nil || *got != want {
			t.Fatalf("%s tokens=%v, want %d", name, got, want)
		}
	}
	assertToken("input", reservation.tokens.Input, 11)
	assertToken("output", reservation.tokens.Output, 7)
	assertToken("total", reservation.tokens.Total, 18)
	assertToken("cache read", reservation.tokens.CachedRead, 3)
	assertToken("cache write", reservation.tokens.CachedWrite, 2)
	assertToken("reasoning", reservation.tokens.Reasoning, 5)
}
