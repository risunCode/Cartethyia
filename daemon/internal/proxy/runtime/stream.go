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

	"github.com/cartethyia/daemon/internal/observability"
	"github.com/cartethyia/daemon/internal/observability/usage"
	"github.com/cartethyia/daemon/internal/proxy/control/admission"
	"github.com/cartethyia/daemon/internal/proxy/control/tokenbudget"
)

// StreamEventKind identifies one canonical stream event.
type StreamEventKind string

const (
	EventMessageStart     StreamEventKind = "message_start"
	EventThinkingDelta    StreamEventKind = "thinking_delta"
	EventTextDelta        StreamEventKind = "text_delta"
	EventToolCallStart    StreamEventKind = "tool_call_start"
	EventToolCallDelta    StreamEventKind = "tool_call_delta"
	EventToolCallEnd      StreamEventKind = "tool_call_end"
	EventServerToolResult StreamEventKind = "server_tool_result"
	EventCompactionItem   StreamEventKind = "compaction_item"
	EventUsage            StreamEventKind = "usage"
	EventMessageStop      StreamEventKind = "message_stop"
)

// StreamEvent is a single canonical event from a provider transport.
type StreamEvent struct {
	Kind     StreamEventKind
	Text     string
	CallID   string
	CallName string
	Reason   string
	// Index identifies a provider-native content block when one exists.
	Index int
	// Payload is canonical server-tool result content. Provider wire payloads
	// are mapped before a StreamEvent enters the queue.
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
// producer. Terminal events finalize automatically; Close and Abort provide
// the same exactly-once cleanup for early consumer exits.
type Stream struct {
	ch               chan StreamEvent
	mu               sync.Mutex
	pending          []StreamEvent
	closed           atomic.Bool
	committed        atomic.Bool
	finishOnce       sync.Once
	doneCh           chan struct{}
	err              error
	cancel           context.CancelFunc
	accountLease     *AccountLease
	admissionLease   *admission.Lease
	reservation      tokenbudget.TokenReservation
	preparedClose    func() error
	reconcileCtx     context.Context
	finalize         func(error, error)
	evidenceObserver observability.AttemptObserver
	evidence         observability.StreamFinalizationEvidence
	usage            StreamUsage
	usageSeen        bool
	responseID       string
	deferTerminal    bool
	idle             time.Duration
	timerMu          sync.Mutex
	idleTimer        streamTimer
	totalTimer       streamTimer
}

type streamTimer interface {
	channel() <-chan time.Time
	Stop() bool
	Reset(time.Duration) bool
}

type realStreamTimer struct{ timer *time.Timer }

func (t *realStreamTimer) channel() <-chan time.Time  { return t.timer.C }
func (t *realStreamTimer) Stop() bool                 { return t.timer.Stop() }
func (t *realStreamTimer) Reset(d time.Duration) bool { return t.timer.Reset(d) }

const (
	maxStreamPreludeEvents   = 64
	maxStreamPreludeBytes    = 64 << 10
	maxStreamResponseIDBytes = 256
	streamReconcileTimeout   = 5 * time.Second
)

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
	StreamCodeReadFailure       = "proxy/stream.read_failure"
	StreamCodeEventTooLarge     = "proxy/stream.event_too_large"
	StreamCodePreludeTooLarge   = "proxy/stream.prelude_too_large"
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
	return newStreamWithTimerFactory(ch, cancel, idle, total, func(duration time.Duration) streamTimer {
		return &realStreamTimer{timer: time.NewTimer(duration)}
	})
}

func newStreamWithTimerFactory(ch chan StreamEvent, cancel context.CancelFunc, idle, total time.Duration, newTimer func(time.Duration) streamTimer) *Stream {
	if ch == nil {
		ch = make(chan StreamEvent)
		close(ch)
	}
	s := &Stream{
		ch:     ch,
		doneCh: make(chan struct{}),
		cancel: cancel,
		idle:   idle,
	}
	if idle > 0 {
		s.idleTimer = newTimer(idle)
	}
	if total > 0 {
		s.totalTimer = newTimer(total)
	}
	return s
}

