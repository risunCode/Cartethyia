// File: stream.go
// AD-5 disconnect-aware stream helpers. The Stream type wraps a provider
// event channel and propagates client cancellation back to the transport so
// that an aborted caller does not leak a hung upstream connection.
package proxy

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// StreamEventKind mirrors the legacy StreamEvent union. Only the fields
// the orchestrator cares about are populated; the transport is free to
// emit richer events via the opaque Payload field.
type StreamEventKind string

const (
	EventMessageStart     StreamEventKind = "message_start"
	EventThinkingDelta    StreamEventKind = "thinking_delta"
	EventTextDelta        StreamEventKind = "text_delta"
	EventToolCallStart    StreamEventKind = "tool_call_start"
	EventToolCallDelta    StreamEventKind = "tool_call_delta"
	EventToolCallEnd      StreamEventKind = "tool_call_end"
	EventServerToolResult StreamEventKind = "server_tool_result"
	EventUsage            StreamEventKind = "usage"
	EventMessageStop      StreamEventKind = "message_stop"
)

// StreamEvent is a single canonical event from a provider transport.
//
// Providers may attach a wire payload when the transport has not decoded the
// provider event yet. The stream bridge decodes that payload before framing;
// callers must never forward Payload directly without that step.
type StreamEvent struct {
	Kind     StreamEventKind
	Text     string
	CallID   string
	CallName string
	Reason   string
	// Index identifies a provider-native content block when one exists.
	Index int
	// Payload is the opaque, transport-specific payload. Never echo it
	// to clients verbatim; transform via the package codecs.
	Payload []byte
	// Usage is populated for usage events. Nil means usage was not supplied.
	Usage *StreamUsage
	// Err carries a provider-side terminal failure without turning it into a
	// silent channel close.
	Err error
}

// StreamUsage is the provider-neutral usage subset needed by stream surfaces.
type StreamUsage struct {
	InputTokens      int
	OutputTokens     int
	TotalTokens      int
	CacheReadTokens  int
	CacheWriteTokens int
	ReasoningTokens  int
}

// IsTerminal reports whether the event ends the stream.
func (e StreamEvent) IsTerminal() bool { return e.Kind == EventMessageStop }

// Stream is the disconnect-aware iterator returned by the router. It is
// safe for one consumer goroutine to drain concurrently with the upstream
// producer. Once the caller sees an error or terminal event, it MUST call
// Close to release the slot in the account pool.
type Stream struct {
	ch          chan StreamEvent
	mu          sync.Mutex
	pending     []StreamEvent
	closed      atomic.Bool
	doneOnce    sync.Once
	releaseOnce sync.Once
	cancelOnce  sync.Once
	doneCh      chan struct{}
	err         error
	cancel      context.CancelFunc
	accountID   string
	pool        *AccountPool
	idle        time.Duration
	total       time.Duration
	startedAt   int64
	lastEvent   atomic.Int64
}

// StreamError is a stable proxy-owned stream failure. Code is safe to expose
// to clients and remains stable across transport implementations.
type StreamError struct {
	Code    string
	Message string
	Err     error
}

