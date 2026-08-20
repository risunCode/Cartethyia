package services

import (
	"context"
	"encoding/json"
	"fmt"
	. "github.com/cartethyia/daemon/internal/console/contracts"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	. "github.com/cartethyia/daemon/internal/console/api"
	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/cartethyia/daemon/internal/telemetry"
)

// Bounded live-tail constants for the console evidence pipeline. Persistence
// runs on a dedicated worker so the Recorder drain loop never blocks on SQL.
const (
	consoleRingCapacity  = 256
	consoleQueueCapacity = 256
	maxConsoleMessage    = 512
)

// consoleLogWriter persists operator-safe console evidence rows.
type consoleLogWriter interface {
	InsertConsoleLog(ctx context.Context, log models.ConsoleLog) error
}

// consoleLogStore is the bounded history read seam for the admin service.
type consoleLogStore interface {
	ListConsoleLogsFiltered(ctx context.Context, filter models.ConsoleLogFilter) ([]models.ConsoleLog, error)
}

// consoleLogRecord is one operator-safe lifecycle record. Only bounded,
// classified evidence is representable; prompts, headers, and bodies have no
// field here.
type consoleLogRecord struct {
	seq       uint64
	timestamp time.Time
	level     string
	scope     string
	message   string
	requestID string
	provider  string
	model     string
	status    int
	latencyMS int64
	origin    string
}

// consoleLogRing is a bounded in-memory live tail. Appending beyond capacity
// drops the oldest record; reads always receive a copy.
type consoleLogRing struct {
	mu      sync.Mutex
	records []consoleLogRecord
	next    uint64
}

func (r *consoleLogRing) append(record consoleLogRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record.seq = r.next
	r.next++
	r.records = append(r.records, record)
	if len(r.records) > consoleRingCapacity {
		r.records = r.records[len(r.records)-consoleRingCapacity:]
	}
}

func (r *consoleLogRing) snapshot() []consoleLogRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]consoleLogRecord(nil), r.records...)
}

// ConsoleEventSink is a bounded EventSink target that keeps recent terminal
// proxy lifecycle evidence in a ring and persists it to console_logs through
// a dedicated worker. It never blocks the Recorder: a full queue drops the
// durable copy while the ring keeps the live one.
type ConsoleEventSink struct {
	ring   *consoleLogRing
	writer consoleLogWriter
	queue  chan models.ConsoleLog
	drops  atomic.Uint64
}

// NewConsoleEventSink starts the persistence worker under ctx. The worker
// stops when ctx is cancelled; in-process shutdown terminates it with the
// daemon exactly like the Recorder's own drain loop.
func NewConsoleEventSink(ctx context.Context, writer consoleLogWriter) *ConsoleEventSink {
	if ctx == nil {
		ctx = context.Background()
	}
	sink := &ConsoleEventSink{ring: &consoleLogRing{}, writer: writer, queue: make(chan models.ConsoleLog, consoleQueueCapacity)}
	go sink.run(ctx)
	return sink
}

func (s *ConsoleEventSink) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case row := <-s.queue:
			if s.writer != nil {
				_ = s.writer.InsertConsoleLog(ctx, row)
			}
		}
	}
}

// Emit captures one terminal lifecycle event. Non-terminal stages are ignored
// so the persisted volume stays one row per request; errors are never
// returned because the ring and queue already account for their own drops.
func (s *ConsoleEventSink) Emit(_ context.Context, event telemetry.RequestEvent) error {
	if s == nil || event.Stage != telemetry.StageTerminal {
		return nil
	}
	ts := event.EndedAt
	if ts.IsZero() {
		ts = event.StartedAt
	}
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	record := consoleLogRecord{
		timestamp: ts.UTC(),
		level:     consoleLogLevel(event.Outcome),
		scope:     consoleLogScope(event.Surface),
		message:   consoleLogMessage(event),
		requestID: event.RequestID,
		provider:  event.Provider,
		model:     event.Model,
		status:    consoleLogStatus(event.Outcome),
		latencyMS: event.LatencyMS,
		origin:    event.Origin,
	}
	s.ring.append(record)
	select {
	case s.queue <- models.ConsoleLog{TS: record.timestamp, Level: record.level, Scope: record.scope, Message: record.message}:
	default:
		s.drops.Add(1)
	}
	return nil
}