// AttachAccountLease transfers ownership of the attempt lease to the stream.
// The stream's single finalizer releases it on every terminal path.
func (s *Stream) AttachAccountLease(lease *AccountLease) {
	s.mu.Lock()
	s.accountLease = lease
	s.mu.Unlock()
}

// AttachAdmissionLease transfers global and stream admission ownership to the
// stream's exactly-once finalizer.
func (s *Stream) AttachAdmissionLease(lease *admission.Lease) {
	s.mu.Lock()
	s.admissionLease = lease
	s.mu.Unlock()
}

// AttachTokenReservation transfers the accepted attempt's durable reservation
// to the stream lifecycle. The reservation is reconciled by finishOnce for all
// terminal, cancellation, truncation, and downstream failure outcomes.
func (s *Stream) AttachTokenReservation(ctx context.Context, reservation tokenbudget.TokenReservation) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	s.reservation = reservation
	s.reconcileCtx = context.WithoutCancel(ctx)
	s.mu.Unlock()
}

// AttachFinalizer adds request-level cleanup to the stream's single lifecycle
// finalizer. It must be attached before the stream is returned to a consumer.
// The second error reports a post-outcome side-effect failure without changing
// the stream's client-visible outcome.
func (s *Stream) AttachFinalizer(finalize func(error, error)) {
	s.mu.Lock()
	s.finalize = finalize
	s.mu.Unlock()
}

// AttachFinalizationEvidence transfers one bounded, payload-free evidence
// record into the canonical sync.Once finalizer. It must be attached before
// the stream is returned to a downstream consumer.
func (s *Stream) AttachFinalizationEvidence(observer observability.AttemptObserver, evidence observability.StreamFinalizationEvidence) {
	if observer == nil {
		return
	}
	if evidence.StartedAt.IsZero() {
		evidence.StartedAt = time.Now().UTC()
	}
	s.mu.Lock()
	s.evidenceObserver = observer
	s.evidence = evidence
	s.mu.Unlock()
}

// deferTerminalFinish keeps a successfully preflighted terminal event pending
// until its downstream framing has been written and flushed. Preflight errors
// still finalize when the router closes the rejected attempt.
func (s *Stream) deferTerminalFinish() {
	s.mu.Lock()
	s.deferTerminal = true
	s.mu.Unlock()
}

// Preflight buffers bounded non-semantic prelude until the first semantic
// event, an explicit successful terminal, or a failure. A nil result is the
// router commit decision; every consumed event remains queued for downstream
// replay in its original order.
func (s *Stream) Preflight(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	buffered := make([]StreamEvent, 0, 4)
	bufferedBytes := 0
	compactionItems := 0
	for {
		ev, err := s.nextCanonical(ctx)
		if err != nil {
			return err
		}
		if ev.IsTerminal() && (ev.Err != nil || ev.Reason == "error") {
			if terminalErr := s.Err(); terminalErr != nil {
				return terminalErr
			}
			return streamError(StreamCodeUpstreamFailure, "upstream stream failure", ErrStreamUpstream)
		}
		if ev.Kind == EventCompactionItem {
			compactionItems++
			if compactionItems > 1 {
				err := streamError(StreamCodeMalformedEvent, "compaction stream returned multiple compaction items", ErrStreamMalformed)
				s.markAborted(err)
				return err
			}
		}

		semantic := isSemanticStreamEvent(ev)
		terminal := ev.IsTerminal()
		buffered = append(buffered, ev)
		if ev.Kind == EventCompactionItem {
			semantic = false
		}
		if terminal {
			if compactionItems > 0 && compactionItems != 1 {
				err := streamError(StreamCodeMalformedEvent, "compaction stream returned no compaction item", ErrStreamMalformed)
				s.markAborted(err)
				return err
			}
			s.mu.Lock()
			s.pending = append(s.pending, buffered...)
			s.mu.Unlock()
			return nil
		}
		if semantic {
			s.mu.Lock()
			s.pending = append(s.pending, buffered...)
			s.mu.Unlock()
			return nil
		}

		bufferedBytes += streamEventSize(ev)
		if len(buffered) > maxStreamPreludeEvents || bufferedBytes > maxStreamPreludeBytes {
			err := streamError(StreamCodePreludeTooLarge, "stream prelude exceeds limit", ErrStreamMalformed)
			s.markAborted(err)
			return err
		}
	}
}

