package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type catalogTestService struct {
	providerErr error
	modelErr    error
}

func (s catalogTestService) Providers(context.Context) ([]CatalogProvider, error) {
	if s.providerErr != nil {
		return nil, s.providerErr
	}
	return []CatalogProvider{{
		ID:              " openai ",
		DisplayName:     " OpenAI ",
		Protocol:        "openai",
		Protocols:       []string{"openai", "anthropic"},
		CredentialKind:  "api_key",
		CredentialKinds: []string{"api_key", "oauth", "not-a-credential"},
		Enabled:         true,
		Configured:      true,
		AccountCount:    2,
		ModelCount:      1,
		Generation:      7,
		AuthScope:       "admin:catalog",
		Models: []CatalogModel{{
			ID: "gpt-test", ProviderID: "openai", DisplayName: "GPT Test", Enabled: true,
			Capabilities: map[string]bool{"chat": true, "credential": true, "tools": true}, Generation: 7,
		}},
	}}, nil
}

func (s catalogTestService) Models(context.Context, string) ([]CatalogModel, error) {
	if s.modelErr != nil {
		return nil, s.modelErr
	}
	return []CatalogModel{{
		ID: "gpt-test", ProviderID: "openai", DisplayName: "GPT Test", Enabled: true,
		Capabilities: map[string]bool{"chat": true, "credential": true}, Generation: 7,
	}}, nil
}

func TestCatalogRoutesReturnRedactedEnvelopeData(t *testing.T) {
	mux := http.NewServeMux()
	RegisterCatalog(mux, Services{Catalog: catalogTestService{}})

	req := httptest.NewRequest(http.MethodGet, CatalogProvidersPath, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data struct {
			Items []CatalogProvider `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if len(envelope.Data.Items) != 1 {
		t.Fatalf("items=%d want 1", len(envelope.Data.Items))
	}
	provider := envelope.Data.Items[0]
	if provider.ID != "openai" || provider.DisplayName != "OpenAI" || provider.Generation != 7 {
		t.Fatalf("provider=%+v", provider)
	}
	if len(provider.CredentialKinds) != 2 || provider.CredentialKind != "api_key" {
		t.Fatalf("credential kinds were not bounded: %+v", provider.CredentialKinds)
	}
	if _, ok := provider.Models[0].Capabilities["credential"]; ok {
		t.Fatal("unknown capability leaked")
	}

	req = httptest.NewRequest(http.MethodGet, CatalogModelsPath+"?provider=openai", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"providerId":"openai"`) {
		t.Fatalf("models response status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCatalogRoutesUnavailableWithoutService(t *testing.T) {
	mux := http.NewServeMux()
	RegisterCatalog(mux, Services{})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, CatalogProvidersPath, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != string(CodeUnavailable) {
		t.Fatalf("error code=%q want %q", envelope.Error.Code, CodeUnavailable)
	}
}

func TestCatalogRoutesMapDependencyErrorsToStableUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterCatalog(mux, Services{Catalog: catalogTestService{providerErr: errors.New("provider token leaked")}})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, CatalogProvidersPath, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "provider token leaked") {
		t.Fatal("dependency error crossed operator boundary")
	}
}

func TestCatalogRoutesRequireCatalogScope(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{Catalog: catalogTestService{}, Authorizer: catalogAuthorizer{scope: ScopeUsage}})
	req := httptest.NewRequest(http.MethodGet, CatalogProvidersPath, nil)
	req.Header.Set("X-Session-Id", "session")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

type catalogAuthorizer struct{ scope AdminScope }

func (a catalogAuthorizer) Authorize(_ context.Context, sessionID string, scope AdminScope) (AdminActor, error) {
	if sessionID == "" {
		return AdminActor{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	if scope != a.scope {
		return AdminActor{}, NewError(CodeAdminForbidden, "admin scope denied")
	}
	return AdminActor{ID: "operator"}, nil
}

func TestCatalogModelsRejectOversizedProviderFilter(t *testing.T) {
	mux := http.NewServeMux()
	RegisterCatalog(mux, Services{Catalog: catalogTestService{}})
	rec := httptest.NewRecorder()
	path := CatalogModelsPath + "?provider=" + strings.Repeat("x", maxCatalogProviderID+1)
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
