package router

import (
	"context"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry"
)

func TestCompleteMetadataPreservesSuccessAndComputesLatency(t *testing.T) {
	started := time.Date(2026, time.August, 15, 12, 0, 0, 0, time.UTC)
	ended := started.Add(1250 * time.Millisecond)
	meta := telemetry.Metadata{Outcome: telemetry.OutcomeSuccess, StartedAt: started}

	completeMetadata(&meta, nil, false, ended)

	if meta.Outcome != telemetry.OutcomeSuccess {
		t.Fatalf("outcome = %q, want success", meta.Outcome)
	}
	if !meta.EndedAt.Equal(ended) {
		t.Fatalf("ended at = %v, want %v", meta.EndedAt, ended)
	}
	if meta.LatencyMS != 1250 {
		t.Fatalf("latency = %d, want 1250", meta.LatencyMS)
	}
	if meta.Cancelled {
		t.Fatal("successful metadata marked cancelled")
	}
}

func TestCompleteMetadataMarksCancellation(t *testing.T) {
	started := time.Date(2026, time.August, 15, 12, 0, 0, 0, time.UTC)
	meta := telemetry.Metadata{Outcome: telemetry.OutcomeSuccess, StartedAt: started}

	completeMetadata(&meta, context.Canceled, false, started.Add(time.Second))

	if meta.Outcome != telemetry.OutcomeCancelled {
		t.Fatalf("outcome = %q, want cancelled", meta.Outcome)
	}
	if !meta.Cancelled {
		t.Fatal("cancellation metadata not marked cancelled")
	}
}