// Next returns the next event or io.EOF when the stream completes.
func (s *Stream) Next(ctx context.Context) (StreamEvent, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if len(s.pending) > 0 {
		ev := s.pending[0]
		s.pending = s.pending[1:]
		s.mu.Unlock()
		return ev, nil
	}
	s.mu.Unlock()
	if s.closed.Load() {
		if err := s.Err(); err != nil {
			return StreamEvent{}, err
		}
		return StreamEvent{}, io.EOF
	}
	return s.nextCanonical(ctx)
}

func (s *Stream) nextCanonical(ctx context.Context) (StreamEvent, error) {
	for {
		idleC, totalC := s.timerChannels()
		select {
		case ev, ok := <-s.ch:
			if !ok {
				err := streamError(StreamCodeUpstreamTruncated, "upstream closed before message_stop", ErrStreamTruncated)
				s.markAborted(err)
				return StreamEvent{}, err
			}
			s.resetIdleTimer()
			return s.processEvent(ev)
		case <-ctx.Done():
			err := streamError(StreamCodeClientDisconnect, "client disconnected", errors.Join(ErrClientDisconnect, ctx.Err()))
			s.markAborted(err)
			return StreamEvent{}, err
		case <-idleC:
			err := streamError(StreamCodeIdleTimeout, "stream idle timeout", errors.Join(ErrStreamStall, context.DeadlineExceeded))
			s.markAborted(err)
			return StreamEvent{}, err
		case <-totalC:
			err := streamError(StreamCodeTotalTimeout, "stream total timeout", errors.Join(ErrStreamTotal, context.DeadlineExceeded))
			s.markAborted(err)
			return StreamEvent{}, err
		case <-s.doneCh:
			if err := s.Err(); err != nil {
				return StreamEvent{}, err
			}
			return StreamEvent{}, io.EOF
		}
	}
}

func (s *Stream) processEvent(ev StreamEvent) (StreamEvent, error) {
	if !knownStreamEventKind(ev.Kind) {
		err := streamError(StreamCodeMalformedEvent, "unknown stream event kind", ErrStreamMalformed)
		s.markAborted(err)
		return StreamEvent{}, err
	}
	if isSemanticStreamEvent(ev) {
		s.committed.Store(true)
	}
	s.observeCanonical(ev)
	if ev.IsTerminal() {
		var terminalErr error
		if ev.Err != nil || ev.Reason == "error" {
			cause := ev.Err
			if cause == nil {
				cause = ErrStreamUpstream
			}
			terminalErr = cause
			if StreamCodeOf(terminalErr) == "" {
				terminalErr = streamError(StreamCodeUpstreamFailure, "upstream stream failure", errors.Join(ErrStreamUpstream, cause))
			}
		}
		s.mu.Lock()
		if terminalErr != nil && s.err == nil {
			s.err = terminalErr
		}
		deferred := s.deferTerminal
		s.mu.Unlock()
		if !deferred {
			s.finish(terminalErr)
		}
	}
	return ev, nil
}

func isSemanticStreamEvent(ev StreamEvent) bool {
	switch ev.Kind {
	case EventThinkingDelta, EventTextDelta, EventToolCallStart,
		EventToolCallDelta, EventToolCallEnd, EventServerToolResult:
		return true
	default:
		return false
	}
}

