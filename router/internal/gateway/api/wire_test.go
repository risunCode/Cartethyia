package api

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	proxycontracts "github.com/cartethyia/daemon/internal/protocol"
	apicontracts "github.com/cartethyia/daemon/internal/gateway/contracts"
)

type testStream struct {
	reader *testReader
	header http.Header
}

func (s *testStream) StatusCode() int      { return http.StatusOK }
func (s *testStream) ContentType() string  { return "text/event-stream" }
func (s *testStream) Headers() http.Header { return s.header }
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

func TestReadBoundedJSONReportsPayloadTooLargeWithoutLeakingBody(t *testing.T) {
	const secretSentinel = "prompt-SENTINEL-oversized-json"
	req := httptest.NewRequest(http.MethodPost, "/v1/test", strings.NewReader(`{"prompt":"`+secretSentinel+`"}`))
	_, err := ReadBoundedJSON(req, 8)
	if err == nil {
		t.Fatal("ReadBoundedJSON accepted an oversized payload")
	}
	var routeErr *proxycontracts.RouteError
	if !errors.As(err, &routeErr) {
		t.Fatalf("error=%T %v, want RouteError", err, err)
	}
	if routeErr.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d, want 413", routeErr.StatusCode)
	}
	if routeErr.Code != "payload_too_large" {
		t.Fatalf("code=%q, want payload_too_large", routeErr.Code)
	}
	if strings.Contains(err.Error(), secretSentinel) || strings.Contains(routeErr.Message, secretSentinel) {
		t.Fatalf("client error leaked request sentinel: %q", err)
	}
}

