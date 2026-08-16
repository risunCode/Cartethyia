package runtime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/cartethyia/daemon/internal/observability"
	admin "github.com/cartethyia/daemon/internal/server/admin"
)

type fakeConsoleStore struct {
	mu     sync.Mutex
	filter models.ConsoleLogFilter
	rows   []models.ConsoleLog
	err    error
}

func (s *fakeConsoleStore) ListConsoleLogsFiltered(_ context.Context, filter models.ConsoleLogFilter) ([]models.ConsoleLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.filter = filter
	return append([]models.ConsoleLog(nil), s.rows...), s.err
}

type fakeConsoleWriter struct {
	mu      sync.Mutex
	rows    []models.ConsoleLog
	signals chan models.ConsoleLog
}

func newFakeConsoleWriter() *fakeConsoleWriter {
	return &fakeConsoleWriter{signals: make(chan models.ConsoleLog, consoleQueueCapacity)}
}

func (w *fakeConsoleWriter) InsertConsoleLog(_ context.Context, row models.ConsoleLog) error {
	w.mu.Lock()
	w.rows = append(w.rows, row)
	w.mu.Unlock()
	select {
	case w.signals <- row:
	default:
	}
	return nil
}

func terminalEvent(requestID string, outcome observability.Outcome, ts time.Time) observability.RequestEvent {
	return observability.RequestEvent{
		RequestID: requestID,
		Stage:     observability.StageTerminal,
		Outcome:   outcome,
		Surface:   observability.SurfaceHTTP,
		Provider:  "openai",
		Model:     "gpt-test",
		LatencyMS: 321,
		EndedAt:   ts,
	}
}

func TestConsoleEventSinkPersistsTerminalEvents(t *testing.T) {
	writer := newFakeConsoleWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := newConsoleEventSink(ctx, writer)
	ts := time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC)
	if err := sink.Emit(context.Background(), terminalEvent("req-1", observability.OutcomeSuccess, ts)); err != nil {
		t.Fatal(err)
	}
	select {
	case row := <-writer.signals:
		if row.TS.UTC() != ts || row.Level != "info" || row.Scope != "http" {
			t.Fatalf("persisted row = %#v", row)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("terminal event was not persisted")
	}
	records := sink.ring.snapshot()
	if len(records) != 1 {
		t.Fatalf("ring records = %d want 1", len(records))
	}
	if records[0].requestID != "req-1" || records[0].status != 200 || records[0].latencyMS != 321 {
		t.Fatalf("ring record = %#v", records[0])
	}
	if got := records[0].message; got != "request success provider=openai model=gpt-test latency_ms=321" {
		t.Fatalf("message = %q", got)
	}
}

