package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	"github.com/cartethyia/daemon/internal/egress"
)

func newIngressRuntime(t *testing.T, cfg Config) *Runtime {
	t.Helper()
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatalf("default registry: %v", err)
	}
	r, err := newRuntimeWithBootstrap(cfg, "", BootstrapDependencies{
		Registry: registry,
		Credentials: egress.CredentialResolver(func(context.Context, string) (string, error) {
			return "fixture-credential", nil
		}),
	}, RuntimeOptions{})
	if err != nil {
		t.Fatalf("new runtime: %v", err)
	}
	return r
}

func serveIngressFixture(t *testing.T, r *Runtime, handler http.Handler) net.Listener {
	t.Helper()
	r.server.Handler = handler
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- r.server.Serve(listener) }()
	t.Cleanup(func() {
		if r.serveCancel != nil {
			r.serveCancel()
		}
		_ = r.server.Close()
		_ = listener.Close()
		err := <-done
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("server exit: %v", err)
		}
	})
	return listener
}

func readUntilServerBound(t *testing.T, conn net.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	_, err := io.ReadAll(conn)
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		t.Fatal("server left the hostile connection open past the fixture deadline")
	}
}

func TestRuntimeServerConfiguresHeaderAndRequestBounds(t *testing.T) {
	cfg := Config{
		ReadHeaderTimeout: 9 * time.Second,
		MaxHeaderBytes:    128 * 1024,
	}.WithDefaults()
	r := newIngressRuntime(t, cfg)
	if r.server.ReadHeaderTimeout != cfg.ReadHeaderTimeout {
		t.Fatalf("ReadHeaderTimeout=%s, want %s", r.server.ReadHeaderTimeout, cfg.ReadHeaderTimeout)
	}
	if r.server.MaxHeaderBytes != cfg.MaxHeaderBytes {
		t.Fatalf("MaxHeaderBytes=%d, want %d", r.server.MaxHeaderBytes, cfg.MaxHeaderBytes)
	}
	if r.server.ReadTimeout != cfg.RequestTimeout || r.server.WriteTimeout != cfg.RequestTimeout {
		t.Fatalf("non-stream request bounds changed: read=%s write=%s", r.server.ReadTimeout, r.server.WriteTimeout)
	}
}

func TestRuntimeSlowHeaderConnectionIsBounded(t *testing.T) {
	cfg := Config{
		RequestTimeout:    500 * time.Millisecond,
		ReadHeaderTimeout: 20 * time.Millisecond,
	}.WithDefaults()
	r := newIngressRuntime(t, cfg)
	listener := serveIngressFixture(t, r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: fixture"); err != nil {
		t.Fatalf("write partial header: %v", err)
	}
	readUntilServerBound(t, conn)
}

func TestRuntimeOversizedHeaderReturns431(t *testing.T) {
	cfg := Config{
		RequestTimeout:    time.Second,
		ReadHeaderTimeout: time.Second,
		MaxHeaderBytes:    64 * 1024,
	}.WithDefaults()
	r := newIngressRuntime(t, cfg)
	listener := serveIngressFixture(t, r, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	request := "GET / HTTP/1.1\r\nHost: fixture\r\nX-Oversized: " + strings.Repeat("a", 80*1024) + "\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatalf("write oversized header: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("read oversized-header response: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("status=%d, want 431", response.StatusCode)
	}
}

func TestRuntimeSlowBodyConnectionIsBounded(t *testing.T) {
	cfg := Config{
		RequestTimeout:    30 * time.Millisecond,
		ReadHeaderTimeout: 20 * time.Millisecond,
	}.WithDefaults()
	r := newIngressRuntime(t, cfg)
	listener := serveIngressFixture(t, r, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if _, err := io.Copy(io.Discard, request.Body); err != nil {
			http.Error(w, "request body timeout", http.StatusRequestTimeout)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 32\r\n\r\n"); err != nil {
		t.Fatalf("write body headers: %v", err)
	}
	readUntilServerBound(t, conn)
}

func TestRuntimeShutdownCancelsActiveStreamContext(t *testing.T) {
	cfg := Config{ShutdownTimeout: time.Second}.WithDefaults()
	r := newIngressRuntime(t, cfg)
	started := make(chan struct{})
	released := make(chan struct{})
	listener := serveIngressFixture(t, r, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
		close(released)
	}))
	requestDone := make(chan error, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String() + "/stream")
		if response != nil {
			response.Body.Close()
		}
		requestDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("stream handler did not start")
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatalf("runtime close: %v", err)
	}
	select {
	case <-released:
	default:
		t.Fatal("active stream context was not canceled before shutdown returned")
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("stream client did not unblock after shutdown")
	}
}
