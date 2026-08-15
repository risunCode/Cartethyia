package wire

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type deadlineWriter struct {
	header    http.Header
	deadlines []time.Time
	err       error
}

type advancingDeadlineWriter struct {
	deadlineWriter
	now     *time.Time
	advance time.Duration
	writes  int
	flushes int
}

func (w *advancingDeadlineWriter) Write(p []byte) (int, error) {
	w.writes++
	return len(p), nil
}

func (w *advancingDeadlineWriter) Flush() {
	w.flushes++
	*w.now = w.now.Add(w.advance)
}

func (w *deadlineWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *deadlineWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *deadlineWriter) WriteHeader(int)             {}
func (w *deadlineWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return w.err
}

func TestRefreshStreamWriteDeadlineRefreshesWithoutExtendingTotal(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	policy := &streamDeadlinePolicy{
		writeTimeout:  5 * time.Second,
		totalDeadline: now.Add(12 * time.Second),
		now:           func() time.Time { return now },
	}
	ctx := context.WithValue(context.Background(), streamDeadlineContextKey{}, policy)
	writer := &deadlineWriter{}

	if err := RefreshStreamWriteDeadline(ctx, writer); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	now = now.Add(10 * time.Second)
	if err := RefreshStreamWriteDeadline(ctx, writer); err != nil {
		t.Fatalf("clamped refresh: %v", err)
	}
	want := []time.Time{time.Unix(1_700_000_005, 0), time.Unix(1_700_000_012, 0)}
	if len(writer.deadlines) != len(want) {
		t.Fatalf("deadline calls=%d, want %d", len(writer.deadlines), len(want))
	}
	for i := range want {
		if !writer.deadlines[i].Equal(want[i]) {
			t.Fatalf("deadline[%d]=%s, want %s", i, writer.deadlines[i], want[i])
		}
	}
}

func TestRefreshStreamWriteDeadlineRejectsExhaustedTotalBudget(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	policy := &streamDeadlinePolicy{
		writeTimeout:  time.Second,
		totalDeadline: now,
		now:           func() time.Time { return now },
	}
	ctx := context.WithValue(context.Background(), streamDeadlineContextKey{}, policy)
	writer := &deadlineWriter{}
	if err := RefreshStreamWriteDeadline(ctx, writer); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("refresh error=%v, want deadline exceeded", err)
	}
	if len(writer.deadlines) != 0 {
		t.Fatalf("deadline was refreshed after total exhaustion: %v", writer.deadlines)
	}
}

func TestRefreshStreamWriteDeadlineAllowsUnsupportedWriter(t *testing.T) {
	policy := &streamDeadlinePolicy{
		writeTimeout:  time.Second,
		totalDeadline: time.Now().Add(time.Minute),
		now:           time.Now,
	}
	ctx := context.WithValue(context.Background(), streamDeadlineContextKey{}, policy)
	if err := RefreshStreamWriteDeadline(ctx, httptest.NewRecorder()); err != nil {
		t.Fatalf("unsupported recorder refresh: %v", err)
	}
}

func TestWithStreamDeadlinesAttachesRequestStartBudget(t *testing.T) {
	var policy *streamDeadlinePolicy
	handler := WithStreamDeadlines(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		policy, _ = r.Context().Value(streamDeadlineContextKey{}).(*streamDeadlinePolicy)
	}), 3*time.Second, 11*time.Second)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/test", nil))
	if policy == nil {
		t.Fatal("stream deadline policy was not attached")
	}
	if policy.writeTimeout != 3*time.Second {
		t.Fatalf("write timeout=%s, want 3s", policy.writeTimeout)
	}
	remaining := time.Until(policy.totalDeadline)
	if remaining <= 0 || remaining > 11*time.Second {
		t.Fatalf("invalid hard total deadline remaining=%s", remaining)
	}
}

func TestHealthyLongStreamRefreshesWriteBudgetPerFrame(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	policy := &streamDeadlinePolicy{
		writeTimeout:  5 * time.Second,
		totalDeadline: now.Add(30 * time.Second),
		now:           func() time.Time { return now },
	}
	ctx := context.WithValue(context.Background(), streamDeadlineContextKey{}, policy)
	release := make(chan struct{})
	close(release)
	reader := &testReader{
		started:  make(chan struct{}),
		release:  release,
		readData: []byte("data: one\n\ndata: two\n\ndata: three\n\n"),
	}
	writer := &advancingDeadlineWriter{now: &now, advance: 4 * time.Second}
	if err := WriteStream(ctx, writer, &testStream{reader: reader}); err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	if writer.flushes != 3 || writer.writes != 3 {
		t.Fatalf("frames wrote=%d flushed=%d, want 3/3", writer.writes, writer.flushes)
	}
	if got := len(writer.deadlines); got != 4 {
		t.Fatalf("write deadline refreshes=%d, want initial plus three frames", got)
	}
	if !writer.deadlines[3].Equal(time.Unix(1_700_000_017, 0)) {
		t.Fatalf("last deadline=%s, want refreshed healthy budget", writer.deadlines[3])
	}
}

func TestStreamTotalTimeoutAbortsAfterSuccessfulFrame(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	policy := &streamDeadlinePolicy{
		writeTimeout:  2 * time.Second,
		totalDeadline: now.Add(5 * time.Second),
		now:           func() time.Time { return now },
	}
	ctx := context.WithValue(context.Background(), streamDeadlineContextKey{}, policy)
	release := make(chan struct{})
	close(release)
	reader := &testReader{
		started:  make(chan struct{}),
		release:  release,
		readData: []byte("data: one\n\n"),
	}
	writer := &advancingDeadlineWriter{now: &now, advance: 5 * time.Second}
	err := WriteStream(ctx, writer, &testStream{reader: reader})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WriteStream error=%v, want total deadline", err)
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !errors.Is(reader.aborted, context.DeadlineExceeded) {
		t.Fatalf("abort error=%v, want total deadline", reader.aborted)
	}
}
