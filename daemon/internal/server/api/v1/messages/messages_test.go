package messages

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/api/contracts"
	apierrors "github.com/cartethyia/daemon/internal/server/api/errors"
)

type fakeProxy struct {
	calls      int
	dispatched *contracts.Request
	stream     apicontracts.Stream
	err        error
}

func (f *fakeProxy) Dispatch(req *contracts.Request) (apicontracts.Stream, error) {
	f.calls++
	f.dispatched = req
	return f.stream, f.err
}

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
	Register(mux, Deps{Proxy: proxy})
	return mux
}

func TestMessagesRejectsWrongMethod(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, Path, nil))

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

func TestMessagesRejectsNilProxy(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Deps{Proxy: nil})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"model":"claude"}`))
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

func TestMessagesRejectsUnsupportedMediaType(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"model":"claude"}`))
	req.Header.Set("Content-Type", "application/xml")
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

func TestMessagesRejectsMalformedJSON(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"messages":[}`))
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

func TestMessagesRejectsOversizedBody(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	oversized := strings.Repeat("c", apicontracts.MaxBodyBytes+1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"pad":"`+oversized+`"}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code < 400 || rec.Code > 499 {
		t.Fatalf("status = %d, want a 4xx", rec.Code)
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

func TestMessagesDispatchesValidRequest(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "application/json",
		headers:     http.Header{"X-Provider": {"anthropic"}},
		body:        `{"id":"msg_1","type":"message"}`,
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	body := `{"model":"claude-3-5-sonnet","max_tokens":256,"messages":[{"role":"user","content":"hi"}],"stream":false}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"id":"msg_1","type":"message"}` {
		t.Fatalf("body = %q, want %q", got, `{"id":"msg_1","type":"message"}`)
	}
	if got := rec.Header().Get("X-Provider"); got != "anthropic" {
		t.Fatalf("X-Provider = %q, want %q", got, "anthropic")
	}
	if !stream.closed {
		t.Fatal("stream body was not closed after response write")
	}
	if proxy.calls != 1 {
		t.Fatalf("proxy.Dispatch was called %d times, want 1", proxy.calls)
	}
	if proxy.dispatched.Protocol != contracts.ProtocolAnthropic {
		t.Fatalf("protocol = %q, want %q", proxy.dispatched.Protocol, contracts.ProtocolAnthropic)
	}
	if proxy.dispatched.Stream {
		t.Fatal("Stream flag = true, want false for stream:false body")
	}
}

func TestMessagesForwardsStreamFlag(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "text/event-stream",
		body:        "event: message_stop\ndata: [DONE]\n",
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"model":"claude-3-5-sonnet","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
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

func TestMessagesRoutesProxyErrors(t *testing.T) {
	proxy := &fakeProxy{err: &contracts.RouteError{
		Kind:       contracts.ErrorInvalidRequest,
		StatusCode: http.StatusBadRequest,
		Message:    "messages must include at least one message",
	}}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"model":"claude","messages":[]}`))
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
}

var _ io.Closer = (*fakeReader)(nil)