func TestWriteStreamPropagatesWriterError(t *testing.T) {
	writerErr := errors.New("client write failed")
	reader := &testReader{started: make(chan struct{}), release: make(chan struct{}), readData: []byte("data: failed\n\n")}
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

func TestWriteStreamForwardsOnlySafeResponseHeaders(t *testing.T) {
	release := make(chan struct{})
	close(release)
	reader := &testReader{
		started:  make(chan struct{}),
		release:  release,
		readData: []byte("data: [DONE]\n\n"),
	}
	stream := &testStream{reader: reader, header: http.Header{
		"Cache-Control":            {"no-cache"},
		"Connection":               {"keep-alive"},
		"Set-Cookie":               {"session=credential-SENTINEL-cookie"},
		"Authorization":            {"Bearer credential-SENTINEL-header"},
		"Proxy-Authenticate":       {"Basic realm=proxy-password-SENTINEL"},
		"X-Cartethyia-Provider":    {"private-provider"},
		"X-Upstream-Private-Debug": {"prompt-SENTINEL-private"},
	}}
	response := httptest.NewRecorder()

	if err := WriteStream(context.Background(), response, stream); err != nil {
		t.Fatalf("WriteStream error=%v", err)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("safe Cache-Control=%q, want no-cache", got)
	}
	for _, name := range []string{
		"Connection", "Set-Cookie", "Authorization", "Proxy-Authenticate",
		"X-Cartethyia-Provider", "X-Upstream-Private-Debug",
	} {
		if got := response.Header().Values(name); len(got) != 0 {
			t.Fatalf("unsafe header %s forwarded as %q", name, got)
		}
	}
	for _, sentinel := range []string{"credential-SENTINEL", "proxy-password-SENTINEL", "prompt-SENTINEL"} {
		for name, values := range response.Header() {
			if strings.Contains(strings.Join(values, ","), sentinel) {
				t.Fatalf("response header %s leaked sentinel %q", name, sentinel)
			}
		}
	}
}

type frameReader struct {
	frames [][]byte
	index  int
}

func (r *frameReader) Read(p []byte) (int, error) {
	if r.index >= len(r.frames) {
		return 0, io.EOF
	}
	n := copy(p, r.frames[r.index])
	r.index++
	return n, nil
}

func (*frameReader) Close() error { return nil }

type frameStream struct{ reader *frameReader }

func (*frameStream) StatusCode() int      { return http.StatusOK }
func (*frameStream) ContentType() string  { return "text/event-stream" }
func (*frameStream) Headers() http.Header { return nil }
func (s *frameStream) Body() apicontracts.StreamReader {
	return s.reader
}

type flushRecorder struct {
	header     http.Header
	statusCode int
	writes     []string
	flushes    int
}

func (w *flushRecorder) Header() http.Header { return w.header }
func (w *flushRecorder) WriteHeader(statusCode int) {
	w.statusCode = statusCode
}
func (w *flushRecorder) Write(p []byte) (int, error) {
	w.writes = append(w.writes, string(p))
	return len(p), nil
}
func (w *flushRecorder) Flush() { w.flushes++ }

func TestWriteStreamFlushesEveryDownstreamSSEFrame(t *testing.T) {
	stream := &frameStream{reader: &frameReader{frames: [][]byte{
		[]byte("event: response.output_text.delta\ndata: {\"delta\":\"one\"}\n\n" +
			"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"),
	}}}
	response := &flushRecorder{header: make(http.Header)}

	if err := WriteStream(context.Background(), response, stream); err != nil {
		t.Fatalf("WriteStream error=%v", err)
	}
	if response.statusCode != http.StatusOK {
		t.Fatalf("status=%d, want 200", response.statusCode)
	}
	if len(response.writes) != 2 {
		t.Fatalf("downstream writes=%d, want 2", len(response.writes))
	}
	if response.flushes != len(response.writes) {
		t.Fatalf("flushes=%d writes=%d, want one flush per frame", response.flushes, len(response.writes))
	}
}

type flushErrorWriter struct {
	header http.Header
	err    error
}

func (w *flushErrorWriter) Header() http.Header       { return w.header }
func (*flushErrorWriter) WriteHeader(int)             {}
func (*flushErrorWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *flushErrorWriter) FlushError() error         { return w.err }

func TestWriteStreamAbortsBeforeReturningFlushFailure(t *testing.T) {
	flushErr := errors.New("client flush failed")
	release := make(chan struct{})
	close(release)
	reader := &testReader{
		started: make(chan struct{}), release: release,
		readData: []byte("data: complete\n\n"),
	}
	err := WriteStream(context.Background(), &flushErrorWriter{header: make(http.Header), err: flushErr}, &testStream{reader: reader})
	if !errors.Is(err, flushErr) {
		t.Fatalf("WriteStream error=%v, want flush failure", err)
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !errors.Is(reader.aborted, flushErr) {
		t.Fatalf("abort error=%v, want flush failure", reader.aborted)
	}
	if !reader.closed {
		t.Fatal("stream body was not closed after flush failure")
	}
}

type liveReader struct {
	mu        sync.Mutex
	release   <-chan struct{}
	read      int
	closes    int
	finalizes int
	aborts    int
}

func (r *liveReader) Read(p []byte) (int, error) {
	r.mu.Lock()
	read := r.read
	r.read++
	r.mu.Unlock()
	switch read {
	case 0:
		return copy(p, "data: first\n\n"), nil
	case 1:
		<-r.release
		return copy(p, "data: [DONE]\n\n"), nil
	default:
		return 0, io.EOF
	}
}

func (r *liveReader) Close() error {
	r.mu.Lock()
	r.closes++
	r.finalizes++
	r.mu.Unlock()
	return nil
}

func (r *liveReader) Abort(error) {
	r.mu.Lock()
	r.aborts++
	r.mu.Unlock()
}

type liveStream struct{ reader *liveReader }

func (*liveStream) StatusCode() int                   { return http.StatusOK }
func (*liveStream) ContentType() string               { return "text/event-stream" }
func (*liveStream) Headers() http.Header              { return nil }
func (s *liveStream) Body() apicontracts.StreamReader { return s.reader }

type countingFlushWriter struct {
	http.ResponseWriter
	mu      sync.Mutex
	flushes int
}

func (w *countingFlushWriter) FlushError() error {
	w.mu.Lock()
	w.flushes++
	w.mu.Unlock()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func TestWriteStreamDeliversFirstFrameBeforeHandlerCompletion(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseStream := func() { releaseOnce.Do(func() { close(release) }) }
	reader := &liveReader{release: release}
	handlerDone := make(chan struct{})
	writerReady := make(chan *countingFlushWriter, 1)
	writeResult := make(chan error, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		countingWriter := &countingFlushWriter{ResponseWriter: w}
		writerReady <- countingWriter
		writeResult <- WriteStream(request.Context(), countingWriter, &liveStream{reader: reader})
		close(handlerDone)
	}))
	defer server.Close()
	defer releaseStream()

	response, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatalf("stream request error=%v", err)
	}
	defer response.Body.Close()
	clientReader := bufio.NewReader(response.Body)
	firstLine, err := clientReader.ReadString('\n')
	if err != nil {
		t.Fatalf("first frame data read error=%v", err)
	}
	blankLine, err := clientReader.ReadString('\n')
	if err != nil {
		t.Fatalf("first frame terminator read error=%v", err)
	}
	if firstLine+blankLine != "data: first\n\n" {
		t.Fatalf("first frame=%q, want exact first frame", firstLine+blankLine)
	}
	select {
	case <-handlerDone:
		t.Fatal("handler completed before the client observed the first frame")
	default:
	}

	releaseStream()
	remainder, err := io.ReadAll(clientReader)
	if err != nil {
		t.Fatalf("terminal frame read error=%v", err)
	}
	if got := strings.Count(firstLine+blankLine+string(remainder), "data: [DONE]\n\n"); got != 1 {
		t.Fatalf("terminal frame count=%d, want 1; remainder=%q", got, remainder)
	}
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("handler did not complete after terminal frame")
	}
	if err := <-writeResult; err != nil {
		t.Fatalf("WriteStream error=%v", err)
	}
	countingWriter := <-writerReady
	countingWriter.mu.Lock()
	flushes := countingWriter.flushes
	countingWriter.mu.Unlock()
	if flushes != 2 {
		t.Fatalf("flush count=%d, want 2", flushes)
	}
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if reader.closes != 1 || reader.finalizes != 1 || reader.aborts != 0 {
		t.Fatalf("close/finalizer/abort counts=%d/%d/%d, want 1/1/0", reader.closes, reader.finalizes, reader.aborts)
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
