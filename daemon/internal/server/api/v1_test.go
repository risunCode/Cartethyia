package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	protocolcontracts "github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	apicontracts "github.com/cartethyia/daemon/internal/server/apicontracts"
)

type registrationProxy struct {
	request *protocolcontracts.Request
}

func (p *registrationProxy) DispatchContext(_ context.Context, req *protocolcontracts.Request) (apicontracts.Stream, error) {
	p.request = req
	return registrationStream{}, nil
}

type registrationStream struct{}

func (registrationStream) StatusCode() int      { return http.StatusOK }
func (registrationStream) ContentType() string  { return "application/json" }
func (registrationStream) Headers() http.Header { return nil }
func (registrationStream) Body() apicontracts.StreamReader {
	return io.NopCloser(strings.NewReader(`{"ok":true}`))
}

func TestRegisterV1MountsGeminiRouteOnce(t *testing.T) {
	proxy := &registrationProxy{}
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Proxy: proxy})

	req := httptest.NewRequest(http.MethodPost, "/v1beta/models/gemini-2.5-pro:generateContent", strings.NewReader(`{"contents":[{"parts":[{"text":"hello"}]}]}`))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if proxy.request == nil || proxy.request.Protocol != protocolcontracts.ProtocolGemini || proxy.request.Model != "gemini-2.5-pro" {
		t.Fatalf("request=%+v", proxy.request)
	}
}
