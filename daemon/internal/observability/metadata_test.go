package observability

import (
	"context"
	"testing"
	"time"
)

type metadataSink struct {
	block chan struct{}
	got   chan Metadata
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
	if err := w.Enqueue(Metadata{RequestID: " bearer secret", ToolNames: []string{"tool-a", "authorization-header"}, MessageCount: -1}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-sink.got:
		if got.RequestID != "[redacted]" || len(got.ToolNames) != 2 || got.ToolNames[0] != "tool-a" || got.ToolNames[1] != "[redacted]" || got.MessageCount != 0 {
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
	for i := 0; i < 20; i++ {
		if err := w.Enqueue(Metadata{RequestID: "req"}); err != nil {
			t.Fatal(err)
		}
	}
	if w.Drops() == 0 {
		t.Fatal("expected queue saturation drops")
	}
}
