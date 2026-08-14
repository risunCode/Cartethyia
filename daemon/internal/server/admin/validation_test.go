package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type validationSettings struct{ patches int }

func (s *validationSettings) Get(context.Context) (RuntimeSettings, error) {
	return RuntimeSettings{}, nil
}
func (s *validationSettings) Patch(context.Context, RuntimeSettingsInput) (RuntimeSettings, error) {
	s.patches++
	return RuntimeSettings{}, nil
}
func (s *validationSettings) Reset(context.Context) (RuntimeSettings, error) {
	return RuntimeSettings{}, nil
}

func TestSettingsValidationRunsBeforeServiceMutation(t *testing.T) {
	settings := &validationSettings{}
	mux := http.NewServeMux()
	Register(mux, Services{Settings: settings, Authorizer: testAuthorizer{scope: ScopeConfig}})
	req := httptest.NewRequest(http.MethodPatch, "/v2/admin/settings", strings.NewReader(`{"logLevel":"verbose"}`))
	req.Header.Set("X-Session-Id", "session")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if settings.patches != 0 {
		t.Fatalf("service mutation called %d times", settings.patches)
	}
}
