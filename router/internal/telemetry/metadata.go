package telemetry

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var ErrMetadataClosed = errors.New("observability: metadata writer is closed")

const MaxMetadataQueue = 4096

// Metadata is the bounded, payload-free request metadata persisted by a
// MetadataSink. Only aggregate counts are retained; tool names and content
// have no representation in this contract.
type Metadata struct {
	RequestID        string
	Provider         string
	Model            string
	Surface          string
	Outcome          Outcome
	StartedAt        time.Time
	EndedAt          time.Time
	LatencyMS        int64
	MessageCount     int
	ToolCount        int
	ImageCount       int
	InputTokens      *int64
	OutputTokens     *int64
	CachedTokens     *int64
	CacheWriteTokens *int64
	Cancelled        bool
}

func (m Metadata) Redacted() Metadata {
	m.RequestID = boundedIdentifier(m.RequestID, 96)
	m.Provider = boundedIdentifier(m.Provider, 64)
	m.Model = boundedIdentifier(m.Model, 128)
	m.Surface = boundedIdentifier(m.Surface, 32)
	if m.MessageCount < 0 {
		m.MessageCount = 0
	}
	if m.ToolCount < 0 {
		m.ToolCount = 0
	}
	if m.ImageCount < 0 {
		m.ImageCount = 0
	}
	return m
}

func boundedIdentifier(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		value = value[:max]
	}
	for _, marker := range []string{"authorization", "access_token", "refresh_token", "api_key", "secret", "password", "credential", "cookie", "bearer ", "token="} {
		if strings.Contains(strings.ToLower(value), marker) {
			return "[redacted]"
		}
	}
	for i, r := range value {
		if r < 0x20 || r == 0x7f {
			return value[:i]
		}
	}
	return value
}

// MetadataSink is the durable PostgreSQL boundary. Implementations must not
// retain payloads or secret material.
type MetadataSink interface {
	WriteMetadata(context.Context, Metadata) error
}

// AsyncMetadataWriter enqueues metadata without waiting on the sink. A full
// queue drops metadata and increments Drops; requests are never throttled.
// Batch-capable sinks receive count- or time-triggered batches.
type AsyncMetadataWriter struct {
	queue     chan metadataWork
	batchSink MaintenanceBatchSink
	config    MaintenanceBatchConfig
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	closed    atomic.Bool
	draining  atomic.Bool
	queueDepth atomic.Int64
	drops     atomic.Uint64
	failures  atomic.Uint64
	flushes   atomic.Uint64
	flushNanos atomic.Int64
	wg        sync.WaitGroup
	done      chan struct{}
	closeCh   chan context.Context
}

var _ MaintenanceBatchWriter = (*AsyncMetadataWriter)(nil)

type metadataWork struct {
	metadata Metadata
	retried  bool
}

func NewAsyncMetadataWriter(ctx context.Context, sink MetadataSink, capacity int) *AsyncMetadataWriter {
	config := MaintenanceBatchConfig{QueueCapacity: capacity, FlushSize: 1}
	if batchSink, ok := sink.(MaintenanceBatchSink); ok {
		config.FlushSize = defaultMaintenanceFlushSize
		return newMaintenanceBatchWriter(ctx, batchSink, config)
	}
	return newMaintenanceBatchWriter(ctx, metadataSinkBatchAdapter{sink: sink}, config)
}

const (
	defaultMaintenanceQueueCapacity = 256
	defaultMaintenanceFlushSize     = 32
	defaultMaintenanceFlushInterval = 100 * time.Millisecond
	defaultMaintenanceDrainTimeout  = 5 * time.Second
)

// NewMaintenanceBatchWriter constructs the bounded, non-blocking maintenance
// metadata writer. The returned writer also preserves the historical
// AsyncMetadataWriter type used by runtime wiring.
func NewMaintenanceBatchWriter(ctx context.Context, sink MaintenanceBatchSink, config MaintenanceBatchConfig) *AsyncMetadataWriter {
	return newMaintenanceBatchWriter(ctx, sink, config)
}

func newMaintenanceBatchWriter(ctx context.Context, sink MaintenanceBatchSink, config MaintenanceBatchConfig) *AsyncMetadataWriter {
	if ctx == nil {
		ctx = context.Background()
	}
	if config.QueueCapacity <= 0 {
		config.QueueCapacity = defaultMaintenanceQueueCapacity
	} else if config.QueueCapacity > MaxMetadataQueue {
		config.QueueCapacity = MaxMetadataQueue
	}
	if config.FlushSize <= 0 {
		config.FlushSize = defaultMaintenanceFlushSize
	}
	if config.FlushSize > config.QueueCapacity {
		config.FlushSize = config.QueueCapacity
	}
	if config.FlushInterval <= 0 {
		config.FlushInterval = defaultMaintenanceFlushInterval
	}
	if config.DrainTimeout <= 0 {
		config.DrainTimeout = defaultMaintenanceDrainTimeout
	}
	workerCtx, cancel := context.WithCancel(ctx)
	w := &AsyncMetadataWriter{
		queue:     make(chan metadataWork, config.QueueCapacity),
		batchSink: sink,
		config:    config,
		ctx:       workerCtx,
		cancel:    cancel,
		done:      make(chan struct{}),
		closeCh:   make(chan context.Context, 1),
	}
	w.wg.Add(1)
	go w.run()
	return w
}