// fanOutEventSink forwards events to every wrapped sink. The first error wins
// so the Recorder drop counter stays observable; console evidence itself is
// never a hard failure.
type fanOutEventSink struct{ sinks []telemetry.EventSink }

// FanOutEventSink composes telemetry sinks without exposing the implementation
// type to application bootstrap code.
func FanOutEventSink(sinks ...telemetry.EventSink) telemetry.EventSink {
	filtered := make([]telemetry.EventSink, 0, len(sinks))
	for _, sink := range sinks {
		if sink != nil {
			filtered = append(filtered, sink)
		}
	}
	return fanOutEventSink{sinks: filtered}
}

func (f fanOutEventSink) Emit(ctx context.Context, event telemetry.RequestEvent) error {
	var firstErr error
	for _, sink := range f.sinks {
		if err := sink.Emit(ctx, event); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// consoleLogLevel maps the bounded terminal outcome to an operator level.
func consoleLogLevel(outcome telemetry.Outcome) string {
	switch outcome {
	case telemetry.OutcomeSuccess, telemetry.OutcomeCancelled:
		return "info"
	case telemetry.OutcomeQuota, telemetry.OutcomeAuthFailed, telemetry.OutcomeInvalidReq:
		return "warn"
	default:
		return "error"
	}
}

// consoleLogScope keeps the surface as the scope; it is a fixed enum, never
// free-form client input.
func consoleLogScope(surface telemetry.Surface) string {
	if surface == "" {
		return "unknown"
	}
	return string(surface)
}

// consoleLogStatus mirrors the request_history status classification so ring
// and persisted rows stay comparable.
func consoleLogStatus(outcome telemetry.Outcome) int {
	switch outcome {
	case telemetry.OutcomeSuccess:
		return 200
	case telemetry.OutcomeInvalidReq:
		return 400
	case telemetry.OutcomeAuthFailed:
		return 401
	case telemetry.OutcomeQuota:
		return 429
	case telemetry.OutcomeCancelled:
		return 499
	default:
		return 502
	}
}

// consoleLogMessage renders a bounded, secret-free summary. Identifiers come
// from the fixed event fields only.
func consoleLogMessage(event telemetry.RequestEvent) string {
	var b strings.Builder
	b.WriteString("request ")
	b.WriteString(string(event.Outcome))
	if event.Provider != "" {
		b.WriteString(" provider=")
		b.WriteString(event.Provider)
	}
	if event.Model != "" {
		b.WriteString(" model=")
		b.WriteString(event.Model)
	}
	if event.LatencyMS > 0 {
		fmt.Fprintf(&b, " latency_ms=%d", event.LatencyMS)
	}
	message := b.String()
	if len(message) > maxConsoleMessage {
		return message[:maxConsoleMessage]
	}
	return message
}

func clientErrorMessage(input ClientErrorInput) string {
	message := strings.TrimSpace(input.Message)
	if len(input.Context) == 0 {
		if len(message) > maxConsoleMessage {
			return message[:maxConsoleMessage]
		}
		return message
	}
	contextJSON, err := json.Marshal(input.Context)
	if err != nil || len(contextJSON) == 0 {
		if len(message) > maxConsoleMessage {
			return message[:maxConsoleMessage]
		}
		return message
	}
	message += " | context="
	message += string(contextJSON)
	if len(message) > maxConsoleMessage {
		return message[:maxConsoleMessage]
	}
	return message
}

// postgresConsoleLogAdminService implements the admin console log contract by
// merging repo-backed history with the in-memory live tail. Durable rows own
// long-lived evidence; ring records add the rich bounded fields (request,
// provider, model, status, latency) that console_logs intentionally omits.
type postgresConsoleLogAdminService struct {
	store  consoleLogStore
	ring   *consoleLogRing
	writer consoleLogWriter
}

func newPostgresConsoleLogService(store consoleLogStore, sink *ConsoleEventSink) *postgresConsoleLogAdminService {
	service := &postgresConsoleLogAdminService{store: store}
	if sink != nil {
		service.ring = sink.ring
		service.writer = sink.writer
	}
	return service
}

func (s *postgresConsoleLogAdminService) List(ctx context.Context, input ConsoleLogQuery) ([]ConsoleLogEntry, error) {
	from, fromErr := parseAdminTime(input.From)
	to, toErr := parseAdminTime(input.To)
	if fromErr != nil || toErr != nil {
		return nil, NewError(CodeAdminInvalidRequest, "invalid console log window: from/to must be RFC3339 timestamps")
	}
	limit := adminTelemetryLimit(input.Limit)
	rows, err := s.store.ListConsoleLogsFiltered(ctx, models.ConsoleLogFilter{From: from, To: to, Level: input.Level, Scope: input.Scope, Limit: limit})
	if err != nil {
		return nil, wrapAdminReadError("console logs", err)
	}
	seen := make(map[adminConsoleLogKey]struct{}, len(rows))
	merged := make([]ConsoleLogEntry, 0, len(rows))
	for _, row := range rows {
		entry := consoleEntryFromRow(row)
		seen[adminConsoleLogKeyOf(entry)] = struct{}{}
		merged = append(merged, entry)
	}
	if s.ring != nil {
		for _, record := range s.ring.snapshot() {
			if !consoleRecordMatches(record, from, to, input) {
				continue
			}
			entry := consoleEntryFromRecord(record)
			if _, duplicate := seen[adminConsoleLogKeyOf(entry)]; duplicate {
				continue
			}
			seen[adminConsoleLogKeyOf(entry)] = struct{}{}
			merged = append(merged, entry)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].Timestamp > merged[j].Timestamp })
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged, nil
}

func (s *postgresConsoleLogAdminService) Insert(ctx context.Context, input ClientErrorInput) error {
	if s == nil || s.writer == nil {
		return NewError(CodeUnavailable, "console log writer is unavailable")
	}
	message := clientErrorMessage(input)
	if strings.TrimSpace(message) == "" {
		return NewError(CodeAdminInvalidRequest, "client error message is required")
	}
	return s.writer.InsertConsoleLog(ctx, models.ConsoleLog{
		TS:      time.Now().UTC(),
		Level:   strings.ToLower(strings.TrimSpace(input.Level)),
		Scope:   "browser",
		Message: message,
	})
}

// adminConsoleLogKey deduplicates a ring record against its already-persisted
// copy. Both writers derive the key from the same timestamp, level, scope, and
// message; timestamps are compared at the contract's RFC3339 second precision
// because PostgreSQL truncates persisted instants to microseconds.
type adminConsoleLogKey struct {
	timestamp string
	level     string
	scope     string
	message   string
}

func adminConsoleLogKeyOf(entry ConsoleLogEntry) adminConsoleLogKey {
	return adminConsoleLogKey{timestamp: entry.Timestamp, level: entry.Level, scope: entry.Scope, message: entry.Message}
}

func consoleEntryFromRow(row models.ConsoleLog) ConsoleLogEntry {
	return ConsoleLogEntry{
		ID:        strconv.FormatInt(row.ID, 10),
		Timestamp: row.TS.UTC().Format(time.RFC3339),
		Event:     "log",
		Level:     row.Level,
		Scope:     row.Scope,
		Message:   row.Message,
	}
}

func consoleEntryFromRecord(record consoleLogRecord) ConsoleLogEntry {
	entry := ConsoleLogEntry{
		ID:        "live-" + strconv.FormatUint(record.seq, 10),
		Timestamp: record.timestamp.UTC().Format(time.RFC3339),
		Event:     string(telemetry.StageTerminal),
		Level:     record.level,
		Scope:     record.scope,
		Message:   record.message,
		RequestID: record.requestID,
		Provider:  record.provider,
		Model:     record.model,
		Status:    record.status,
		Origin:    record.origin,
	}
	if record.latencyMS > 0 {
		latency := int(record.latencyMS)
		entry.LatencyMS = &latency
	}
	return entry
}

// consoleRecordMatches applies the bounded query filters to a live record.
// Origin filtering applies only to the ring because console_logs has no
// origin column.
func consoleRecordMatches(record consoleLogRecord, from, to time.Time, input ConsoleLogQuery) bool {
	if !from.IsZero() && record.timestamp.Before(from) {
		return false
	}
	if !to.IsZero() && record.timestamp.After(to) {
		return false
	}
	if input.Level != "" && record.level != input.Level {
		return false
	}
	if input.Scope != "" && record.scope != input.Scope {
		return false
	}
	if input.Origin != "" && record.origin != input.Origin {
		return false
	}
	return true
}

var _ ConsoleLogService = (*postgresConsoleLogAdminService)(nil)
var _ telemetry.EventSink = (*ConsoleEventSink)(nil)
