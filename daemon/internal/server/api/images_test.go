package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/apicontracts"
	"github.com/cartethyia/daemon/internal/server/middleware"
)

type imageProxy struct {
	calls  int
	ctx    context.Context
	req    *contracts.Request
	stream apicontracts.Stream
	err    error
}

func (p *imageProxy) DispatchContext(ctx context.Context, req *contracts.Request) (apicontracts.Stream, error) {
	p.calls++
	p.ctx = ctx
	p.req = req
	return p.stream, p.err
}

type imageStream struct{}

func (imageStream) StatusCode() int      { return http.StatusOK }
func (imageStream) ContentType() string  { return "application/json" }
func (imageStream) Headers() http.Header { return nil }
func (imageStream) Body() apicontracts.StreamReader {
	return io.NopCloser(strings.NewReader(`{"created":1,"data":[]}`))
}

func TestImageHandlersPropagateCancellationAndRequestIDOnce(t *testing.T) {
	const secret = "secret=image-handler-cancellation-sentinel"
	tests := []struct {
		name        string
		path        string
		body        string
		contentType string
	}{
		{name: "generations", path: PathGenerations, body: `{"model":"image-test","prompt":"draw"}`, contentType: "application/json"},
		{name: "edits", path: PathEdits, body: "multipart body", contentType: "multipart/form-data; boundary=test"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proxy := &imageProxy{err: fmt.Errorf("%s: %w", secret, context.Canceled)}
			mux := http.NewServeMux()
			RegisterV1(mux, Deps{Proxy: proxy})
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			req := httptest.NewRequest(http.MethodPost, tt.path, strings.NewReader(tt.body)).WithContext(ctx)
			req.Header.Set("Content-Type", tt.contentType)
			rec := httptest.NewRecorder()
			middleware.RequestID(mux).ServeHTTP(rec, req)

			if proxy.calls != 1 {
				t.Fatalf("dispatch calls=%d want=1", proxy.calls)
			}
			if proxy.ctx == nil {
				t.Fatal("dispatch context was not captured")
			}
			if !errors.Is(proxy.ctx.Err(), context.Canceled) {
				t.Fatalf("dispatch context error=%v want=%v", proxy.ctx.Err(), context.Canceled)
			}
			if proxy.req == nil {
				t.Fatal("dispatch request was not captured")
			}
			requestID := rec.Header().Get(middleware.HeaderRequestID)
			if requestID == "" || proxy.req.Headers.Get(middleware.HeaderRequestID) != requestID {
				t.Fatalf("dispatch request ID=%q response request ID=%q", proxy.req.Headers.Get(middleware.HeaderRequestID), requestID)
			}
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("response leaked cancellation detail: %s", rec.Body.String())
			}
		})
	}
}

func TestImageGenerationSuccessSchemaUnchanged(t *testing.T) {
	proxy := &imageProxy{stream: imageStream{}}
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: proxy})
	req := httptest.NewRequest(http.MethodPost, PathGenerations, strings.NewReader(`{"model":"image-test","prompt":"draw"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"created":1,"data":[]}` {
		t.Fatalf("body=%q want successful image schema", got)
	}
	if proxy.calls != 1 {
		t.Fatalf("dispatch calls=%d want=1", proxy.calls)
	}
}

func TestImageEditSuccessSchemaUnchanged(t *testing.T) {
	proxy := &imageProxy{stream: imageStream{}}
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: proxy})
	req := httptest.NewRequest(http.MethodPost, PathEdits, strings.NewReader("multipart body"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"created":1,"data":[]}` {
		t.Fatalf("body=%q want successful image schema", got)
	}
	if proxy.calls != 1 {
		t.Fatalf("dispatch calls=%d want=1", proxy.calls)
	}
}
