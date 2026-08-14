package messages

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCountTokensReturnsDeterministicBoundedEstimate(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Deps{})
	body := `{"model":"claude-sonnet-4","max_tokens":128,"messages":[{"role":"user","content":[{"type":"text","text":"hello 世界"}]}]}`
	request := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, Path+"/count_tokens", strings.NewReader(body))
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
	Register(mux, Deps{})
	method := httptest.NewRecorder()
	mux.ServeHTTP(method, httptest.NewRequest(http.MethodGet, Path+"/count_tokens", nil))
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method status = %d, want 405", method.Code)
	}
	invalid := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, Path+"/count_tokens", strings.NewReader(`{"messages":[]}`))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(invalid, r)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400", invalid.Code)
	}
}
