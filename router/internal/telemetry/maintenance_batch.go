package telemetry

import (
	"context"
	"time"
)

// MaintenanceBatchConfig locks the bounded enqueue/flush/drain parameters used
// by maintenance batch writers. The values are intentionally small, explicit,
// and owner-local so the batch implementation can tune them without inventing a
// second authority.
type MaintenanceBatchConfig struct {
	QueueCapacity  int
	FlushSize      int
	FlushInterval  time.Duration
	DrainTimeout   time.Duration
}

// MaintenanceBatchSink is the durable sidecar boundary for batched telemetry
// metadata. Implementations must not retain payloads or secret material.
type MaintenanceBatchSink interface {
	WriteMetadataBatch(context.Context, []Metadata) error
}

// MaintenanceBatchWriter is the bounded queue/flush authority used by the
// runtime. Enqueue must remain non-blocking on saturation; Close drains within
// the caller-provided context.
type MaintenanceBatchWriter interface {
	Enqueue(Metadata) error
	// QueueSize reports the configured bounded queue capacity.
	QueueSize() int
	Drops() uint64
	Failures() uint64
	Close(context.Context) error
}
