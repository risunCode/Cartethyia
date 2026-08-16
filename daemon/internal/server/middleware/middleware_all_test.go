package middleware

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testAPIKeyResolver struct {
	key      string
	identity Identity
	err      error
}

func (r *testAPIKeyResolver) LookupAPIKey(ctx context.Context, key string) (Identity, error) {
	if r.err != nil {
		return Identity{}, r.err
	}
	if key == r.key {
		return r.identity, nil
	}
	return Identity{}, errors.New("key not found")
}

type testLimiter struct {
	decision Decision
	err      error
}

func (l *testLimiter) Allow(key string) (Decision, error) {
	return l.decision, l.err
}

type testConcurrencyCap struct {
	releaseCalled bool
	err           error
}

func (c *testConcurrencyCap) Acquire(key string) (func(), error) {
	if c.err != nil {
		return nil, c.err
	}
	return func() { c.releaseCalled = true }, nil
}

type testBanList struct {
	banned bool
	err    error
}

func (b *testBanList) IsBanned(clientID string) (bool, error) {
	return b.banned, b.err
}

func TestMiddlewareChainAndMethods(t *testing.T) {
	called := false
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	mw1 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-MW1", "1")
			next.ServeHTTP(w, r)
		})
	}
	mw2 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-MW2", "2")
			next.ServeHTTP(w, r)
		})
	}

	chained := Chain(h, mw1, mw2)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	chained.ServeHTTP(rec, req)

	if !called || rec.Header().Get("X-MW1") != "1" || rec.Header().Get("X-MW2") != "2" {
		t.Fatalf("chained failed: called=%v headers=%+v", called, rec.Header())
	}

	// Methods allowed
	methodHandler := Methods(http.MethodGet, http.MethodPost)(h)
	recGet := httptest.NewRecorder()
	methodHandler.ServeHTTP(recGet, httptest.NewRequest(http.MethodGet, "/test", nil))
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET status = %d", recGet.Code)
	}

	// Methods disallowed
	recPut := httptest.NewRecorder()
	methodHandler.ServeHTTP(recPut, httptest.NewRequest(http.MethodPut, "/test", nil))
	if recPut.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT status = %d", recPut.Code)
	}
	if allow := recPut.Header().Get("Allow"); allow != "GET, POST" {
		t.Fatalf("Allow header = %q, want 'GET, POST'", allow)
	}
}

func TestMiddlewareLimitsAndDrain(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		w.Write(body)
	})

	limitMw := MaxBodyBytes(10)(h)

	// Within limit
	reqSmall := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("short"))
	recSmall := httptest.NewRecorder()
	limitMw.ServeHTTP(recSmall, reqSmall)
	if recSmall.Code != http.StatusOK {
		t.Fatalf("small body code = %d", recSmall.Code)
	}

	// Over limit by ContentLength
	reqLarge := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("this is way too long for ten bytes limit"))
	recLarge := httptest.NewRecorder()
	limitMw.ServeHTTP(recLarge, reqLarge)
	if recLarge.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large body code = %d", recLarge.Code)
	}

	// DrainAndDiscard
	reqToDrain := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("extra-bytes-to-drain"))
	DrainAndDiscard(reqToDrain)
}

func TestMiddlewareSecurityResponseHeaders(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	policy := SecurityHeaders{HTML: true, HTTPS: true, NoStore: true}
	mw := SecurityResponseHeaders(policy)(h)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, req)

	headers := rec.Header()
	if headers.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing X-Content-Type-Options")
	}
	if headers.Get("X-Frame-Options") != "DENY" {
		t.Fatal("missing X-Frame-Options")
	}
	if headers.Get("Cache-Control") != "no-store" {
		t.Fatal("missing Cache-Control: no-store")
	}
	if headers.Get("Strict-Transport-Security") == "" {
		t.Fatal("missing HSTS")
	}
}

