package apicontracts

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	domaincontracts "github.com/cartethyia/daemon/internal/protocol"
)

func TestRequestMetadataJSONRoundTrip(t *testing.T) {
	in := RequestMetadata{
		RequestID:      "req-1",
		TraceID:        "trace-1",
		Origin:         "cli",
		ClientFamily:   "openai",
		AccountID:      "acct-1",
		AccountEmail:   "a@example.com",
		AccountName:    "alpha",
		AccountDisplay: "a@example.com",
		ProxyID:        "proxy-1",
		ProxyName:      "edge",
		ProxyDisplay:   "edge",
		ProxySource:    "configured",
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out RequestMetadata
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: got %#v want %#v", out, in)
	}
}

func TestRequestMetadataValidate(t *testing.T) {
	t.Run("ok", func(t *testing.T) {
		meta := RequestMetadata{
			RequestID:    "req_1",
			TraceID:      "trace.1",
			Origin:       "cli",
			ClientFamily: "openai",
			ProxySource:  "direct",
		}
		if err := meta.Validate(); err != nil {
			t.Fatalf("Validate() = %v", err)
		}
	})
	t.Run("empty ok", func(t *testing.T) {
		if err := (RequestMetadata{}).Validate(); err != nil {
			t.Fatalf("empty Validate() = %v", err)
		}
	})
	t.Run("field too long", func(t *testing.T) {
		meta := RequestMetadata{Origin: strings.Repeat("x", MaxOriginBytes+1)}
		if err := meta.Validate(); err == nil {
			t.Fatal("expected length error")
		}
	})
	t.Run("invalid proxy_source", func(t *testing.T) {
		meta := RequestMetadata{ProxySource: "socks5"}
		if err := meta.Validate(); err == nil || !strings.Contains(err.Error(), "proxy_source") {
			t.Fatalf("Validate() = %v, want proxy_source error", err)
		}
	})
	t.Run("allowed proxy sources", func(t *testing.T) {
		for _, source := range []string{"configured", "direct", "none", "unknown"} {
			meta := RequestMetadata{ProxySource: source}
			if err := meta.Validate(); err != nil {
				t.Fatalf("source %q: %v", source, err)
			}
		}
	})
}

func TestValidateMetadataValue(t *testing.T) {
	if err := ValidateMetadataValue("x", "ok", 8); err != nil {
		t.Fatalf("valid: %v", err)
	}
	if err := ValidateMetadataValue("x", strings.Repeat("a", 9), 8); err == nil {
		t.Fatal("expected length error")
	}
	if err := ValidateMetadataValue("x", "bad\nvalue", 32); err == nil {
		t.Fatal("expected control-character error")
	}
	if err := ValidateMetadataValue("x", "has Bearer token", 64); err == nil {
		t.Fatal("expected sensitive-material error")
	}
	if err := ValidateMetadataValue("x", "api_key=secret", 64); err == nil {
		t.Fatal("expected sensitive-material error")
	}
}

func TestValidateRequestID(t *testing.T) {
	if err := ValidateRequestID("request_id", "abc-DEF_01.:"); err != nil {
		t.Fatalf("valid id: %v", err)
	}
	if err := ValidateRequestID("request_id", ""); err == nil {
		t.Fatal("expected required error")
	}
	if err := ValidateRequestID("request_id", strings.Repeat("a", MaxRequestIDBytes+1)); err == nil {
		t.Fatal("expected length error")
	}
	if err := ValidateRequestID("request_id", "bad id"); err == nil {
		t.Fatal("expected invalid character error")
	}
	if err := ValidateRequestID("request_id", "bad/id"); err == nil {
		t.Fatal("expected invalid character error")
	}
}

func TestAccountDisplay(t *testing.T) {
	if got := AccountDisplay("a@x.com", "name", "id"); got != "a@x.com" {
		t.Fatalf("got %q, want email", got)
	}
	if got := AccountDisplay("", "name", "id"); got != "name" {
		t.Fatalf("got %q, want name", got)
	}
	if got := AccountDisplay("", "", "id"); got != "id" {
		t.Fatalf("got %q, want id", got)
	}
	if got := AccountDisplay("", "", ""); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
	if got := AccountDisplay("authorization=secret", "safe-name", "id"); got != "safe-name" {
		t.Fatalf("got %q, want safe-name after rejecting sensitive email", got)
	}
}

