package api

import (
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeProxyAdmin is an in-memory implementation of ProxyAdminService used to
// exercise the handler surface without touching the database. The fields let
// each test pre-program the next error so the handler's error path is covered
// deterministically.
type fakeProxyAdmin struct {
	list    []consolecontracts.ProxyRecord
	listErr error

	createErr   error
	updateErr   error
	deleteErr   error
	created     []consolecontracts.ProxyInput
	updated     map[string]consolecontracts.ProxyInput
	deleted     []string
	updateCalls int
	deleteCalls int
}

func (f *fakeProxyAdmin) List(context.Context) ([]consolecontracts.ProxyRecord, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	if f.list == nil {
		return []consolecontracts.ProxyRecord{}, nil
	}
	return append([]consolecontracts.ProxyRecord(nil), f.list...), nil
}

func (f *fakeProxyAdmin) Create(_ context.Context, input consolecontracts.ProxyInput) (consolecontracts.ProxyRecord, error) {
	if f.createErr != nil {
		return consolecontracts.ProxyRecord{}, f.createErr
	}
	f.created = append(f.created, input)
	return consolecontracts.ProxyRecord{
		ID:             "proxy-new",
		Type:           derefString(input.Type),
		Host:           derefString(input.Host),
		Port:           derefInt(input.Port),
		Priority:       derefInt(input.Priority),
		Weight:         derefInt(input.Weight),
		MaxConcurrency: derefInt(input.MaxConcurrency),
		Active:         derefBool(input.Active),
	}, nil
}

func (f *fakeProxyAdmin) Update(_ context.Context, id string, input consolecontracts.ProxyInput) (consolecontracts.ProxyRecord, error) {
	f.updateCalls++
	if f.updated == nil {
		f.updated = map[string]consolecontracts.ProxyInput{}
	}
	f.updated[id] = input
	if f.updateErr != nil {
		return consolecontracts.ProxyRecord{}, f.updateErr
	}
	return consolecontracts.ProxyRecord{ID: id, Host: derefString(input.Host), Port: derefInt(input.Port)}, nil
}

func (f *fakeProxyAdmin) Delete(_ context.Context, id string) error {
	f.deleteCalls++
	f.deleted = append(f.deleted, id)
	return f.deleteErr
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(i *int) int {
	if i == nil {
		return 0
	}
	return *i
}

func derefBool(b *bool) bool {
	if b == nil {
		return false
	}
	return *b
}

func newProxiesMux(svc ProxyAdminService) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterProxies(mux, Services{ProxyAdmin: svc})
	return mux
}

func TestProxyHandlersListReturnsEmptyArray(t *testing.T) {
	mux := newProxiesMux(&fakeProxyAdmin{list: nil})

	req := httptest.NewRequest(http.MethodGet, "/console/proxies", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data []consolecontracts.ProxyRecord `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v body=%s", err, rec.Body.String())
	}
	if envelope.Data == nil {
		t.Fatalf("expected empty array, got nil; body=%s", rec.Body.String())
	}
	if len(envelope.Data) != 0 {
		t.Fatalf("expected empty array, got %d entries", len(envelope.Data))
	}
}

func TestProxyHandlersListReturnsSeededEntries(t *testing.T) {
	svc := &fakeProxyAdmin{list: []consolecontracts.ProxyRecord{{ID: "p1", Host: "10.0.0.1", Port: 8080}}}
	mux := newProxiesMux(svc)

	req := httptest.NewRequest(http.MethodGet, "/console/proxies", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Data []consolecontracts.ProxyRecord `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v body=%s", err, rec.Body.String())
	}
	if len(envelope.Data) != 1 || envelope.Data[0].ID != "p1" {
		t.Fatalf("unexpected payload: %+v", envelope.Data)
	}
}

func TestProxyHandlersCreateValidInputReturns201(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	body := `{"type":"http","host":"proxy.example.test","port":8080,"priority":10,"weight":50,"max_concurrency":100,"active":true}`
	req := httptest.NewRequest(http.MethodPost, "/console/proxies", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(svc.created) != 1 {
		t.Fatalf("expected one Create call, got %d", len(svc.created))
	}
	if got := derefString(svc.created[0].Type); got != "http" {
		t.Fatalf("type=%q", got)
	}
}

func TestProxyHandlersCreateMissingTypeReturns400(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	body := `{"host":"proxy.example.test","port":8080}`
	req := httptest.NewRequest(http.MethodPost, "/console/proxies", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(svc.created) != 0 {
		t.Fatalf("Create should not be invoked when validation fails")
	}
}

func TestProxyHandlersCreateInvalidPortReturns400(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	body := `{"type":"http","host":"proxy.example.test","port":99999}`
	req := httptest.NewRequest(http.MethodPost, "/console/proxies", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyHandlersCreateInvalidTypeReturns400(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	body := `{"type":"telnet","host":"proxy.example.test","port":8080}`
	req := httptest.NewRequest(http.MethodPost, "/console/proxies", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyHandlersCreateMalformedJSONReturns400(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	req := httptest.NewRequest(http.MethodPost, "/console/proxies", strings.NewReader(`{not-json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyHandlersUpdateNonExistentReturnsProxyNotFound(t *testing.T) {
	svc := &fakeProxyAdmin{updateErr: sql.ErrNoRows}
	mux := newProxiesMux(svc)

	body := `{"host":"proxy.example.test"}`
	req := httptest.NewRequest(http.MethodPatch, "/console/proxies/missing", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), string(CodeProxyNotFound)) {
		t.Fatalf("expected proxy_not_found code, body=%s", rec.Body.String())
	}
}

func TestProxyHandlersUpdateValidInputReachesService(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	body := `{"host":"proxy.example.test","port":3128}`
	req := httptest.NewRequest(http.MethodPatch, "/console/proxies/p1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if svc.updateCalls != 1 {
		t.Fatalf("expected one Update call, got %d", svc.updateCalls)
	}
}

func TestProxyHandlersDeleteNonExistentReturnsProxyNotFound(t *testing.T) {
	svc := &fakeProxyAdmin{deleteErr: sql.ErrNoRows}
	mux := newProxiesMux(svc)

	req := httptest.NewRequest(http.MethodDelete, "/console/proxies/missing", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), string(CodeProxyNotFound)) {
		t.Fatalf("expected proxy_not_found code, body=%s", rec.Body.String())
	}
}

func TestProxyHandlersDeleteSuccessInvokesService(t *testing.T) {
	svc := &fakeProxyAdmin{}
	mux := newProxiesMux(svc)

	req := httptest.NewRequest(http.MethodDelete, "/console/proxies/p1", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if svc.deleteCalls != 1 || len(svc.deleted) != 1 || svc.deleted[0] != "p1" {
		t.Fatalf("delete not invoked correctly: calls=%d ids=%v", svc.deleteCalls, svc.deleted)
	}
}

func TestProxyHandlersUnsupportedMethodReturns405(t *testing.T) {
	mux := newProxiesMux(&fakeProxyAdmin{})

	req := httptest.NewRequest(http.MethodPut, "/console/proxies/p1", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), string(CodeMethodNotAllowed)) {
		t.Fatalf("expected method_not_allowed code, body=%s", rec.Body.String())
	}
}

func TestProxyHandlersUnsupportedMethodOnCollectionReturns405(t *testing.T) {
	mux := newProxiesMux(&fakeProxyAdmin{})

	req := httptest.NewRequest(http.MethodPut, "/console/proxies", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyHandlersSubresourceWithoutIDReturns404(t *testing.T) {
	mux := newProxiesMux(&fakeProxyAdmin{})

	req := httptest.NewRequest(http.MethodPatch, "/console/proxies/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyHandlersRegistrationSkippedWhenServiceNil(t *testing.T) {
	mux := http.NewServeMux()
	RegisterProxies(mux, Services{})

	req := httptest.NewRequest(http.MethodGet, "/console/proxies", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when service is nil, got %d", rec.Code)
	}
}