func TestConsoleEventSinkIgnoresNonTerminalStages(t *testing.T) {
	writer := newFakeConsoleWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := newConsoleEventSink(ctx, writer)
	event := terminalEvent("req-2", observability.OutcomeSuccess, time.Now().UTC())
	event.Stage = observability.StageRequestStart
	if err := sink.Emit(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if len(sink.ring.snapshot()) != 0 {
		t.Fatal("non-terminal stage entered the ring")
	}
	select {
	case row := <-writer.signals:
		t.Fatalf("non-terminal stage persisted: %#v", row)
	default:
	}
}

func TestConsoleEventSinkLevelMapping(t *testing.T) {
	tests := []struct {
		outcome observability.Outcome
		level   string
		status  int
	}{
		{observability.OutcomeSuccess, "info", 200},
		{observability.OutcomeCancelled, "info", 499},
		{observability.OutcomeQuota, "warn", 429},
		{observability.OutcomeAuthFailed, "warn", 401},
		{observability.OutcomeInvalidReq, "warn", 400},
		{observability.OutcomeError, "error", 502},
		{observability.OutcomeUpstreamFail, "error", 502},
		{observability.OutcomeUnavailable, "error", 502},
	}
	for _, tc := range tests {
		if got := consoleLogLevel(tc.outcome); got != tc.level {
			t.Fatalf("level(%v) = %q want %q", tc.outcome, got, tc.level)
		}
		if got := consoleLogStatus(tc.outcome); got != tc.status {
			t.Fatalf("status(%v) = %d want %d", tc.outcome, got, tc.status)
		}
	}
}

func TestConsoleLogRingIsBounded(t *testing.T) {
	ring := &consoleLogRing{}
	total := consoleRingCapacity + 10
	for i := 0; i < total; i++ {
		ring.append(consoleLogRecord{message: "bounded"})
	}
	if got := len(ring.snapshot()); got != consoleRingCapacity {
		t.Fatalf("ring size = %d want %d", got, consoleRingCapacity)
	}
}

func TestPostgresConsoleLogServiceMergesHistoryAndLiveTail(t *testing.T) {
	writer := newFakeConsoleWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := newConsoleEventSink(ctx, writer)
	recent := time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC)
	older := time.Date(2026, 8, 15, 9, 0, 0, 0, time.UTC)
	if err := sink.Emit(context.Background(), terminalEvent("req-live", observability.OutcomeUpstreamFail, recent)); err != nil {
		t.Fatal(err)
	}
	var persisted models.ConsoleLog
	select {
	case persisted = <-writer.signals:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal event was not persisted")
	}
	// The durable row for the live event plus one older history row.
	store := &fakeConsoleStore{rows: []models.ConsoleLog{
		{ID: 41, TS: persisted.TS, Level: persisted.Level, Scope: persisted.Scope, Message: persisted.Message},
		{ID: 7, TS: older, Level: "info", Scope: "worker", Message: "request success"},
	}}
	service := newPostgresConsoleLogService(store, sink)
	entries, err := service.List(context.Background(), admin.ConsoleLogQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %#v", entries)
	}
	if entries[0].Timestamp != recent.Format(time.RFC3339) || entries[1].Timestamp != older.Format(time.RFC3339) {
		t.Fatalf("entries not newest-first: %#v", entries)
	}
	for _, entry := range entries {
		if entry.ID == "" || entry.Event == "" || entry.Level == "" {
			t.Fatalf("incomplete entry: %#v", entry)
		}
	}
}

func TestPostgresConsoleLogServiceLiveTailCarriesRichFields(t *testing.T) {
	writer := newFakeConsoleWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := newConsoleEventSink(ctx, writer)
	ts := time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC)
	if err := sink.Emit(context.Background(), terminalEvent("req-rich", observability.OutcomeSuccess, ts)); err != nil {
		t.Fatal(err)
	}
	service := newPostgresConsoleLogService(&fakeConsoleStore{}, sink)
	entries, err := service.List(context.Background(), admin.ConsoleLogQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	entry := entries[0]
	if entry.RequestID != "req-rich" || entry.Provider != "openai" || entry.Model != "gpt-test" || entry.Status != 200 {
		t.Fatalf("entry = %#v", entry)
	}
	if entry.LatencyMS == nil || *entry.LatencyMS != 321 {
		t.Fatalf("latency = %#v", entry.LatencyMS)
	}
}

func TestPostgresConsoleLogServiceFiltersAndClamps(t *testing.T) {
	writer := newFakeConsoleWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := newConsoleEventSink(ctx, writer)
	if err := sink.Emit(context.Background(), terminalEvent("req-a", observability.OutcomeError, time.Date(2026, 8, 16, 10, 0, 0, 0, time.UTC))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writer.signals:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal event was not persisted")
	}
	store := &fakeConsoleStore{rows: []models.ConsoleLog{
		{ID: 1, TS: time.Date(2026, 8, 16, 9, 0, 0, 0, time.UTC), Level: "error", Scope: "http", Message: "request error"},
		{ID: 2, TS: time.Date(2026, 8, 16, 8, 0, 0, 0, time.UTC), Level: "info", Scope: "worker", Message: "request success"},
	}}
	service := newPostgresConsoleLogService(store, sink)
	entries, err := service.List(context.Background(), admin.ConsoleLogQuery{Level: "error", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if store.filter.Level != "error" || store.filter.Limit != 1 {
		t.Fatalf("filter = %#v", store.filter)
	}
	if len(entries) != 1 || entries[0].Level != "error" {
		t.Fatalf("entries = %#v", entries)
	}
	if _, err := service.List(context.Background(), admin.ConsoleLogQuery{From: "oops"}); err == nil {
		t.Fatal("invalid window accepted")
	}
}

func TestPostgresConsoleLogServiceWrapsStoreErrors(t *testing.T) {
	service := newPostgresConsoleLogService(&fakeConsoleStore{err: errors.New("boom")}, nil)
	if _, err := service.List(context.Background(), admin.ConsoleLogQuery{}); err == nil {
		t.Fatal("store error swallowed")
	}
}