func TestProxyDisplay(t *testing.T) {
	if got := ProxyDisplay("edge", "proxy-1"); got != "edge" {
		t.Fatalf("got %q, want name", got)
	}
	if got := ProxyDisplay("", "proxy-1"); got != "proxy-1" {
		t.Fatalf("got %q, want id", got)
	}
	if got := ProxyDisplay("", ""); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
	if got := ProxyDisplay("bearer xyz", "proxy-1"); got != "proxy-1" {
		t.Fatalf("got %q, want id after rejecting sensitive name", got)
	}
}

func TestConstants(t *testing.T) {
	if MaxBodyBytes != 10*1024*1024 {
		t.Fatalf("MaxBodyBytes=%d", MaxBodyBytes)
	}
	if MaxRequestIDBytes != 96 || MaxTraceIDBytes != 96 || MaxOriginBytes != 32 {
		t.Fatalf("unexpected metadata bounds")
	}
}

type stubStream struct {
	status int
	ctype  string
	body   stubReader
	hdr    http.Header
}

func (s stubStream) StatusCode() int          { return s.status }
func (s stubStream) ContentType() string      { return s.ctype }
func (s stubStream) Body() StreamReader       { return s.body }
func (s stubStream) Headers() http.Header     { return s.hdr }

type stubReader struct{}

func (stubReader) Read([]byte) (int, error) { return 0, errors.New("eof") }
func (stubReader) Close() error             { return nil }

type stubProxy struct {
	gotCtx context.Context
	gotReq *domaincontracts.Request
	stream Stream
	err    error
}

func (p *stubProxy) DispatchContext(ctx context.Context, req *domaincontracts.Request) (Stream, error) {
	p.gotCtx = ctx
	p.gotReq = req
	return p.stream, p.err
}

type stubCatalog struct {
	accounts []domaincontracts.Account
	err      error
}

func (c stubCatalog) List() ([]domaincontracts.Account, error) {
	return c.accounts, c.err
}

type testCtxKey struct{}

func TestDispatchContext(t *testing.T) {
	want := stubStream{
		status: http.StatusOK,
		ctype:  "application/json",
		hdr:    http.Header{"X-Test": []string{"1"}},
	}
	proxy := &stubProxy{stream: want}
	ctx := context.WithValue(context.Background(), testCtxKey{}, "marker")
	req := &domaincontracts.Request{Model: "gpt-test", Stream: true}

	got, err := DispatchContext(ctx, proxy, req)
	if err != nil {
		t.Fatalf("DispatchContext: %v", err)
	}
	if proxy.gotCtx != ctx || proxy.gotReq != req {
		t.Fatal("DispatchContext did not forward context/request")
	}
	if got.StatusCode() != http.StatusOK || got.ContentType() != "application/json" {
		t.Fatalf("stream fields mismatch: %#v", got)
	}
	if got.Headers().Get("X-Test") != "1" {
		t.Fatalf("headers=%v", got.Headers())
	}
	body := got.Body()
	if _, err := body.Read(nil); err == nil {
		t.Fatal("expected body read error")
	}
	if err := body.Close(); err != nil {
		t.Fatalf("body close: %v", err)
	}

	proxy.err = errors.New("boom")
	proxy.stream = nil
	if _, err := DispatchContext(ctx, proxy, req); err == nil {
		t.Fatal("expected dispatch error")
	}
}

func TestModelCatalogContract(t *testing.T) {
	catalog := stubCatalog{
		accounts: []domaincontracts.Account{{ID: "a1", Provider: "openai", Model: "gpt"}},
	}
	got, err := catalog.List()
	if err != nil || len(got) != 1 || got[0].ID != "a1" {
		t.Fatalf("List() = %#v, %v", got, err)
	}
	failing := stubCatalog{err: errors.New("unavailable")}
	if _, err := failing.List(); err == nil {
		t.Fatal("expected catalog error")
	}
}
