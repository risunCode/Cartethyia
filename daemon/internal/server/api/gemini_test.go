package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/compatibility"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/apicontracts"
)

type captureProxy struct {
	ctx  context.Context
	req  *contracts.Request
	body string
}

func (p *captureProxy) DispatchContext(ctx context.Context, req *contracts.Request) (apicontracts.Stream, error) {
	p.ctx = ctx
	p.req = req
	return captureStream{body: p.body}, nil
}

type captureStream struct {
	body string
}

func (s captureStream) StatusCode() int      { return http.StatusOK }
func (s captureStream) ContentType() string  { return "application/json" }
func (s captureStream) Headers() http.Header { return nil }
func (s captureStream) Body() apicontracts.StreamReader {
	return io.NopCloser(strings.NewReader(s.body))
}

func geminiMux(proxy apicontracts.ProxyService) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: proxy})
	return mux
}

func TestGenerateContentDispatchesNativeRequestAndProfile(t *testing.T) {
	proxy := &captureProxy{body: `{"candidates":[]}`}
	req := httptest.NewRequest(http.MethodPost, "/v1beta/models/gemini-2.5-pro:generateContent", strings.NewReader(`{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	geminiMux(proxy).ServeHTTP(response, req)

	if response.Code != http.StatusOK || response.Body.String() != proxy.body {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if proxy.req == nil || proxy.req.Protocol != contracts.ProtocolGemini || proxy.req.Model != "gemini-2.5-pro" || proxy.req.Stream {
		t.Fatalf("request=%+v", proxy.req)
	}
	if got := string(proxy.req.Body); got != `{"contents":[{"parts":[{"text":"hello"}],"role":"user"}]}` {
		t.Fatalf("body=%q", got)
	}
	profile, ok := compatibility.ProfileFromContext(proxy.ctx)
	if !ok || profile.ID != compatibility.ProfileGeminiCLI || profile.Surface != contracts.SurfaceGemini {
		t.Fatalf("profile=%+v present=%v", profile, ok)
	}
}

func TestStreamGenerateContentUsesNativeStreamAction(t *testing.T) {
	proxy := &captureProxy{body: "data: {\"candidates\":[]}\n\n"}
	req := httptest.NewRequest(http.MethodPost, "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse", strings.NewReader(`{"contents":[{"parts":[{"text":"hello"}]}]}`))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	geminiMux(proxy).ServeHTTP(response, req)

	if response.Code != http.StatusOK || !proxy.req.Stream {
		t.Fatalf("status=%d request=%+v", response.Code, proxy.req)
	}
}

func TestGeminiRouteRejectsInvalidMethodMediaAndBody(t *testing.T) {
	cases := []struct {
		name        string
		method      string
		contentType string
		body        string
		status      int
	}{
		{name: "method", method: http.MethodGet, contentType: "application/json", body: `{}`, status: http.StatusMethodNotAllowed},
		{name: "media", method: http.MethodPost, contentType: "text/plain", body: `{}`, status: http.StatusUnsupportedMediaType},
		{name: "body", method: http.MethodPost, contentType: "application/json", body: `{`, status: http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proxy := &captureProxy{body: `{}`}
			req := httptest.NewRequest(tc.method, "/v1beta/models/gemini-2.5-pro:generateContent", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			response := httptest.NewRecorder()
			geminiMux(proxy).ServeHTTP(response, req)
			if response.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
			}
			if proxy.req != nil {
				t.Fatal("invalid request reached proxy")
			}
		})
	}
}
