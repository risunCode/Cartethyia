package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type authResolverStub struct {
	key PublicAPIKey
	err error
}

func (s authResolverStub) ResolveAPIKey(context.Context, string) (PublicAPIKey, error) {
	return s.key, s.err
}

func authProbe() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}

func TestPublicV1AuthDevelopmentFallbackAndProductionFailClosed(t *testing.T) {
	dev := PublicV1Auth(nil, false)(authProbe())
	devResponse := httptest.NewRecorder()
	dev.ServeHTTP(devResponse, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if devResponse.Code != http.StatusNoContent {
		t.Fatalf("development fallback status = %d", devResponse.Code)
	}

	prod := PublicV1Auth(nil, true)(authProbe())
	prodResponse := httptest.NewRecorder()
	prod.ServeHTTP(prodResponse, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if prodResponse.Code != http.StatusUnauthorized {
		t.Fatalf("production missing credential status = %d", prodResponse.Code)
	}
}

func TestPublicV1AuthAcceptsBearerAndAPIKeyRejectsConflictAndACL(t *testing.T) {
	resolver := authResolverStub{key: PublicAPIKey{ID: "key-1", Active: true, ProviderAllowlist: "openai", ModelAllowlist: "gpt-5"}}
	handler := PublicV1Auth(resolver, true)(authProbe())
	for name, pair := range map[string][2]string{
		"bearer":  [2]string{"Authorization", "Bearer bearer-secret"},
		"api key": [2]string{"X-API-Key", "x-api-secret"},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-5"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(pair[0], pair[1])
			req.Header.Set("X-Cartethyia-Provider", "openai")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
			}
		})
	}

	conflict := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	conflict.Header.Set("Authorization", "Bearer one")
	conflict.Header.Set("X-API-Key", "two")
	conflictResponse := httptest.NewRecorder()
	handler.ServeHTTP(conflictResponse, conflict)
	if conflictResponse.Code != http.StatusUnauthorized {
		t.Fatalf("conflict status = %d", conflictResponse.Code)
	}

	denied := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"gpt-4"}`))
	denied.Header.Set("Content-Type", "application/json")
	denied.Header.Set("Authorization", "Bearer one")
	denied.Header.Set("X-Cartethyia-Provider", "openai")
	deniedResponse := httptest.NewRecorder()
	handler.ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Fatalf("ACL denied status = %d", deniedResponse.Code)
	}
}

func TestPublicV1AuthRejectsInactiveAndRevokedKeys(t *testing.T) {
	for name, key := range map[string]PublicAPIKey{
		"inactive": {ID: "key", Active: false},
		"revoked":  {ID: "key", Active: true, RevokedAt: ptrTime()},
	} {
		t.Run(name, func(t *testing.T) {
			handler := PublicV1Auth(authResolverStub{key: key}, true)(authProbe())
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			req.Header.Set("X-API-Key", "secret")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d", response.Code)
			}
		})
	}
}

func ptrTime() *time.Time {
	now := time.Now()
	return &now
}

func ptrInt(value int) *int { return &value }

func TestPublicV1AuthAppliesACLToTokenCount(t *testing.T) {
	handler := PublicV1Auth(authResolverStub{key: PublicAPIKey{
		ID:                "key-1",
		Active:            true,
		ProviderAllowlist: "anthropic",
	}}, true)(authProbe())
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(`{"model":"openai/gpt-4o","messages":[]}`))
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusForbidden {
		t.Fatalf("token-count ACL status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestPublicV1AuthEnforcesRateLimit(t *testing.T) {
	handler := PublicV1Auth(authResolverStub{key: PublicAPIKey{
		ID:           "key-rate",
		Active:       true,
		RateLimitRpm: ptrInt(1),
	}}, true)(authProbe())
	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-4o"}`))
		req.Header.Set("X-API-Key", "secret")
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		want := http.StatusNoContent
		if attempt == 1 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("attempt %d status = %d, want %d", attempt, response.Code, want)
		}
	}
}