func TestMiddlewareAuthAndIdentity(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := IdentityFrom(r.Context())
		if !ok {
			http.Error(w, "missing identity", http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Subject", id.Subject)
		w.WriteHeader(http.StatusOK)
	})

	resolver := &testAPIKeyResolver{
		key:      "secret-token",
		identity: Identity{Subject: "user-1", Kind: "user", Raw: "secret-token"},
	}
	authMw := Authenticate(resolver)(h)

	// Missing auth
	reqMissing := httptest.NewRequest(http.MethodGet, "/", nil)
	recMissing := httptest.NewRecorder()
	authMw.ServeHTTP(recMissing, reqMissing)
	if recMissing.Code != http.StatusUnauthorized {
		t.Fatalf("missing auth code = %d", recMissing.Code)
	}

	// Bearer token
	reqBearer := httptest.NewRequest(http.MethodGet, "/", nil)
	reqBearer.Header.Set("Authorization", "Bearer secret-token")
	recBearer := httptest.NewRecorder()
	authMw.ServeHTTP(recBearer, reqBearer)
	if recBearer.Code != http.StatusOK || recBearer.Header().Get("X-Subject") != "user-1" {
		t.Fatalf("bearer auth code = %d subject = %q", recBearer.Code, recBearer.Header().Get("X-Subject"))
	}

	// ApiKey scheme
	reqAPIKey := httptest.NewRequest(http.MethodGet, "/", nil)
	reqAPIKey.Header.Set("Authorization", "ApiKey secret-token")
	recAPIKey := httptest.NewRecorder()
	authMw.ServeHTTP(recAPIKey, reqAPIKey)
	if recAPIKey.Code != http.StatusOK {
		t.Fatalf("api key auth code = %d", recAPIKey.Code)
	}

	// Bad secret
	reqBad := httptest.NewRequest(http.MethodGet, "/", nil)
	reqBad.Header.Set("Authorization", "Bearer wrong-secret")
	recBad := httptest.NewRecorder()
	authMw.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusUnauthorized {
		t.Fatalf("bad auth code = %d", recBad.Code)
	}

	// ExtractCredentials helper
	creds, ok := ExtractCredentials(reqBearer)
	if !ok || creds.Token != "secret-token" || creds.Scheme != SchemeBearer {
		t.Fatalf("ExtractCredentials Bearer = %+v, ok=%v", creds, ok)
	}

	// WithIdentity context helper
	ctx := WithIdentity(context.Background(), Identity{Subject: "sub-99"})
	id, ok := IdentityFrom(ctx)
	if !ok || id.Subject != "sub-99" {
		t.Fatalf("IdentityFrom = %+v ok=%v", id, ok)
	}
}

func TestMiddlewareAdmissionAndConcurrency(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// RateLimit allow
	rateAllow := RateLimit(&testLimiter{decision: Decision{Allow: true}})(h)
	recAllow := httptest.NewRecorder()
	rateAllow.ServeHTTP(recAllow, httptest.NewRequest(http.MethodGet, "/", nil))
	if recAllow.Code != http.StatusOK {
		t.Fatalf("rate limit allow code = %d", recAllow.Code)
	}

	// RateLimit deny
	rateDeny := RateLimit(&testLimiter{decision: Decision{Allow: false, Reason: "too fast"}})(h)
	recDeny := httptest.NewRecorder()
	rateDeny.ServeHTTP(recDeny, httptest.NewRequest(http.MethodGet, "/", nil))
	if recDeny.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limit deny code = %d", recDeny.Code)
	}

	// Concurrency
	cap := &testConcurrencyCap{}
	concMw := Concurrency(cap)(h)
	recConc := httptest.NewRecorder()
	concMw.ServeHTTP(recConc, httptest.NewRequest(http.MethodGet, "/", nil))
	if recConc.Code != http.StatusOK || !cap.releaseCalled {
		t.Fatalf("concurrency code = %d released = %v", recConc.Code, cap.releaseCalled)
	}
}

