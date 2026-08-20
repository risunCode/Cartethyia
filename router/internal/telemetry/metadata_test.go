package telemetry

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

type batchMetadataSink struct {
	block  chan struct{}
	batches chan []Metadata
}

func (s *batchMetadataSink) WriteMetadataBatch(_ context.Context, batch []Metadata) error {
	if s.block != nil {
		<-s.block
	}
	copyBatch := append([]Metadata(nil), batch...)
	if s.batches != nil {
		s.batches <- copyBatch
	}
	return nil
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

func TestMaintenanceBatchWriterFlushesByCount(t *testing.T) {
	sink := &batchMetadataSink{batches: make(chan []Metadata, 1)}
	writer := NewMaintenanceBatchWriter(context.Background(), sink, MaintenanceBatchConfig{
		QueueCapacity: 4,
		FlushSize:     2,
		FlushInterval: time.Hour,
	})
	defer writer.Close(context.Background())
	if err := writer.Enqueue(Metadata{RequestID: "one"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Enqueue(Metadata{RequestID: "two"}); err != nil {
		t.Fatal(err)
	}
	select {
	case batch := <-sink.batches:
		if len(batch) != 2 || batch[0].RequestID != "one" || batch[1].RequestID != "two" {
			t.Fatalf("unexpected count-flush batch: %#v", batch)
		}
	case <-time.After(time.Second):
		t.Fatal("count flush did not deliver")
	}
}

func TestMaintenanceBatchWriterFlushesByTime(t *testing.T) {
	sink := &batchMetadataSink{batches: make(chan []Metadata, 1)}
	writer := NewMaintenanceBatchWriter(context.Background(), sink, MaintenanceBatchConfig{
		QueueCapacity: 4,
		FlushSize:     4,
		FlushInterval: 10 * time.Millisecond,
	})
	defer writer.Close(context.Background())
	if err := writer.Enqueue(Metadata{RequestID: "timed"}); err != nil {
		t.Fatal(err)
	}
	select {
	case batch := <-sink.batches:
		if len(batch) != 1 || batch[0].RequestID != "timed" {
			t.Fatalf("unexpected time-flush batch: %#v", batch)
		}
	case <-time.After(time.Second):
		t.Fatal("time flush did not deliver")
	}
}

func TestMaintenanceBatchWriterSaturationDropsWithoutBlocking(t *testing.T) {
	sink := &batchMetadataSink{block: make(chan struct{})}
	writer := NewMaintenanceBatchWriter(context.Background(), sink, MaintenanceBatchConfig{
		QueueCapacity: 1,
		FlushSize:     1,
		FlushInterval: time.Hour,
	})
	defer func() {
		close(sink.block)
		_ = writer.Close(context.Background())
	}()
	for range 20 {
		if err := writer.Enqueue(Metadata{RequestID: "request"}); err != nil {
			t.Fatal(err)
		}
	}
	if writer.Drops() == 0 {
		t.Fatal("expected queue saturation drops")
	}
}

func TestMaintenanceBatchWriterCloseDrainsQueuedMetadata(t *testing.T) {
	sink := &batchMetadataSink{batches: make(chan []Metadata, 1)}
	writer := NewMaintenanceBatchWriter(context.Background(), sink, MaintenanceBatchConfig{
		QueueCapacity: 8,
		FlushSize:     4,
		FlushInterval: time.Hour,
	})
	for _, id := range []string{"one", "two", "three"} {
		if err := writer.Enqueue(Metadata{RequestID: id}); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(context.Background()); err != nil {
		t.Fatalf("close drain failed: %v", err)
	}
	select {
	case batch := <-sink.batches:
		if len(batch) != 3 {
			t.Fatalf("drain batch size=%d want 3", len(batch))
		}
	case <-time.After(time.Second):
		t.Fatal("close did not drain metadata")
	}
}
