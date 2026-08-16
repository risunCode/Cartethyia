package admin

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type streamInFlightStats struct {
	mu       sync.Mutex
	inFlight int
	waiters  int
	grants   uint64
}

func (s *streamInFlightStats) InFlight() int { s.mu.Lock(); defer s.mu.Unlock(); return s.inFlight }
func (s *streamInFlightStats) Waiters() int  { s.mu.Lock(); defer s.mu.Unlock(); return s.waiters }
func (s *streamInFlightStats) Grants() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.grants
}

type streamConsoleLogs struct {
	mu      sync.Mutex
	entries []ConsoleLogEntry
}

func (l *streamConsoleLogs) List(context.Context, ConsoleLogQuery) ([]ConsoleLogEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ConsoleLogEntry(nil), l.entries...), nil
}

func (l *streamConsoleLogs) append(entries ...ConsoleLogEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entries...)
}

// streamTestServices composes the minimal authenticated admin surface the
// stream routes need.
func streamTestServices(stats InFlightStatsSource, logs ConsoleLogService) Services {
	return Services{
		Dashboard:     testDashboard{},
		Authorizer:    matrixAuthorizer{},
		InFlightStats: stats,
		ConsoleLogs:   logs,
	}
}

func startAdminStreamServer(t *testing.T, services Services) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	Register(mux, services)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func readStreamEvents(t *testing.T, body *bufio.Reader, count int) []string {
	t.Helper()
	var events []string
	deadline := time.Now().Add(5 * time.Second)
	for len(events) < count {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d stream events, got %d", count, len(events))
		}
		line, err := body.ReadString('\n')
		if err != nil {
			t.Fatalf("read stream line: %v (events so far: %d)", err, len(events))
		}
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "data: ") {
			events = append(events, strings.TrimPrefix(trimmed, "data: "))
		}
	}
	return events
}

func TestAdminInFlightStream(t *testing.T) {
	originalTick := adminStreamTick
	adminStreamTick = 50 * time.Millisecond
	t.Cleanup(func() { adminStreamTick = originalTick })

	stats := &streamInFlightStats{inFlight: 3, waiters: 1, grants: 42}
	server := startAdminStreamServer(t, streamTestServices(stats, nil))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/console/telemetry/in-flight/stream", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session-1"})
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type: %q", got)
	}

	reader := bufio.NewReader(resp.Body)
	var snapshot inFlightSnapshot
	events := readStreamEvents(t, reader, 1)
	if err := json.Unmarshal([]byte(events[0]), &snapshot); err != nil {
		t.Fatalf("event json: %v", err)
	}
	if snapshot.InFlight != 3 || snapshot.Waiters != 1 || snapshot.Grants != 42 {
		t.Fatalf("snapshot: %+v", snapshot)
	}
	stats.mu.Lock()
	stats.inFlight = 7
	stats.mu.Unlock()
	events = readStreamEvents(t, reader, 1)
	if err := json.Unmarshal([]byte(events[0]), &snapshot); err != nil {
		t.Fatalf("second event json: %v", err)
	}
	if snapshot.InFlight != 7 {
		t.Fatalf("second snapshot should track live counters: %+v", snapshot)
	}
	cancel()
	_ = resp.Body.Close()
}

func TestAdminConsoleLogStreamInitialAndTail(t *testing.T) {
	originalTick := adminStreamTick
	adminStreamTick = 50 * time.Millisecond
	t.Cleanup(func() { adminStreamTick = originalTick })

	logs := &streamConsoleLogs{entries: []ConsoleLogEntry{
		{ID: "a", Timestamp: "2026-08-16T10:00:00Z", Level: "info", Scope: "router", Message: "first"},
		{ID: "b", Timestamp: "2026-08-16T10:00:01Z", Level: "warn", Scope: "router", Message: "second"},
	}}
	server := startAdminStreamServer(t, streamTestServices(nil, logs))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/console/logs/stream", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session-1"})
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}

	reader := bufio.NewReader(resp.Body)
	events := readStreamEvents(t, reader, 2)
	if !strings.Contains(events[0], `"message":"first"`) || !strings.Contains(events[1], `"message":"second"`) {
		t.Fatalf("initial events out of order: %v", events)
	}

	logs.append(ConsoleLogEntry{ID: "c", Timestamp: "2026-08-16T10:00:02Z", Level: "error", Scope: "upstream", Message: "third"})
	events = readStreamEvents(t, reader, 1)
	if !strings.Contains(events[0], `"message":"third"`) {
		t.Fatalf("tail event missing: %v", events)
	}
	if strings.Contains(events[0], `"message":"first"`) {
		t.Fatalf("tail replayed old entries: %v", events)
	}
	cancel()
	_ = resp.Body.Close()
}

func TestAdminStreamsRequireSession(t *testing.T) {
	services := streamTestServices(&streamInFlightStats{}, &streamConsoleLogs{})
	services.Authorizer = nil
	services.Auth = nil
	server := startAdminStreamServer(t, services)

	for _, path := range []string{
		"/console/telemetry/in-flight/stream",
		"/console/logs/stream",
	} {
		resp, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d", path, resp.StatusCode)
		}
	}
}

func TestAdminStreamSkipsBufferedAuditPath(t *testing.T) {
	// A streaming handler that flushes must deliver bytes immediately and
	// bypass the buffered body capture; a mutation audit never sees payloads.
	originalTick := adminStreamTick
	adminStreamTick = 50 * time.Millisecond
	t.Cleanup(func() { adminStreamTick = originalTick })

	logs := &streamConsoleLogs{}
	server := startAdminStreamServer(t, streamTestServices(nil, logs))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/console/logs/stream", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session-1"})
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	logs.append(ConsoleLogEntry{ID: "x", Timestamp: "2026-08-16T11:00:00Z", Level: "info", Scope: "s", Message: "flushed"})
	readStreamEvents(t, reader, 1)
	cancel()
	_ = resp.Body.Close()
}