func (e *StreamError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}
func (e *StreamError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

const (
	StreamCodeClientDisconnect  = "proxy/stream.client_disconnect"
	StreamCodeIdleTimeout       = "proxy/stream.idle_timeout"
	StreamCodeTotalTimeout      = "proxy/stream.total_timeout"
	StreamCodeUpstreamTruncated = "proxy/stream.upstream_truncated"
	StreamCodeMalformedEvent    = "proxy/stream.malformed_event"
	StreamCodeUpstreamFailure   = "proxy/stream.upstream_failure"
	StreamCodeWriteFailure      = "proxy/stream.write_failure"
	StreamCodeInvalidEncrypted  = "proxy/stream.invalid_encrypted_content"
)

var ErrInvalidEncryptedContent = errors.New("proxy: invalid encrypted content")

func streamError(code, message string, cause error) *StreamError {
	return &StreamError{Code: code, Message: message, Err: cause}
}

// ErrClientDisconnect signals that the caller hung up before the stream
// completed. Transport layers should treat it as a cancel signal, not an
// error to retry.
var ErrClientDisconnect = errors.New("proxy: client disconnected")

// ErrStreamStall signals the stream produced no event within the idle window.
var ErrStreamStall = errors.New("proxy: stream stalled")

// ErrStreamTotal signals the stream exceeded its total budget.
var ErrStreamTotal = errors.New("proxy: stream exceeded total budget")

// ErrStreamTruncated signals an upstream that closed without a terminal event.
var ErrStreamTruncated = errors.New("proxy: stream truncated")

// ErrStreamMalformed signals an event that cannot be mapped to the canonical
// event contract.
var ErrStreamMalformed = errors.New("proxy: malformed stream event")

// ErrStreamUpstream signals a provider-side stream failure.
var ErrStreamUpstream = errors.New("proxy: upstream stream failure")

// StreamCodeOf returns the stable code on a stream error, or "" otherwise.
func StreamCodeOf(err error) string {
	var coded *StreamError
	if errors.As(err, &coded) && coded != nil {
		return coded.Code
	}
	return ""
}

// CodeOf is the package-level shorthand for StreamCodeOf.
func CodeOf(err error) string { return StreamCodeOf(err) }

// NewStream constructs a Stream. The caller passes the underlying event
// channel plus the context that should be cancelled when the stream ends.
// idle and total bound the stall detection; either may be zero to disable.
func NewStream(ch chan StreamEvent, cancel context.CancelFunc, idle, total time.Duration) *Stream {
	if ch == nil {
		ch = make(chan StreamEvent)
		close(ch)
	}
	now := time.Now().UnixNano()
	s := &Stream{
		ch:        ch,
		doneCh:    make(chan struct{}),
		cancel:    cancel,
		idle:      idle,
		total:     total,
		startedAt: now,
	}
	s.lastEvent.Store(now)
	return s
}

// AttachAccount records the account that produced the stream so Close can
// release its in-flight slot on the pool.
func (s *Stream) AttachAccount(accountID string, pool *AccountPool) {
	s.mu.Lock()
	s.accountID = accountID
	s.pool = pool
	s.mu.Unlock()
}

// Next returns the next event or io.EOF when the stream completes
// successfully. Errors are returned as soon as the underlying producer
// reports them.
// Preflight reads one upstream event before the stream commit point. A
// terminal provider error is returned so the router may perform its single
// pre-content retry; ordinary first events are queued and replayed unchanged.
func (s *Stream) Preflight(ctx context.Context) error {
	ev, err := s.Next(ctx)
	if err != nil {
		return err
	}
	if ev.IsTerminal() {
		return s.Err()
	}
	s.mu.Lock()
	s.pending = append(s.pending, ev)
	s.mu.Unlock()
	return nil
}

// Next returns the next event or io.EOF when the stream completes.
func (s *Stream) Next(ctx context.Context) (StreamEvent, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		if err := s.Err(); err != nil {
			return StreamEvent{}, err
		}
		return StreamEvent{}, io.EOF
	}
	for {
		s.mu.Lock()
		if len(s.pending) > 0 {
			ev := s.pending[0]
			s.pending = s.pending[1:]
			s.mu.Unlock()
			return s.processEvent(ev)
		}
		s.mu.Unlock()
		select {
		case ev, ok := <-s.ch:
			if !ok {
				err := streamError(StreamCodeUpstreamTruncated, "upstream closed before message_stop", ErrStreamTruncated)
				s.markAborted(err)
				return StreamEvent{}, err
			}
			return s.processEvent(ev)
		case <-ctx.Done():
			err := streamError(StreamCodeClientDisconnect, "client disconnected", errors.Join(ErrClientDisconnect, ctx.Err()))
			s.markAborted(err)
			return StreamEvent{}, err
		case <-s.stallTimer():
			err := streamError(StreamCodeIdleTimeout, "stream idle timeout", errors.Join(ErrStreamStall, context.DeadlineExceeded))
			s.markAborted(err)
			return StreamEvent{}, err
		case <-s.totalTimer():
			err := streamError(StreamCodeTotalTimeout, "stream total timeout", errors.Join(ErrStreamTotal, context.DeadlineExceeded))
			s.markAborted(err)
			return StreamEvent{}, err
		}
	}
}

