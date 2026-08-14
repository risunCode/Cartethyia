package observability

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var ErrMetadataClosed = errors.New("observability: metadata writer is closed")

// Metadata is the bounded, payload-free request metadata persisted by a
// MetadataSink. Tool names are bounded and are redacted before enqueue.
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
	ToolNames        []string
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
	if len(m.ToolNames) > 16 {
		m.ToolNames = m.ToolNames[:16]
	}
	tools := make([]string, 0, len(m.ToolNames))
	for _, name := range m.ToolNames {
		name = boundedIdentifier(name, 64)
		if name != "" {
			tools = append(tools, name)
		}
	}
	m.ToolNames = tools
	return m
}

func boundedIdentifier(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		value = value[:max]
	}
	for _, marker := range []string{"authorization", "access_token", "refresh_token", "api_key", "secret", "password", "bearer "} {
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
type AsyncMetadataWriter struct {
	queue     chan Metadata
	sink      MetadataSink
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	closed    atomic.Bool
	drops     atomic.Uint64
	wg        sync.WaitGroup
	done      chan struct{}
}

func NewAsyncMetadataWriter(ctx context.Context, sink MetadataSink, capacity int) *AsyncMetadataWriter {
	if ctx == nil {
		ctx = context.Background()
	}
	if capacity <= 0 {
		capacity = 256
	}
	workerCtx, cancel := context.WithCancel(ctx)
	w := &AsyncMetadataWriter{queue: make(chan Metadata, capacity), sink: sink, ctx: workerCtx, cancel: cancel, done: make(chan struct{})}
	w.wg.Add(1)
	go w.run()
	return w
}

func (w *AsyncMetadataWriter) Enqueue(m Metadata) error {
	if w == nil || w.closed.Load() {
		return ErrMetadataClosed
	}
	m = m.Redacted()
	select {
	case w.queue <- m:
		return nil
	default:
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
func (w *AsyncMetadataWriter) run() {
	defer w.wg.Done()
	defer close(w.done)
	for {
		select {
		case <-w.ctx.Done():
			return
		case m := <-w.queue:
			if w.sink != nil {
				_ = w.sink.WriteMetadata(w.ctx, m)
			}
		}
	}
}
func (w *AsyncMetadataWriter) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	w.closeOnce.Do(func() { w.closed.Store(true); w.cancel() })
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
