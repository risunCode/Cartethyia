package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	router "github.com/cartethyia/daemon/internal/router"
)

type authResolverStub struct {
	key PublicAPIKey
	err error
}

func (s authResolverStub) ResolveAPIKey(context.Context, string) (PublicAPIKey, error) {
	return s.key, s.err
}

type authAuthorityStub struct{}

func (*authAuthorityStub) Reserve(context.Context, router.ReservationRequest) (router.TokenReservation, error) {
	return nil, nil
}

func authProbe() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}

func TestPublicV1AuthDevelopmentFallbackAndProductionFailClosed(t *testing.T) {
	dev := PublicV1Auth(nil, nil, false)(authProbe())
	devResponse := httptest.NewRecorder()
	dev.ServeHTTP(devResponse, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if devResponse.Code != http.StatusNoContent {
		t.Fatalf("development fallback status = %d", devResponse.Code)
	}

	prod := PublicV1Auth(nil, nil, true)(authProbe())
	prodResponse := httptest.NewRecorder()
	prod.ServeHTTP(prodResponse, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if prodResponse.Code != http.StatusUnauthorized {
		t.Fatalf("production missing credential status = %d", prodResponse.Code)
	}
}

func TestPublicV1AuthAcceptsBearerAndAPIKeyRejectsConflictAndACL(t *testing.T) {
	resolver := authResolverStub{key: PublicAPIKey{ID: "key-1", Active: true, ProviderAllowlist: "openai", ModelAllowlist: "openai/gpt-5"}}
	handler := PublicV1Auth(resolver, nil, true)(authProbe())
	for name, pair := range map[string][2]string{
		"bearer":  [2]string{"Authorization", "Bearer bearer-secret"},
		"api key": [2]string{"X-API-Key", "x-api-secret"},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-5"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(pair[0], pair[1])
			req.Header.Set("X-Cartethyia-Provider", "anthropic")
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

	denied := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"anthropic/gpt-5"}`))
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
			handler := PublicV1Auth(authResolverStub{key: key}, nil, true)(authProbe())
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
	}}, nil, true)(authProbe())
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
	}}, nil, true)(authProbe())
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

func TestPublicV1AuthConcurrentRPMUsesResolvedKeyIdentity(t *testing.T) {
	handler := PublicV1Auth(authResolverStub{key: PublicAPIKey{
		ID:           "same-resolved-key",
		Active:       true,
		RateLimitRpm: ptrInt(1),
	}}, nil, true)(authProbe())

	start := make(chan struct{})
	statuses := make(chan int, 2)
	var callers sync.WaitGroup
	for _, credential := range []struct{ name, value string }{
		{name: "Authorization", value: "Bearer first-presentation"},
		{name: "X-API-Key", value: "second-presentation"},
	} {
		callers.Add(1)
		go func(name, value string) {
			defer callers.Done()
			<-start
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-4o"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set(name, value)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			statuses <- response.Code
		}(credential.name, credential.value)
	}
	close(start)
	callers.Wait()
	close(statuses)

	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusNoContent] != 1 || counts[http.StatusTooManyRequests] != 1 {
		t.Fatalf("status counts=%v, want one admitted and one rate limited", counts)
	}
}

func TestPublicV1AuthConcurrencyCoversCompleteStreamHandlerAcrossCredentialPresentations(t *testing.T) {
	entered := make(chan struct{})
	finish := make(chan struct{})
	var first sync.Once
	handler := PublicV1Auth(authResolverStub{key: PublicAPIKey{
		ID:            "same-resolved-key",
		Active:        true,
		MaxConcurrent: ptrInt(1),
	}}, nil, true)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		block := false
		first.Do(func() { block = true })
		if block {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("data: ready\n\n"))
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			close(entered)
			<-finish
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	firstStatus := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		req.Header.Set("Authorization", "Bearer first-presentation")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		firstStatus <- response.Code
	}()
	<-entered

	second := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	second.Header.Set("X-API-Key", "second-presentation")
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, second)
	close(finish)
	if status := <-firstStatus; status != http.StatusOK {
		t.Fatalf("stream status=%d, want 200", status)
	}
	if secondResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("concurrent status=%d, want 429", secondResponse.Code)
	}
	third := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	third.Header.Set("X-API-Key", "third-presentation")
	thirdResponse := httptest.NewRecorder()
	handler.ServeHTTP(thirdResponse, third)
	if thirdResponse.Code != http.StatusNoContent {
		t.Fatalf("status after release=%d, want 204", thirdResponse.Code)
	}
}

func TestPublicV1AuthRejectsExhaustedOneTimeKeysBeforeDispatch(t *testing.T) {
	const (
		credentialSentinel = "credential-SENTINEL-one-time"
		promptSentinel     = "prompt-SENTINEL-one-time"
	)
	for _, test := range []struct {
		name  string
		limit int
		used  int
	}{
		{name: "used equals limit", limit: 7, used: 7},
		{name: "used exceeds limit", limit: 7, used: 8},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := authResolverStub{key: PublicAPIKey{
				ID:                "one-time-key",
				Active:            true,
				OneTimeTokenLimit: ptrInt(test.limit),
				OneTimeTokensUsed: test.used,
			}}
			dispatchCalls := 0
			handler := PublicV1Auth(resolver, nil, true)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				dispatchCalls++
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-4o","messages":[{"role":"user","content":"`+promptSentinel+`"}]}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+credentialSentinel)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, req)

			if response.Code != http.StatusTooManyRequests {
				t.Fatalf("status=%d body=%s, want 429", response.Code, response.Body.String())
			}
			if dispatchCalls != 0 {
				t.Fatalf("dispatch calls=%d, want 0", dispatchCalls)
			}
			if body := response.Body.String(); strings.Contains(body, credentialSentinel) || strings.Contains(body, promptSentinel) {
				t.Fatalf("client error leaked sentinel: %q", body)
			}
		})
	}
}

func TestPublicV1AuthRejectsConfiguredHardTokenLimitsWithoutAuthority(t *testing.T) {
	const (
		credentialSentinel = "credential-SENTINEL-window-limit"
		promptSentinel     = "prompt-SENTINEL-window-limit"
	)
	for _, test := range []struct {
		name string
		key  PublicAPIKey
	}{
		{
			name: "daily",
			key:  PublicAPIKey{ID: "daily-key", Active: true, DailyTokenLimit: ptrInt(1)},
		},
		{
			name: "monthly",
			key:  PublicAPIKey{ID: "monthly-key", Active: true, MonthlyTokenLimit: ptrInt(1)},
		},
		{
			name: "one-time",
			key:  PublicAPIKey{ID: "one-time-key", Active: true, OneTimeTokenLimit: ptrInt(1)},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			dispatchCalls := 0
			handler := PublicV1Auth(authResolverStub{key: test.key}, nil, true)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				dispatchCalls++
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-4o","messages":[{"role":"user","content":"`+promptSentinel+`"}]}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-API-Key", credentialSentinel)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, req)

			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s, want fail-closed 503", response.Code, response.Body.String())
			}
			if dispatchCalls != 0 {
				t.Fatalf("dispatch calls=%d, want 0", dispatchCalls)
			}
			if body := response.Body.String(); strings.Contains(body, credentialSentinel) || strings.Contains(body, promptSentinel) {
				t.Fatalf("client error leaked sentinel: %q", body)
			}
		})
	}
}

func TestPublicV1AuthTransfersOnlyDurableQuotaAuthorityAndRedactedIdentity(t *testing.T) {
	authority := &authAuthorityStub{}
	handler := RequestID(PublicV1Auth(authResolverStub{key: PublicAPIKey{
		ID:              "redacted-key-id",
		Active:          true,
		DailyTokenLimit: ptrInt(100),
	}}, authority, true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthority, identity, ok := router.AuthorityFromContext(r.Context())
		if !ok {
			t.Fatal("durable quota authority missing from request context")
		}
		if gotAuthority != authority {
			t.Fatal("request context contains a different quota authority")
		}
		if identity.KeyID != "redacted-key-id" || identity.RequestID == "" || identity.WindowUTC.Location() != time.UTC {
			t.Fatalf("quota identity=%+v", identity)
		}
		if keyID := PublicAPIKeyIDFrom(r.Context()); keyID != "redacted-key-id" {
			t.Fatalf("public key identity=%q", keyID)
		}
		w.WriteHeader(http.StatusNoContent)
	})))
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer credential-must-not-be-context-identity")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, req)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
