package observability

import (
	"context"
	"errors"
	"testing"
	"time"
)

type metadataSink struct {
	block chan struct{}
	got   chan Metadata
}

type retryMetadataSink struct {
	calls int
	done  chan struct{}
}

func (s *retryMetadataSink) WriteMetadata(context.Context, Metadata) error {
	s.calls++
	if s.calls == 1 {
		return errors.New("temporary persistence failure")
	}
	close(s.done)
	return nil
}

func (s *metadataSink) WriteMetadata(_ context.Context, m Metadata) error {
	if s.block != nil {
		<-s.block
	}
	if s.got != nil {
		s.got <- m
	}
	return nil
}

func TestAsyncMetadataWriterRedactsAndBounds(t *testing.T) {
	sink := &metadataSink{got: make(chan Metadata, 1)}
	w := NewAsyncMetadataWriter(context.Background(), sink, 2)
	defer w.Close(context.Background())
	if err := w.Enqueue(Metadata{RequestID: " bearer secret", MessageCount: -1}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-sink.got:
		if got.RequestID != "[redacted]" || got.MessageCount != 0 {
			t.Fatalf("unexpected redaction: %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("metadata was not written")
	}
}

func TestAsyncMetadataWriterSaturationDropsWithoutBlocking(t *testing.T) {
	sink := &metadataSink{block: make(chan struct{})}
	w := NewAsyncMetadataWriter(context.Background(), sink, 1)
	defer func() { close(sink.block); _ = w.Close(context.Background()) }()
	for range 20 {
		if err := w.Enqueue(Metadata{RequestID: "req"}); err != nil {
			t.Fatal(err)
		}
	}
	if w.Drops() == 0 {
		t.Fatal("expected queue saturation drops")
	}
}

func TestAsyncMetadataWriterRetriesOnceWithoutChangingCallerOutcome(t *testing.T) {
	sink := &retryMetadataSink{done: make(chan struct{})}
	writer := NewAsyncMetadataWriter(context.Background(), sink, 2)
	defer writer.Close(context.Background())
	if err := writer.Enqueue(Metadata{RequestID: "request"}); err != nil {
		t.Fatalf("enqueue returned persistence failure: %v", err)
	}
	select {
	case <-sink.done:
	case <-time.After(time.Second):
		t.Fatal("bounded metadata retry did not run")
	}
	if writer.Failures() != 1 || sink.calls != 2 {
		t.Fatalf("failures/calls=%d/%d want 1/2", writer.Failures(), sink.calls)
	}
}
