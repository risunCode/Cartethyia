package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	apicontracts "github.com/cartethyia/daemon/internal/gateway/contracts"
	apierrors "github.com/cartethyia/daemon/internal/gateway/apierrors"
)

// fakeProxy records every dispatch call so tests can assert the handler
// exits before touching the proxy pipeline on validation failures.
type fakeProxy struct {
	calls      int
	dispatched *contracts.Request
	stream     apicontracts.Stream
	err        error
	ctx        context.Context
}

func (f *fakeProxy) DispatchContext(ctx context.Context, req *contracts.Request) (apicontracts.Stream, error) {
	f.ctx = ctx
	f.calls++
	f.dispatched = req
	return f.stream, f.err
}

// fakeStream implements apicontracts.Stream with a fixed body and headers so
// the handler's downstream copy path can be exercised end-to-end.
type fakeStream struct {
	status      int
	contentType string
	headers     http.Header
	body        string
	closed      bool
}

func (s *fakeStream) StatusCode() int      { return s.status }
func (s *fakeStream) ContentType() string  { return s.contentType }
func (s *fakeStream) Headers() http.Header { return s.headers }
func (s *fakeStream) Body() apicontracts.StreamReader {
	return &fakeReader{Reader: strings.NewReader(s.body), stream: s}
}

type fakeReader struct {
	*strings.Reader
	stream *fakeStream
}

func (r *fakeReader) Close() error {
	r.stream.closed = true
	return nil
}

func newRouter(proxy *fakeProxy) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: proxy})
	return mux
}

func TestChatRejectsWrongMethod(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ChatPath, nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
	if got := rec.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", got, http.MethodPost)
	}
	if proxy.calls != 0 {
		t.Fatalf("proxy.Dispatch was called %d times, want 0", proxy.calls)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodeMethodNotAllowed {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodeMethodNotAllowed)
	}
}

func TestChatRejectsNilProxy(t *testing.T) {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: nil})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{"model":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json prefix", ct)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodeInternal {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodeInternal)
	}
	if body.Error.Message == "" {
		t.Fatal("expected non-empty message for nil proxy")
	}
}

func TestChatRejectsUnsupportedMediaType(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{"model":"x"}`))
	req.Header.Set("Content-Type", "text/plain")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnsupportedMediaType)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodeUnsupportedMedia {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodeUnsupportedMedia)
	}
	if proxy.calls != 0 {
		t.Fatalf("proxy.Dispatch was called %d times, want 0", proxy.calls)
	}
}

func TestChatRejectsMalformedJSON(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{"model":`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodeInvalidRequest {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodeInvalidRequest)
	}
	if proxy.calls != 0 {
		t.Fatalf("proxy.Dispatch was called %d times, want 0", proxy.calls)
	}
}

func TestChatRejectsOversizedBody(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	// 1 byte over the limit forces ReadBoundedJSON's MaxBytesReader to fail
	// and the handler must exit before Dispatch.
	oversized := strings.Repeat("a", apicontracts.MaxBodyBytes+1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{"pad":"`+oversized+`"}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodePayloadTooLarge {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodePayloadTooLarge)
	}
	if proxy.calls != 0 {
		t.Fatalf("proxy.Dispatch was called %d times, want 0", proxy.calls)
	}
}

func TestChatDispatchesValidRequest(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "application/json",
		headers:     http.Header{"OpenAI-Request-Id": {"req_upstream_1"}},
		body:        `{"ok":true}`,
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	body := `{"model":"gpt-4","stream":false,"messages":[{"role":"user","content":"hi"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-123")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"ok":true}` {
		t.Fatalf("body = %q, want %q", got, `{"ok":true}`)
	}
	if got := rec.Header().Get(HeaderUpstreamRequestID); got != "req_upstream_1" {
		t.Fatalf("%s = %q, want %q", HeaderUpstreamRequestID, got, "req_upstream_1")
	}
	if !stream.closed {
		t.Fatal("stream body was not closed after response write")
	}
	if proxy.calls != 1 {
		t.Fatalf("proxy.Dispatch was called %d times, want 1", proxy.calls)
	}
	if proxy.dispatched.Protocol != contracts.ProtocolOpenAIChat {
		t.Fatalf("protocol = %q, want %q", proxy.dispatched.Protocol, contracts.ProtocolOpenAIChat)
	}
	if proxy.dispatched.Stream {
		t.Fatal("Stream flag = true, want false for stream:false body")
	}
	// ReadBoundedJSON re-encodes the body as canonical JSON; ensure the
	// dispatched payload round-tripped through it rather than the raw input.
	var dispatched map[string]any
	if err := json.Unmarshal(proxy.dispatched.Body, &dispatched); err != nil {
		t.Fatalf("dispatched body is not valid JSON: %v", err)
	}
	if dispatched["model"] != "gpt-4" {
		t.Fatalf("dispatched model = %v, want gpt-4", dispatched["model"])
	}
	// Headers are cloned onto the request envelope so the proxy pipeline can
	// forward them without mutating the incoming request.
	if got := proxy.dispatched.Headers.Get("X-Request-Id"); got != "req-123" {
		t.Fatalf("X-Request-Id = %q, want req-123", got)
	}
}

func TestChatCancellationReachesProxyOnce(t *testing.T) {
	const secret = "secret=chat-cancellation-sentinel"
	proxy := &fakeProxy{err: fmt.Errorf("%s: %w", secret, context.Canceled)}
	mux := newRouter(proxy)
	reqCtx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{"model":"gpt-4"}`)).WithContext(reqCtx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if proxy.calls != 1 {
		t.Fatalf("dispatch calls=%d want=1", proxy.calls)
	}
	if proxy.ctx != reqCtx {
		t.Fatal("handler did not pass the inbound request context to dispatch")
	}
	if proxy.ctx.Err() != context.Canceled {
		t.Fatalf("dispatch context error=%v want=%v", proxy.ctx.Err(), context.Canceled)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("response leaked cancellation detail: %s", rec.Body.String())
	}
}

func TestChatForwardsStreamFlag(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "text/event-stream",
		body:        "data: [DONE]\n",
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	body := `{"model":"gpt-4","stream":true}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !proxy.dispatched.Stream {
		t.Fatal("Stream flag = false, want true for stream:true body")
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
}

func TestChatRoutesProxyErrors(t *testing.T) {
	proxy := &fakeProxy{err: &contracts.RouteError{
		Kind:       contracts.ErrorInvalidRequest,
		StatusCode: http.StatusBadRequest,
		Message:    "missing model",
	}}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ChatPath, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if proxy.calls != 1 {
		t.Fatalf("proxy.Dispatch was called %d times, want 1", proxy.calls)
	}
	var body apierrors.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the envelope: %v", err)
	}
	if body.Error.Code != apierrors.CodeInvalidRequest {
		t.Fatalf("code = %q, want %q", body.Error.Code, apierrors.CodeInvalidRequest)
	}
	if body.Error.Message != "missing model" {
		t.Fatalf("message = %q, want %q", body.Error.Message, "missing model")
	}
}

// Compile-time check that the fakeReader satisfies the io.Closer portion of
// stream contract used by WriteStream.
var _ io.Closer = (*fakeReader)(nil)
