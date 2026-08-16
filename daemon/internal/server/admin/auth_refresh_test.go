package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// rotatingAuth is an AuthService whose Refresh re-issues the session with a
// fresh cookie, mirroring the production session service contract.
type rotatingAuth struct{}

func (rotatingAuth) Login(_ context.Context, _ LoginInput, _ AuthRequest) (LoginResult, error) {
	return LoginResult{
		Session:   Session{ID: "jti-1", User: "admin", Scopes: []string{"admin:*"}},
		SetCookie: "cartethyia_session=token-1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
		MaxAge:    86400,
	}, nil
}
func (rotatingAuth) Logout(context.Context, string) error { return nil }
func (rotatingAuth) Current(_ context.Context, sessionID string) (Session, error) {
	return Session{ID: sessionID, User: "admin", Scopes: []string{"admin:*"}}, nil
}
func (rotatingAuth) Refresh(_ context.Context, sessionID string, _ AuthRequest) (LoginResult, error) {
	if sessionID == "" {
		return LoginResult{}, NewError(CodeAdminAuthentication, "authentication required")
	}
	return LoginResult{
		Session:   Session{ID: "jti-2", User: "admin", Scopes: []string{"admin:*"}},
		SetCookie: "cartethyia_session=token-2; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
		MaxAge:    86400,
	}, nil
}
func (rotatingAuth) OAuthStart(context.Context, string, OAuthStartInput) (OAuthState, error) {
	return OAuthState{}, nil
}
func (rotatingAuth) OAuthComplete(context.Context, string, OAuthCompleteInput) (OAuthState, error) {
	return OAuthState{}, nil
}
func (rotatingAuth) OAuthCancel(context.Context, string) error { return nil }
func (rotatingAuth) OAuthRefresh(context.Context, OAuthRefreshInput) (OAuthState, error) {
	return OAuthState{}, nil
}

func TestRefreshRouteIssuesRotatedCookie(t *testing.T) {
	mux := http.NewServeMux()
	RegisterAuth(mux, Services{Auth: rotatingAuth{}})

	req := httptest.NewRequest(http.MethodPost, "/console/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: "cartethyia_session", Value: "token-1"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "cartethyia_session=token-2") || !strings.Contains(setCookie, "HttpOnly") {
		t.Fatalf("refresh must re-issue the session cookie: %q", setCookie)
	}
	var body struct {
		Data Session `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body shape must match GET session: %v (%s)", err, rec.Body.String())
	}
	if body.Data.ID != "jti-2" || body.Data.User != "admin" {
		t.Fatalf("session body = %+v", body.Data)
	}
}

func TestRefreshRouteRejectsMissingSession(t *testing.T) {
	mux := http.NewServeMux()
	RegisterAuth(mux, Services{Auth: rotatingAuth{}})

	req := httptest.NewRequest(http.MethodPost, "/console/auth/refresh", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("failed refresh must not set a cookie: %q", rec.Header().Get("Set-Cookie"))
	}
}