func streamEventSize(ev StreamEvent) int {
	return 32 + len(ev.Text) + len(ev.CallID) + len(ev.CallName) + len(ev.Reason) + len(ev.Payload)
}

// Committed reports whether preflight observed semantic output. Once true,
// router retry is forbidden and downstream failures are terminally encoded.
func (s *Stream) Committed() bool { return s.committed.Load() }

func (s *Stream) observeCanonical(ev StreamEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if boundedStreamResponseID(ev.CallID) && (ev.Kind == EventMessageStart || ev.Kind == EventMessageStop) {
		s.responseID = ev.CallID
	}
	if ev.Kind == EventUsage && ev.Usage != nil {
		s.usageSeen = true
		s.usage.InputTokens += ev.Usage.InputTokens
		s.usage.OutputTokens += ev.Usage.OutputTokens
		s.usage.TotalTokens += ev.Usage.TotalTokens
		s.usage.CacheReadTokens += ev.Usage.CacheReadTokens
		s.usage.CacheWriteTokens += ev.Usage.CacheWriteTokens
		s.usage.ReasoningTokens += ev.Usage.ReasoningTokens
	}
}

func boundedStreamResponseID(value string) bool {
	if value == "" || len(value) > maxStreamResponseIDBytes {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] > 0x7e {
			return false
		}
	}
	return true
}

// Usage returns the accumulated canonical provider usage observed before
// finalization. The value contains no payload or credential data.
func (s *Stream) Usage() StreamUsage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usage
}

// UsageTokens returns canonical accumulated provider usage. Every dimension is
// unknown until at least one canonical usage event has been observed.
func (s *Stream) UsageTokens() usage.Tokens {
	s.mu.Lock()
	defer s.mu.Unlock()
	return usageTokens(s.usage, s.usageSeen)
}

func usageTokens(streamUsage StreamUsage, observed bool) usage.Tokens {
	if !observed {
		return usage.Tokens{}
	}
	input := int64(streamUsage.InputTokens)
	output := int64(streamUsage.OutputTokens)
	total := int64(streamUsage.TotalTokens)
	cacheRead := int64(streamUsage.CacheReadTokens)
	cacheWrite := int64(streamUsage.CacheWriteTokens)
	reasoning := int64(streamUsage.ReasoningTokens)
	if total == 0 {
		total = input + output
	}
	return usage.Tokens{
		Input: &input, Output: &output, Total: &total,
		CachedRead: &cacheRead, CachedWrite: &cacheWrite, Reasoning: &reasoning,
	}
}

// ResponseID returns the bounded provider response identity observed in the
// canonical stream, when one was supplied.
func (s *Stream) ResponseID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.responseID
}

func knownStreamEventKind(kind StreamEventKind) bool {
	switch kind {
	case EventMessageStart, EventThinkingDelta, EventTextDelta,
		EventToolCallStart, EventToolCallDelta, EventToolCallEnd,
		EventServerToolResult, EventCompactionItem, EventUsage, EventMessageStop:
		return true
	default:
		return false
	}
}

