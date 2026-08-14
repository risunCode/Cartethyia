package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type oauthRouteAuth struct {
	statusCalls  int
	reauthCalls  int
	refreshInput OAuthRefreshInput
}

func (a *oauthRouteAuth) Login(context.Context, LoginInput, AuthRequest) (LoginResult, error) {
	return LoginResult{}, nil
}
func (a *oauthRouteAuth) Logout(context.Context, string) error { return nil }
func (a *oauthRouteAuth) Current(context.Context, string) (Session, error) { return Session{}, nil }
func (a *oauthRouteAuth) Refresh(context.Context, string) (Session, error) { return Session{}, nil }
func (a *oauthRouteAuth) OAuthStart(context.Context, string, OAuthStartInput) (OAuthState, error) {
	return OAuthState{SessionID: "opaque-session", Status: "pending", URL: "https://example.test/authorize", State: "csrf-state"}, nil
}
func (a *oauthRouteAuth) OAuthComplete(context.Context, string, OAuthCompleteInput) (OAuthState, error) {
	return OAuthState{Status: "completed"}, nil
}
func (a *oauthRouteAuth) OAuthCancel(context.Context, string) error { return nil }
func (a *oauthRouteAuth) OAuthRefresh(_ context.Context, input OAuthRefreshInput) (OAuthState, error) {
	a.refreshInput = input
	return OAuthState{AccountID: input.AccountID, Status: "refreshed"}, nil
}
func (a *oauthRouteAuth) OAuthStatus(context.Context, string) (OAuthState, error) {
	a.statusCalls++
	return OAuthState{SessionID: "opaque-session", Status: "pending", UserCode: "user-code", VerificationURI: "https://example.test/device"}, nil
}
func (a *oauthRouteAuth) OAuthReauthenticate(_ context.Context, input OAuthRefreshInput) (OAuthState, error) {
	a.reauthCalls++
	a.refreshInput = input
	return OAuthState{AccountID: input.AccountID, Status: "reauthentication-required"}, nil
}

func TestOAuthStatusAndReauthRoutesUseBoundedMetadata(t *testing.T) {
	auth := &oauthRouteAuth{}
	mux := http.NewServeMux()
	RegisterAuth(mux, Services{Auth: auth})

	statusReq := httptest.NewRequest(http.MethodGet, "/v2/admin/auth/oauth/sessions/opaque-session/status", nil)
	statusRec := httptest.NewRecorder()
	mux.ServeHTTP(statusRec, statusReq)
	if statusRec.Code != http.StatusOK || auth.statusCalls != 1 {
		t.Fatalf("status code=%d calls=%d body=%s", statusRec.Code, auth.statusCalls, statusRec.Body.String())
	}
	body := statusRec.Body.String()
	if strings.Contains(body, "refreshToken") || strings.Contains(body, "accessToken") {
		t.Fatalf("OAuth status leaked token material: %s", body)
	}

	reauthReq := httptest.NewRequest(http.MethodPost, "/v2/admin/auth/oauth/reauth", strings.NewReader(`{"accountId":"account-1","force":false}`))
	reauthRec := httptest.NewRecorder()
	mux.ServeHTTP(reauthRec, reauthReq)
	if reauthRec.Code != http.StatusOK || auth.reauthCalls != 1 {
		t.Fatalf("reauth code=%d calls=%d body=%s", reauthRec.Code, auth.reauthCalls, reauthRec.Body.String())
	}
	if !auth.refreshInput.Force {
		t.Fatal("reauth input was not forced")
	}
}
