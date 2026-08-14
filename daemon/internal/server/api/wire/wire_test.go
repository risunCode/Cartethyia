package wire

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	proxycontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
)

type testStream struct {
	reader *testReader
}

func (s *testStream) StatusCode() int      { return http.StatusOK }
func (s *testStream) ContentType() string  { return "text/event-stream" }
func (s *testStream) Headers() http.Header { return nil }
func (s *testStream) Body() apicontracts.StreamReader {
	return s.reader
}

type testReader struct {
	mu       sync.Mutex
	closed   bool
	aborted  error
	started  chan struct{}
	release  chan struct{}
	readData []byte
}

func (r *testReader) Read(p []byte) (int, error) {
	return r.ReadContext(context.Background(), p)
}

func (r *testReader) ReadContext(ctx context.Context, p []byte) (int, error) {
	select {
	case <-r.started:
	default:
		close(r.started)
	}
	if len(r.readData) > 0 {
		n := copy(p, r.readData)
		r.readData = r.readData[n:]
		return n, nil
	}
	select {
	case <-r.release:
		return 0, io.EOF
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (r *testReader) Close() error {
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	return nil
}

func (r *testReader) Abort(err error) {
	r.mu.Lock()
	r.aborted = err
	r.mu.Unlock()
}

func TestWriteStreamCancellationStopsBlockedRead(t *testing.T) {
	reader := &testReader{started: make(chan struct{}), release: make(chan struct{})}
	stream := &testStream{reader: reader}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- WriteStream(ctx, newTestWriter(), stream)
	}()
	select {
	case <-reader.started:
	case <-time.After(time.Second):
		t.Fatal("stream reader did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("WriteStream error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WriteStream did not stop after cancellation")
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !reader.closed {
		t.Fatal("stream body was not closed")
	}
	if !errors.Is(reader.aborted, context.Canceled) {
		t.Fatalf("abort error = %v, want context.Canceled", reader.aborted)
	}
}

func TestReadBoundedJSONRejectsTrailingValue(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/test", strings.NewReader(`{"model":"one"}{"model":"two"}`))
	_, err := ReadBoundedJSON(req, 1024)
	if err == nil {
		t.Fatal("ReadBoundedJSON accepted trailing JSON value")
	}
	var routeErr *proxycontracts.RouteError
	if !errors.As(err, &routeErr) || routeErr.StatusCode != http.StatusBadRequest {
		t.Fatalf("error = %v, want bad request RouteError", err)
	}
}

func TestWriteStreamPropagatesWriterError(t *testing.T) {
	writerErr := errors.New("client write failed")
	reader := &testReader{started: make(chan struct{}), release: make(chan struct{}), readData: []byte("data")}
	stream := &testStream{reader: reader}
	err := WriteStream(context.Background(), &errorWriter{err: writerErr}, stream)
	if !errors.Is(err, writerErr) {
		t.Fatalf("WriteStream error = %v, want writer error", err)
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !errors.Is(reader.aborted, writerErr) {
		t.Fatalf("abort error = %v, want writer error", reader.aborted)
	}
	if !reader.closed {
		t.Fatal("stream body was not closed")
	}
}

type errorWriter struct {
	err error
}

func newTestWriter() http.ResponseWriter {
	return &discardWriter{header: make(http.Header)}
}

func (w *errorWriter) Header() http.Header { return make(http.Header) }
func (w *errorWriter) WriteHeader(int)     {}
func (w *errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}

type discardWriter struct {
	header http.Header
}

func (w *discardWriter) Header() http.Header { return w.header }
func (w *discardWriter) WriteHeader(int)     {}
func (w *discardWriter) Write(p []byte) (int, error) {
	return len(strings.TrimSpace(string(p))), nil
}