func TestMiddlewareManualBan(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	banList := &testBanList{banned: false}
	banMw := ManualBan(banList, nil)(h)

	// Not banned
	recOK := httptest.NewRecorder()
	banMw.ServeHTTP(recOK, httptest.NewRequest(http.MethodGet, "/", nil))
	if recOK.Code != http.StatusOK {
		t.Fatalf("not banned code = %d", recOK.Code)
	}

	// Banned
	banList.banned = true
	recBanned := httptest.NewRecorder()
	banMw.ServeHTTP(recBanned, httptest.NewRequest(http.MethodGet, "/", nil))
	if recBanned.Code != http.StatusForbidden {
		t.Fatalf("banned code = %d", recBanned.Code)
	}
}

func TestMiddlewareContextHelpers(t *testing.T) {
	ctx := context.Background()
	if traceID := TraceIDFrom(ctx); traceID != "" {
		t.Fatalf("expected empty trace id, got %q", traceID)
	}
	ctxWithTrace := withTraceID(ctx, "trace-123")
	if traceID := TraceIDFrom(ctxWithTrace); traceID != "trace-123" {
		t.Fatalf("TraceIDFrom = %q", traceID)
	}
	if keyID := PublicAPIKeyIDFrom(ctx); keyID != "" {
		t.Fatalf("expected empty key ID, got %q", keyID)
	}
}

func TestMiddlewareWriteErrorHelper(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusBadRequest, "bad input")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("writeError code = %d", rec.Code)
	}
}

func TestMiddlewarePublicAuthHelpers(t *testing.T) {
	// isGeminiDispatchPath
	if !isGeminiDispatchPath("/v1beta/models/gemini-pro:generateContent") {
		t.Fatal("expected true for gemini generateContent")
	}
	if !isGeminiDispatchPath("/v1beta/models/gemini-pro:streamGenerateContent") {
		t.Fatal("expected true for gemini streamGenerateContent")
	}
	if isGeminiDispatchPath("/v1beta/models/a/b:generateContent") {
		t.Fatal("expected false for nested path")
	}
	if isGeminiDispatchPath("/v1/chat/completions") {
		t.Fatal("expected false for openai path")
	}

	// geminiModelFromPath
	if m := geminiModelFromPath("/v1beta/models/gemini-1.5-flash:generateContent"); m != "gemini-1.5-flash" {
		t.Fatalf("gemini model = %q", m)
	}
	if m := geminiModelFromPath("/other/path"); m != "" {
		t.Fatalf("other path = %q", m)
	}

	// multipartModel
	body := []byte("--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-4o-audio\r\n--boundary--\r\n")
	ct := "multipart/form-data; boundary=boundary"
	if m := multipartModel(body, ct); m != "gpt-4o-audio" {
		t.Fatalf("multipartModel = %q, want 'gpt-4o-audio'", m)
	}
	if m := multipartModel(nil, "bad-content-type"); m != "" {
		t.Fatalf("bad content type = %q", m)
	}

	// aclAllows
	emptyKey := PublicAPIKey{}
	if !aclAllows(emptyKey, "openai", "gpt-4o") {
		t.Fatal("empty ACL should allow model")
	}
	allowKey := PublicAPIKey{ModelAllowlist: "gpt-4o, claude-3-5-sonnet"}
	if !aclAllows(allowKey, "openai", "gpt-4o") {
		t.Fatal("matching allowlist should allow model")
	}
	if aclAllows(allowKey, "openai", "claude-3-opus") {
		t.Fatal("non-matching allowlist should disallow model")
	}
	denyKey := PublicAPIKey{ModelDenylist: "claude-3-opus"}
	if aclAllows(denyKey, "anthropic", "claude-3-opus") {
		t.Fatal("matching denylist should disallow model")
	}

	// requestUsesHTTPS
	if requestUsesHTTPS(nil) {
		t.Fatal("nil req should not use HTTPS")
	}
	reqTLS := &http.Request{Header: http.Header{}}
	if requestUsesHTTPS(reqTLS) {
		t.Fatal("plain req should not use HTTPS")
	}
	reqTLS.Header.Set("X-Forwarded-Proto", "https")
	if !requestUsesHTTPS(reqTLS) {
		t.Fatal("X-Forwarded-Proto: https should use HTTPS")
	}
}