func (w *AsyncMetadataWriter) Enqueue(m Metadata) error {
	if w == nil || w.closed.Load() {
		return ErrMetadataClosed
	}
	m = m.Redacted()
	w.queueDepth.Add(1)
	select {
	case w.queue <- metadataWork{metadata: m}:
		return nil
	default:
		w.queueDepth.Add(-1)
		w.drops.Add(1)
		return nil
	}
}

func (w *AsyncMetadataWriter) Drops() uint64 {
	if w == nil {
		return 0
	}
	return w.drops.Load()
}

// Failures returns bounded sink persistence failures. A failed batch is retried
// once, non-blockingly; a saturated retry queue increments Drops instead.
func (w *AsyncMetadataWriter) Failures() uint64 {
	if w == nil {
		return 0
	}
	return w.failures.Load()
}
func (w *AsyncMetadataWriter) run() {
	defer w.wg.Done()
	defer close(w.done)
	defer w.cancel()
	defer w.queueDepth.Store(0)
	ticker := time.NewTicker(w.config.FlushInterval)
	defer ticker.Stop()
	pending := make([]metadataWork, 0, w.config.FlushSize)
	for {
		select {
		case <-w.ctx.Done():
			return
		case closeCtx := <-w.closeCh:
			w.draining.Store(true)
			w.drain(closeCtx, pending)
			return
		case work := <-w.queue:
			pending = append(pending, work)
			if len(pending) >= w.config.FlushSize {
				pending = w.flush(w.ctx, pending)
			}
		case <-ticker.C:
			if len(pending) > 0 {
				pending = w.flush(w.ctx, pending)
			}
		}
	}
}

func (w *AsyncMetadataWriter) flush(ctx context.Context, pending []metadataWork) []metadataWork {
	if len(pending) == 0 {
		return pending
	}
	if w.batchSink == nil {
		w.queueDepth.Add(-int64(len(pending)))
		return nil
	}
	batch := make([]Metadata, len(pending))
	for i, work := range pending {
		batch[i] = work.metadata
	}
	started := time.Now()
	if err := w.batchSink.WriteMetadataBatch(ctx, batch); err == nil {
		w.queueDepth.Add(-int64(len(pending)))
		w.flushes.Add(1)
		w.flushNanos.Store(time.Since(started).Nanoseconds())
		return nil
	}
	w.flushes.Add(1)
	w.flushNanos.Store(time.Since(started).Nanoseconds())
	w.failures.Add(1)
	for _, work := range pending {
		if work.retried {
			w.queueDepth.Add(-1)
			continue
		}
		work.retried = true
		select {
		case w.queue <- work:
		default:
			w.queueDepth.Add(-1)
			w.drops.Add(1)
		}
	}
	return nil
}

func (w *AsyncMetadataWriter) drain(ctx context.Context, pending []metadataWork) {
	if ctx == nil {
		ctx = context.Background()
	}
	if w.config.DrainTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, w.config.DrainTimeout)
		defer cancel()
	}
	for {
	collect:
		for len(pending) < w.config.FlushSize {
			select {
			case work := <-w.queue:
				pending = append(pending, work)
			default:
				break collect
			}
		}
		if len(pending) == 0 {
			return
		}
		pending = w.flush(ctx, pending)
		if ctx.Err() != nil {
			return
		}
	}
}

// QueueDepth reports the current number of queued metadata items.
func (w *AsyncMetadataWriter) QueueDepth() int {
	if w == nil {
		return 0
	}
	depth := w.queueDepth.Load()
	if depth <= 0 {
		return 0
	}
	return int(depth)
}

// QueueSize reports the bounded queue capacity.
func (w *AsyncMetadataWriter) QueueSize() int {
	if w == nil || w.queue == nil {
		return 0
	}
	return cap(w.queue)
}

// FlushSize reports the configured count threshold.
func (w *AsyncMetadataWriter) FlushSize() int {
	if w == nil {
		return 0
	}
	return w.config.FlushSize
}

// FlushInterval reports the configured time threshold.
func (w *AsyncMetadataWriter) FlushInterval() time.Duration {
	if w == nil {
		return 0
	}
	return w.config.FlushInterval
}

// Flushes reports completed sink delivery attempts.
func (w *AsyncMetadataWriter) Flushes() uint64 {
	if w == nil {
		return 0
	}
	return w.flushes.Load()
}

// FlushLatency reports the most recent sink delivery duration.
func (w *AsyncMetadataWriter) FlushLatency() time.Duration {
	if w == nil {
		return 0
	}
	return time.Duration(w.flushNanos.Load())
}

// Draining reports whether Close has initiated a queue drain.
func (w *AsyncMetadataWriter) Draining() bool {
	if w == nil {
		return false
	}
	return w.draining.Load()
}

// Drained reports whether the worker has exited after Close or cancellation.
func (w *AsyncMetadataWriter) Drained() bool {
	if w == nil {
		return true
	}
	select {
	case <-w.done:
		return true
	default:
		return false
	}
}

func (w *AsyncMetadataWriter) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	w.closeOnce.Do(func() {
		w.closed.Store(true)
		w.closeCh <- ctx
	})
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type metadataSinkBatchAdapter struct {
	sink MetadataSink
}

func (s metadataSinkBatchAdapter) WriteMetadataBatch(ctx context.Context, batch []Metadata) error {
	if s.sink == nil {
		return nil
	}
	for _, metadata := range batch {
		if err := s.sink.WriteMetadata(ctx, metadata); err != nil {
			return err
		}
	}
	return nil
}
