package transport

import (
	"net/http"
	"testing"
	"time"
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