func (s *Stream) processEvent(ev StreamEvent) (StreamEvent, error) {
	s.lastEvent.Store(time.Now().UnixNano())
	if !knownStreamEventKind(ev.Kind) {
		err := streamError(StreamCodeMalformedEvent, "unknown stream event kind", ErrStreamMalformed)
		s.markAborted(err)
		return StreamEvent{}, err
	}
	if ev.IsTerminal() {
		if ev.Err != nil || ev.Reason == "error" {
			cause := ev.Err
			if cause == nil {
				cause = ErrStreamUpstream
			}
			err := streamError(StreamCodeUpstreamFailure, "upstream stream failure", errors.Join(ErrStreamUpstream, cause))
			s.finish(err)
			return ev, nil
		}
		s.finish(nil)
	}
	return ev, nil
}

func knownStreamEventKind(kind StreamEventKind) bool {
	switch kind {
	case EventMessageStart, EventThinkingDelta, EventTextDelta,
		EventToolCallStart, EventToolCallDelta, EventToolCallEnd,
		EventServerToolResult, EventUsage, EventMessageStop:
		return true
	default:
		return false
	}
}

func (s *Stream) finish(err error) {
	s.closed.Store(true)
	if err != nil {
		s.mu.Lock()
		if s.err == nil {
			s.err = err
		}
		s.mu.Unlock()
	}
	s.doneOnce.Do(func() { close(s.doneCh) })
	s.cancelOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
	})
	s.releaseOnce.Do(func() {
		s.mu.Lock()
		accountID, pool := s.accountID, s.pool
		s.mu.Unlock()
		if pool != nil && accountID != "" {
			pool.End(accountID)
		}
	})
}

// Close releases the in-flight slot and cancels the producer context. Safe
// to call multiple times.
func (s *Stream) Close() error {
	s.finish(nil)
	return nil
}

// Abort records an external consumer failure and cancels the producer. It is
// idempotent, so the eventual body close cannot overwrite the root cause.
func (s *Stream) Abort(err error) {
	if err == nil {
		err = ErrClientDisconnect
	}
	s.markAborted(err)
}

// Done returns a channel that closes when the stream terminates for any
// reason (EOF, error, or Close). Used by callers that want to schedule
// cleanup based on completion rather than per-event.
func (s *Stream) Done() <-chan struct{} { return s.doneCh }

// markAborted transitions the stream into the closed state and records
// the error for Err().
func (s *Stream) markAborted(err error) {
	s.finish(err)
}

// Err returns the terminal error, or nil if the stream ended cleanly.
func (s *Stream) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *Stream) stallTimer() <-chan time.Time {
	if s.idle <= 0 {
		return nil
	}
	last := time.Unix(0, s.lastEvent.Load())
	if last.IsZero() {
		return time.After(s.idle)
	}
	deadline := last.Add(s.idle)
	if remaining := time.Until(deadline); remaining > 0 {
		return time.After(remaining)
	}
	// Already past the deadline; produce an immediate tick.
	ch := make(chan time.Time, 1)
	ch <- time.Now()
	return ch
}

func (s *Stream) totalTimer() <-chan time.Time {
	if s.total <= 0 {
		return nil
	}
	deadline := time.Unix(0, s.startedAt).Add(s.total)
	if remaining := time.Until(deadline); remaining > 0 {
		return time.After(remaining)
	}
	ch := make(chan time.Time, 1)
	ch <- time.Now()
	return ch
}

// PipeWithDisconnect drains src and writes each event to dst until src is
// exhausted or ctx is cancelled. dst must implement io.Writer. The function
// returns nil on graceful completion, ErrClientDisconnect when ctx is
// cancelled mid-stream, or any writer/reader error encountered.
//
// It is the small primitive used by the transport package when proxying
// raw SSE bytes from a provider to a downstream client. The orchestrator
// generally operates on Stream instead.
func PipeWithDisconnect(ctx context.Context, src io.Reader, dst io.Writer) error {
	if src == nil {
		return streamError(StreamCodeMalformedEvent, "nil source reader", ErrStreamMalformed)
	}
	if dst == nil {
		return streamError(StreamCodeWriteFailure, "nil destination writer", ErrStreamMalformed)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	buf := make([]byte, 16*1024)
	for {
		select {
		case <-ctx.Done():
			return streamError(StreamCodeClientDisconnect, "client disconnected", errors.Join(ErrClientDisconnect, ctx.Err()))
		default:
		}
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return streamError(StreamCodeWriteFailure, "stream write failed", werr)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return streamError(StreamCodeUpstreamFailure, "stream read failed", errors.Join(ErrStreamUpstream, err))
		}
	}
}
