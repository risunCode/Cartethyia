package models

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type fixtureCatalog struct {
	accounts []contracts.Account
	err      error
}

func (c fixtureCatalog) List() ([]contracts.Account, error) {
	return append([]contracts.Account(nil), c.accounts...), c.err
}

func TestModelsSuccessSchemaUnchanged(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Deps{Catalog: fixtureCatalog{accounts: []contracts.Account{
		{ID: "gpt-test", Provider: "openai", Enabled: true},
		{ID: "disabled-test", Provider: "anthropic", Enabled: false},
	}}})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	const want = `{"object":"list","data":[{"id":"gpt-test","object":"model","owned_by":"openai"}]}` + "\n"
	if got := recorder.Body.String(); got != want {
		t.Fatalf("body=%q want successful models schema %q", got, want)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type=%q want JSON", got)
	}
}
