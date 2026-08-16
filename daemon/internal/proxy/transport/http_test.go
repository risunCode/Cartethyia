package transport

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	proxy "github.com/cartethyia/daemon/internal/proxy/runtime"
)

func TestHTTPTransportClientAppliesUpstreamTimeoutBudgets(t *testing.T) {
	tr := &HTTPTransport{
		ConnectTimeout:   11 * time.Second,
		FirstByteTimeout: 13 * time.Second,
		TotalTimeout:     17 * time.Second,
		IdleTimeout:      19 * time.Second,
	}
	client := tr.client()
	if client == nil {
		t.Fatal("client is nil")
	}
	if client.Timeout != 17*time.Second {
		t.Fatalf("client timeout=%s, want 17s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("client transport=%T, want *http.Transport", client.Transport)
	}
	if transport.TLSHandshakeTimeout != 11*time.Second {
		t.Fatalf("TLS handshake timeout=%s, want 11s", transport.TLSHandshakeTimeout)
	}
	if transport.ResponseHeaderTimeout != 13*time.Second {
		t.Fatalf("first-byte timeout=%s, want 13s", transport.ResponseHeaderTimeout)
	}
	if transport.IdleConnTimeout != 19*time.Second {
		t.Fatalf("idle timeout=%s, want 19s", transport.IdleConnTimeout)
	}
	if transport.DialContext == nil {
		t.Fatal("connect timeout did not install a dialer")
	}
}

func TestHTTPTransportClientForProxy(t *testing.T) {
	tr := &HTTPTransport{
		ConnectTimeout:   5 * time.Second,
		FirstByteTimeout: 5 * time.Second,
		TotalTimeout:     10 * time.Second,
		IdleTimeout:      10 * time.Second,
	}

	// Nil proxy returns default client
	cNil, err := tr.clientForProxy(nil)
	if err != nil || cNil == nil {
		t.Fatalf("nil proxy client err=%v", err)
	}

	// HTTP proxy
	httpURL, _ := url.Parse("http://127.0.0.1:8080")
	cHTTP, err := tr.clientForProxy(httpURL)
	if err != nil || cHTTP == nil {
		t.Fatalf("http proxy client err=%v", err)
	}

	// HTTPS proxy
	httpsURL, _ := url.Parse("https://127.0.0.1:8443")
	cHTTPS, err := tr.clientForProxy(httpsURL)
	if err != nil || cHTTPS == nil {
		t.Fatalf("https proxy client err=%v", err)
	}

	// SOCKS5 proxy
	socksURL, _ := url.Parse("socks5://user:pass@127.0.0.1:1080")
	cSocks, err := tr.clientForProxy(socksURL)
	if err != nil || cSocks == nil {
		t.Fatalf("socks proxy client err=%v", err)
	}

	// Unsupported scheme
	ftpURL, _ := url.Parse("ftp://127.0.0.1:21")
	if _, err := tr.clientForProxy(ftpURL); err == nil {
		t.Fatal("expected unsupported proxy scheme error")
	}
}

func TestHTTPTransportProxySuccessCallback(t *testing.T) {
	recordedID := ""
	tr := &HTTPTransport{
		ProxySuccess: func(ctx context.Context, proxyID string) {
			recordedID = proxyID
		},
	}
	tr.recordProxySuccess(context.Background(), "proxy-123")
	if recordedID != "proxy-123" {
		t.Fatalf("recordProxySuccess = %q, want 'proxy-123'", recordedID)
	}
	// Empty proxyID should not invoke callback
	recordedID = ""
	tr.recordProxySuccess(context.Background(), "")
	if recordedID != "" {
		t.Fatal("empty proxyID invoked callback")
	}
}

func TestHTTPTransportProposeRepair(t *testing.T) {
	tr := &HTTPTransport{}
	req := contracts.Request{
		Protocol: contracts.SurfaceOpenAIChat,
		Model:    "gpt-4o",
		Body:     []byte(`{"messages":[{"role":"user","content":"hi"}]}`),
	}
	// Nil registry should return false
	_, ok := tr.ProposeRepair(proxy.Account{Provider: "openai"}, req, "rule-1")
	if ok {
		t.Fatal("expected false for nil registry ProposeRepair")
	}
}

func TestHTTPTransportMaxBytes(t *testing.T) {
	tr := &HTTPTransport{MaxResponseBytes: 1024}
	if got := tr.maxBytes(); got != 1024 {
		t.Fatalf("maxBytes = %d, want 1024", got)
	}
	trDefault := &HTTPTransport{}
	if got := trDefault.maxBytes(); got != DefaultMaxResponseBytes {
		t.Fatalf("default maxBytes = %d", got)
	}
	if got := tr.maxSSEEventBytes(); got != 1024 {
		t.Fatalf("maxSSEEventBytes = %d, want 1024", got)
	}
	if got := tr.maxSSELineBytes(); got != 1024 {
		t.Fatalf("maxSSELineBytes = %d, want 1024", got)
	}
	if got := trDefault.maxSSELineBytes(); got != DefaultMaxSSELineBytes {
		t.Fatalf("default maxSSELineBytes = %d", got)
	}
}
