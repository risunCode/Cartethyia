package api

import (
	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type validationSettings struct{ patches int }

func (s *validationSettings) Get(context.Context) (consolecontracts.RuntimeSettings, error) {
	return consolecontracts.RuntimeSettings{}, nil
}
func (s *validationSettings) Patch(context.Context, consolecontracts.RuntimeSettingsInput) (consolecontracts.RuntimeSettings, error) {
	s.patches++
	return consolecontracts.RuntimeSettings{}, nil
}
func (s *validationSettings) Reset(context.Context) (consolecontracts.RuntimeSettings, error) {
	return consolecontracts.RuntimeSettings{}, nil
}

func TestSettingsValidationRunsBeforeServiceMutation(t *testing.T) {
	settings := &validationSettings{}
	mux := http.NewServeMux()
	Register(mux, Services{Settings: settings, Authorizer: testAuthorizer{scope: ScopeConfig}})
	req := httptest.NewRequest(http.MethodPatch, "/console/settings", strings.NewReader(`{"logLevel":"verbose"}`))
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if settings.patches != 0 {
		t.Fatalf("service mutation called %d times", settings.patches)
	}
}
