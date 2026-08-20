package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCountTokensReturnsDeterministicBoundedEstimate(t *testing.T) {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{})
	body := `{"model":"claude-sonnet-4","max_tokens":128,"messages":[{"role":"user","content":[{"type":"text","text":"hello 世界"}]}]}`
	request := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, MessagesPath+"/count_tokens", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(rec, r)
		return rec
	}
	first, second := request(), request()
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("statuses = %d, %d; want 200", first.Code, second.Code)
	}
	var a, b map[string]int
	if err := json.Unmarshal(first.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	if a["input_tokens"] <= 0 || a["input_tokens"] != b["input_tokens"] {
		t.Fatalf("estimates = %#v, %#v; want equal positive input_tokens", a, b)
	}
}

func TestCountTokensRejectsInvalidMethodAndBody(t *testing.T) {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{})
	method := httptest.NewRecorder()
	mux.ServeHTTP(method, httptest.NewRequest(http.MethodGet, MessagesPath+"/count_tokens", nil))
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method status = %d, want 405", method.Code)
	}
	invalid := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, MessagesPath+"/count_tokens", strings.NewReader(`{"messages":[]}`))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(invalid, r)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400", invalid.Code)
	}
}

func TestCountTokensStopsOnCanceledRequest(t *testing.T) {
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, MessagesPath+"/count_tokens", strings.NewReader(`{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hello"}]}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code == http.StatusOK {
		t.Fatalf("canceled request returned success: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "input_tokens") {
		t.Fatalf("canceled request continued to token estimation: %s", rec.Body.String())
	}
}
