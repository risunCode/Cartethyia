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

func TestResponsesRejectsWrongMethod(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, ResponsesPath, nil))

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

func TestResponsesRejectsNilProxy(t *testing.T) {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: nil})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`{"model":"x"}`))
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

func TestResponsesRejectsUnsupportedMediaType(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`{"model":"x"}`))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
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

func TestResponsesRejectsMalformedJSON(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`not json`))
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

func TestResponsesRejectsOversizedBody(t *testing.T) {
	proxy := &fakeProxy{}
	mux := newRouter(proxy)

	oversized := strings.Repeat("b", apicontracts.MaxBodyBytes+1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`{"pad":"`+oversized+`"}`))
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

func TestResponsesDispatchesValidRequest(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "application/json",
		headers:     http.Header{"OpenAI-Request-Id": {"req_upstream_1"}},
		body:        `{"id":"resp_1","status":"completed"}`,
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	body := `{"model":"gpt-4o","input":"hello","stream":false}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"id":"resp_1","status":"completed"}` {
		t.Fatalf("body = %q, want %q", got, `{"id":"resp_1","status":"completed"}`)
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
	if proxy.dispatched.Protocol != contracts.ProtocolOpenAIResponse {
		t.Fatalf("protocol = %q, want %q", proxy.dispatched.Protocol, contracts.ProtocolOpenAIResponse)
	}
	if proxy.dispatched.Stream {
		t.Fatal("Stream flag = true, want false for stream:false body")
	}
}

func TestResponsesCancellationReachesProxyOnce(t *testing.T) {
	const secret = "secret=responses-cancellation-sentinel"
	proxy := &fakeProxy{err: fmt.Errorf("%s: %w", secret, context.Canceled)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`{"model":"gpt-4o","input":"hello"}`)).WithContext(ctx)
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

func TestResponsesForwardsStreamFlag(t *testing.T) {
	stream := &fakeStream{
		status:      http.StatusOK,
		contentType: "text/event-stream",
		body:        "event: response.completed\ndata: [DONE]\n",
	}
	proxy := &fakeProxy{stream: stream}
	mux := newRouter(proxy)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, ResponsesPath, strings.NewReader(`{"model":"gpt-4o","stream":true}`))
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

var _ io.Closer = (*fakeReader)(nil)
