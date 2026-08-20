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

func TestMessagesRejectsWrongMethod(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, MessagesPath, nil))

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
	RegisterV1(mux, Deps{Proxy: nil})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"model":"claude"}`))
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
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"model":"claude"}`))
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
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"messages":[}`))
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
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"pad":"`+oversized+`"}`))
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

func TestMessagesDispatchesValidRequest(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "application/json",
		headers:     http.Header{"Anthropic-Request-Id": {"req_upstream_1"}},
		body:        `{"id":"msg_1","type":"message"}`,
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	body := `{"model":"claude-3-5-sonnet","max_tokens":256,"messages":[{"role":"user","content":"hi"}],"stream":false}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"id":"msg_1","type":"message"}` {
		t.Fatalf("body = %q, want %q", got, `{"id":"msg_1","type":"message"}`)
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
	if proxy.dispatched.Protocol != contracts.ProtocolAnthropic {
		t.Fatalf("protocol = %q, want %q", proxy.dispatched.Protocol, contracts.ProtocolAnthropic)
	}
	if proxy.dispatched.Stream {
		t.Fatal("Stream flag = true, want false for stream:false body")
	}
}

func TestMessagesCancellationReachesProxyOnce(t *testing.T) {
	const secret = "secret=messages-cancellation-sentinel"
	proxy := &fakeProxy{err: fmt.Errorf("%s: %w", secret, context.Canceled)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"model":"claude","messages":[]}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	newRouter(proxy).ServeHTTP(rec, req)

	if proxy.calls != 1 {
		t.Fatalf("dispatch calls=%d want=1", proxy.calls)
	}
	if proxy.ctx == nil {
		t.Fatal("dispatch context was not captured")
	}
	if proxy.ctx.Err() != context.Canceled {
		t.Fatalf("dispatch context error=%v want=%v", proxy.ctx.Err(), context.Canceled)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("response leaked cancellation detail: %s", rec.Body.String())
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
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"model":"claude-3-5-sonnet","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
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
	req := httptest.NewRequest(http.MethodPost, MessagesPath, strings.NewReader(`{"model":"claude","messages":[]}`))
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
