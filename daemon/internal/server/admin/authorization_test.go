package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testAuthorizer struct {
	scope AdminScope
}

func (a testAuthorizer) Authorize(_ context.Context, sessionID string, scope AdminScope) (AdminActor, error) {
	if sessionID == "" {
		return AdminActor{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	if scope != a.scope {
		return AdminActor{}, NewError(CodeAdminForbidden, "admin scope denied")
	}
	return AdminActor{ID: "operator-1"}, nil
}

type testDashboard struct{}

func (testDashboard) Summary(context.Context) (DashboardSummary, error) {
	return DashboardSummary{Version: "test"}, nil
}

type testAudit struct{ events []AuditEvent }

func (a *testAudit) Emit(_ context.Context, event AuditEvent) error {
	a.events = append(a.events, event)
	return nil
}

type testSettings struct{}

func (testSettings) Get(context.Context) (RuntimeSettings, error) { return RuntimeSettings{}, nil }
func (testSettings) Patch(context.Context, RuntimeSettingsInput) (RuntimeSettings, error) {
	return RuntimeSettings{LogLevel: "info"}, nil
}
func (testSettings) Reset(context.Context) (RuntimeSettings, error) { return RuntimeSettings{}, nil }

type testGeneration struct{ scopes []string }

func (g *testGeneration) Publish(_ context.Context, scope string) error {
	g.scopes = append(g.scopes, scope)
	return nil
}

func TestRegisterRequiresScopedAdminAuthorization(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, Services{Dashboard: testDashboard{}, Authorizer: testAuthorizer{scope: ScopeHealth}})

	without := httptest.NewRecorder()
	mux.ServeHTTP(without, httptest.NewRequest(http.MethodGet, "/console/dashboard", nil))
	if without.Code != http.StatusUnauthorized {
		t.Fatalf("without credentials status=%d", without.Code)
	}

	wrong := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/console/dashboard", nil)
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session"})
	mux.ServeHTTP(wrong, req)
	if wrong.Code != http.StatusOK {
		t.Fatalf("health scope status=%d body=%s", wrong.Code, wrong.Body.String())
	}
}

func TestAdminMutationPublishesGenerationAndAuditsAfterSuccess(t *testing.T) {
	audit := &testAudit{}
	generation := &testGeneration{}
	mux := http.NewServeMux()
	Register(mux, Services{Settings: testSettings{}, Authorizer: testAuthorizer{scope: ScopeConfig}, Audit: audit, Generation: generation})

	req := httptest.NewRequest(http.MethodPatch, "/console/settings", strings.NewReader(`{"logLevel":"info"}`))
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "session"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(generation.scopes) != 1 || generation.scopes[0] != "configuration" {
		t.Fatalf("generation=%v", generation.scopes)
	}
	if len(audit.events) != 1 || audit.events[0].Actor != "operator-1" || audit.events[0].Result != "success" {
		t.Fatalf("audit=%v", audit.events)
	}
}
