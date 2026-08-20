package load

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry"
)

// batchProofSink is deliberately a batch-only sink. Keeping the fixture behind
// MaintenanceBatchSink makes this scenario fail to compile if the load proof
// accidentally regresses to the old per-item persistence boundary.
type batchProofSink struct {
	mu       sync.Mutex
	batches  [][]telemetry.Metadata
	batchCh  chan []telemetry.Metadata
	started  chan struct{}
	startOnce sync.Once
	release  <-chan struct{}
	fail     atomic.Bool
}

var _ telemetry.MaintenanceBatchSink = (*batchProofSink)(nil)

func (s *batchProofSink) WriteMetadataBatch(ctx context.Context, batch []telemetry.Metadata) error {
	copyBatch := append([]telemetry.Metadata(nil), batch...)
	s.mu.Lock()
	s.batches = append(s.batches, copyBatch)
	s.mu.Unlock()
	if s.started != nil {
		s.startOnce.Do(func() { close(s.started) })
	}
	if s.release != nil {
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if s.batchCh != nil {
		s.batchCh <- copyBatch
	}
	if s.fail.Load() {
		return errors.New("bulk maintenance persistence failed")
	}
	return nil
}

func waitMaintenanceBatch(t *testing.T, batches <-chan []telemetry.Metadata) []telemetry.Metadata {
	t.Helper()
	select {
	case batch := <-batches:
		return batch
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for maintenance batch")
		return nil
	}
}

func TestMaintenanceBatchScenario(t *testing.T) {
	t.Run("flushes grouped account maintenance roles", func(t *testing.T) {
		sink := &batchProofSink{batchCh: make(chan []telemetry.Metadata, 2)}
		writer := telemetry.NewMaintenanceBatchWriter(context.Background(), sink, telemetry.MaintenanceBatchConfig{
			QueueCapacity: 8,
			FlushSize:     3,
			FlushInterval: time.Second,
			DrainTimeout:  time.Second,
		})

		for _, role := range []string{"quota", "health", "readiness"} {
			requestID := "maintenance-" + role
			if role == "quota" {
				requestID = "authorization=secret"
			}
			if err := writer.Enqueue(telemetry.Metadata{
				RequestID: requestID,
				Provider:  "account-maintenance",
				Surface:   "maintenance/" + role,
			}); err != nil {
				t.Fatalf("enqueue %s: %v", role, err)
			}
		}
		batch := waitMaintenanceBatch(t, sink.batchCh)
		if len(batch) != 3 {
			t.Fatalf("flush-by-count delivered %d entries, want one group of 3", len(batch))
		}
		for _, item := range batch {
			if item.Provider != "account-maintenance" || len(item.RequestID) == 0 {
				t.Fatalf("unexpected maintenance metadata: %#v", item)
			}
		}
		if batch[0].RequestID != "[redacted]" {
			t.Fatalf("maintenance metadata leaked secret identifier: %#v", batch[0])
		}
		if err := writer.Close(context.Background()); err != nil {
			t.Fatalf("close: %v", err)
		}
	})

	t.Run("saturation remains nonblocking", func(t *testing.T) {
		release := make(chan struct{})
		sink := &batchProofSink{started: make(chan struct{}), release: release}
		writer := telemetry.NewMaintenanceBatchWriter(context.Background(), sink, telemetry.MaintenanceBatchConfig{
			QueueCapacity: 2,
			FlushSize:     2,
			FlushInterval: time.Hour,
			DrainTimeout:  time.Second,
		})

		for range 2 {
			if err := writer.Enqueue(telemetry.Metadata{RequestID: "saturation"}); err != nil {
				t.Fatalf("initial enqueue: %v", err)
			}
		}
		select {
		case <-sink.started:
		case <-time.After(time.Second):
			t.Fatal("batch sink did not start")
		}
		start := time.Now()
		for range 128 {
			if err := writer.Enqueue(telemetry.Metadata{RequestID: "saturation"}); err != nil {
				t.Fatalf("saturated enqueue: %v", err)
			}
		}
		if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
			t.Fatalf("saturated enqueue blocked request path for %s", elapsed)
		}
		if writer.Drops() == 0 {
			t.Fatal("saturation did not record dropped maintenance metadata")
		}
		close(release)
		if err := writer.Close(context.Background()); err != nil {
			t.Fatalf("close after saturation: %v", err)
		}
	})

	t.Run("records bulk failures", func(t *testing.T) {
		sink := &batchProofSink{batchCh: make(chan []telemetry.Metadata, 2)}
		sink.fail.Store(true)
		writer := telemetry.NewMaintenanceBatchWriter(context.Background(), sink, telemetry.MaintenanceBatchConfig{
			QueueCapacity: 4,
			FlushSize:     2,
			FlushInterval: time.Second,
			DrainTimeout:  time.Second,
		})
		for range 2 {
			if err := writer.Enqueue(telemetry.Metadata{RequestID: "failure"}); err != nil {
				t.Fatalf("enqueue: %v", err)
			}
		}
		_ = waitMaintenanceBatch(t, sink.batchCh)
		deadline := time.Now().Add(time.Second)
		for writer.Failures() == 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if writer.Failures() == 0 {
			t.Fatal("bulk sink failure was not recorded")
		}
		if err := writer.Close(context.Background()); err != nil {
			t.Fatalf("close after failure: %v", err)
		}
	})

	t.Run("drains partial batch on shutdown", func(t *testing.T) {
		sink := &batchProofSink{batchCh: make(chan []telemetry.Metadata, 2)}
		writer := telemetry.NewMaintenanceBatchWriter(context.Background(), sink, telemetry.MaintenanceBatchConfig{
			QueueCapacity: 16,
			FlushSize:     10,
			FlushInterval: time.Hour,
			DrainTimeout:  time.Second,
		})
		for range 7 {
			if err := writer.Enqueue(telemetry.Metadata{RequestID: "drain"}); err != nil {
				t.Fatalf("enqueue: %v", err)
			}
		}
		if err := writer.Close(context.Background()); err != nil {
			t.Fatalf("close should drain queued metadata: %v", err)
		}
		sink.mu.Lock()
		defer sink.mu.Unlock()
		if len(sink.batches) != 1 || len(sink.batches[0]) != 7 {
			t.Fatalf("shutdown lost queued metadata: batches=%#v", sink.batches)
		}
	})
}