func (s *Stream) finish(err error) {
	s.finishOnce.Do(func() {
		s.closed.Store(true)
		s.stopTimers()
		s.mu.Lock()
		if err != nil {
			s.err = err
		} else {
			err = s.err
		}
		cancel := s.cancel
		lease := s.accountLease
		admissionLease := s.admissionLease
		reservation := s.reservation
		preparedClose := s.preparedClose
		reconcileCtx := s.reconcileCtx
		tokens := usageTokens(s.usage, s.usageSeen)
		finalize := s.finalize
		evidenceObserver := s.evidenceObserver
		evidence := s.evidence
		committed := s.committed.Load()
		s.mu.Unlock()
		defer close(s.doneCh)
		if cancel != nil {
			cancel()
		}
		if lease != nil {
			lease.Release()
		}
		if admissionLease != nil {
			admissionLease.Release()
		}
		if preparedClose != nil {
			if closeErr := preparedClose(); err == nil && closeErr != nil {
				err = closeErr
			}
		}
		var reconcileErr error
		if reservation != nil {
			if reconcileCtx == nil {
				reconcileCtx = context.Background()
			}
			boundedCtx, stop := context.WithTimeout(reconcileCtx, streamReconcileTimeout)
			reconcileErr = reservation.Reconcile(boundedCtx, tokens)
			stop()
		}
		if finalize != nil {
			finalize(err, reconcileErr)
		}
		if evidenceObserver != nil {
			evidence.EndedAt = time.Now().UTC()
			evidence.DurationMS = evidence.EndedAt.Sub(evidence.StartedAt).Milliseconds()
			if evidence.DurationMS < 0 {
				evidence.DurationMS = 0
			}
			evidence.Code = StreamCodeOf(err)
			evidence.Outcome = finalizationOutcome(err)
			evidence.Committed = committed
			evidence.Usage = attemptTokenUsage(tokens)
			observeSafely(func() { evidenceObserver.ObserveStreamFinalization(evidence) })
		}
	})
}

func finalizationOutcome(err error) observability.StreamOutcome {
	if err == nil {
		return observability.StreamClean
	}
	switch StreamCodeOf(err) {
	case StreamCodeClientDisconnect:
		return observability.StreamCanceled
	case StreamCodeIdleTimeout:
		return observability.StreamStalled
	case StreamCodeUpstreamTruncated:
		return observability.StreamTruncated
	case StreamCodeWriteFailure:
		return observability.StreamDownstreamWrite
	}
	if errors.Is(err, ErrClientDisconnect) || errors.Is(err, context.Canceled) {
		return observability.StreamCanceled
	}
	if errors.Is(err, ErrStreamStall) {
		return observability.StreamStalled
	}
	if errors.Is(err, ErrStreamTruncated) {
		return observability.StreamTruncated
	}
	return observability.StreamFailed
}

// Close finalizes account, proxy, admission, and attached side effects. It is
// safe to call multiple times.
func (s *Stream) Close() error {
	s.finish(s.Err())
	return nil
}

// AttachPreparedAttempt transfers local preparation ownership to the stream.
// Stream.finish invokes the closer exactly once with the rest of stream
// resources, including early client disconnects.
func (s *Stream) AttachPreparedAttempt(attempt *PreparedAttempt) {
	if s == nil || attempt == nil {
		return
	}
	s.mu.Lock()
	if s.closed.Load() {
		s.mu.Unlock()
		_ = attempt.Close()
		return
	}
	s.preparedClose = attempt.Close
	s.mu.Unlock()
}

// Abort records an external consumer failure and cancels the producer. It is
// idempotent, so the eventual body close cannot overwrite the root cause.
func (s *Stream) Abort(err error) {
	if err == nil {
		err = ErrClientDisconnect
	}
	s.markAborted(err)
}

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

func (s *Stream) timerChannels() (<-chan time.Time, <-chan time.Time) {
	s.timerMu.Lock()
	defer s.timerMu.Unlock()
	var idleC, totalC <-chan time.Time
	if s.idleTimer != nil {
		idleC = s.idleTimer.channel()
	}
	if s.totalTimer != nil {
		totalC = s.totalTimer.channel()
	}
	return idleC, totalC
}

func (s *Stream) resetIdleTimer() {
	if s.idle <= 0 {
		return
	}
	s.timerMu.Lock()
	defer s.timerMu.Unlock()
	if s.idleTimer == nil {
		return
	}
	if !s.idleTimer.Stop() {
		select {
		case <-s.idleTimer.channel():
		default:
		}
	}
	s.idleTimer.Reset(s.idle)
}

func (s *Stream) stopTimers() {
	s.timerMu.Lock()
	defer s.timerMu.Unlock()
	stopAndDrainTimer(s.idleTimer)
	stopAndDrainTimer(s.totalTimer)
}

func stopAndDrainTimer(timer streamTimer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.channel():
		default:
		}
	}
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
