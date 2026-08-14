package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"time"

	apierrors "github.com/cartethyia/daemon/internal/server/api/errors"
)

const maxPublicAuthBodyBytes = 10 * 1024 * 1024

// PublicAPIKey is the redacted authorization projection used by the public
// V1 boundary. It intentionally contains no credential material.
type PublicAPIKey struct {
	ID                string
	Active            bool
	RevokedAt         *time.Time
	RateLimitRpm      *int
	MaxConcurrent     *int
	DailyTokenLimit   *int
	MonthlyTokenLimit *int
	OneTimeTokenLimit *int
	OneTimeTokensUsed int
	ProviderAllowlist string
	ModelAllowlist    string
	ModelDenylist     string
}

// PublicAPIKeyResolver resolves one presented credential. Implementations must
// compare the secret in the durable authority and return only PublicAPIKey.
type PublicAPIKeyResolver interface {
	ResolveAPIKey(context.Context, string) (PublicAPIKey, error)
}

type publicAPIKeyToucher interface {
	TouchAPIKey(context.Context, string) error
}

type publicAPIKeyOneTimeConsumer interface {
	ConsumeOneTimeTokens(context.Context, string, int) error
}

type publicAuthContextKey struct{}

// PublicAPIKeyFromContext returns the redacted key identity attached by
// PublicV1Auth. The returned value never contains secret material.
func PublicAPIKeyFromContext(ctx context.Context) (PublicAPIKey, bool) {
	if ctx == nil {
		return PublicAPIKey{}, false
	}
	value, ok := ctx.Value(publicAuthContextKey{}).(PublicAPIKey)
	return value, ok && value.ID != ""
}

// PublicV1Auth enforces credentials for /v1 routes when a resolver is
// configured. With no resolver, development callers retain the existing
// anonymous behavior; production callers fail closed.
func PublicV1Auth(resolver PublicAPIKeyResolver, production bool) func(http.Handler) http.Handler {
	admission := newPublicAPIAdmission()
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if resolver == nil && !production {
				next.ServeHTTP(w, r)
				return
			}
			credential, ok := presentedCredential(r)
			if !ok {
				writeAuthError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			if resolver == nil {
				writeAuthError(w, http.StatusServiceUnavailable, "authentication is unavailable")
				return
			}

			model, body, bodyErr := authRequestModel(r)
			if bodyErr != nil {
				writeAuthError(w, http.StatusRequestEntityTooLarge, "request body is too large")
				return
			}
			if body != nil {
				r.Body = io.NopCloser(bytes.NewReader(body))
			}
			key, err := resolver.ResolveAPIKey(r.Context(), credential)
			if err != nil || !key.Active || key.RevokedAt != nil {
				writeAuthError(w, http.StatusUnauthorized, "invalid API credentials")
				return
			}
			provider := strings.TrimSpace(r.Header.Get("X-Cartethyia-Provider"))
			if provider == "" {
				provider = modelProvider(model)
			}
			if isDispatchPath(r.URL.Path) && !aclAllows(key, provider, model) {
				writeAuthError(w, http.StatusForbidden, "request is not authorized")
				return
			}
			if isDispatchPath(r.URL.Path) {
				release, allowed := admission.acquire(key, time.Now())
				if !allowed {
					writeAuthError(w, http.StatusTooManyRequests, "API key request limit exceeded")
					return
				}
				defer release()
				if key.OneTimeTokenLimit != nil && *key.OneTimeTokenLimit > key.OneTimeTokensUsed {
					consumer, ok := resolver.(publicAPIKeyOneTimeConsumer)
					if !ok || consumer.ConsumeOneTimeTokens(r.Context(), key.ID, estimateRequestTokens(body)) != nil {
						writeAuthError(w, http.StatusTooManyRequests, "one-time API key token limit exceeded")
						return
					}
				}
			}
			if toucher, ok := resolver.(publicAPIKeyToucher); ok {
				_ = toucher.TouchAPIKey(r.Context(), key.ID)
			}
			r = r.WithContext(context.WithValue(r.Context(), publicAuthContextKey{}, key))
			next.ServeHTTP(w, r)
		})
	}
}

func isDispatchPath(path string) bool {
	switch path {
	case "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens", "/v1/action", "/v1/images/generations", "/v1/images/edits":
		return true
	default:
		return false
	}
}

func presentedCredential(r *http.Request) (string, bool) {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	apiKey := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if authorization != "" && apiKey != "" {
		return "", false
	}
	if authorization != "" {
		parts := strings.Fields(authorization)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
			return "", false
		}
		return parts[1], true
	}
	if apiKey == "" {
		return "", false
	}
	return apiKey, true
}

func authRequestModel(r *http.Request) (string, []byte, error) {
	if r.Body == nil || r.Method == http.MethodGet {
		return "", nil, nil
	}
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPublicAuthBodyBytes+1))
	if err != nil {
		return "", nil, err
	}
	if len(body) > maxPublicAuthBodyBytes {
		return "", nil, errors.New("request body too large")
	}
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return multipartModel(body, r.Header.Get("Content-Type")), body, nil
	}
	if !strings.Contains(contentType, "application/json") {
		return "", body, nil
	}
	var payload struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &payload) == nil {
		return strings.TrimSpace(payload.Model), body, nil
	}
	return "", body, nil
}

func multipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	for {
		part, err := reader.NextPart()
		if err != nil {
			return ""
		}
		if part.FormName() == "model" {
			value, _ := io.ReadAll(io.LimitReader(part, 512))
			return strings.TrimSpace(string(value))
		}
		_, _ = io.Copy(io.Discard, part)
	}
}

func modelProvider(model string) string {
	if slash := strings.IndexByte(model, '/'); slash > 0 {
		return strings.TrimSpace(model[:slash])
	}
	return ""
}

func aclAllows(key PublicAPIKey, provider, model string) bool {
	providers := splitACL(key.ProviderAllowlist)
	models := splitACL(key.ModelAllowlist)
	denied := splitACL(key.ModelDenylist)
	if len(providers) > 0 && !aclMatch(providers, provider) {
		return false
	}
	if len(models) > 0 {
		values := []string{model}
		if provider != "" && model != "" {
			values = append(values, provider+"/"+model)
		}
		if !aclMatchValues(models, values) {
			return false
		}
	}
	if len(denied) > 0 {
		values := []string{model}
		if provider != "" && model != "" {
			values = append(values, provider+"/"+model)
		}
		if aclMatchValues(denied, values) {
			return false
		}
	}
	return true
}

func splitACL(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func estimateRequestTokens(body []byte) int {
	if len(body) == 0 {
		return 1
	}
	count := len(body) / 4
	if count < 1 {
		return 1
	}
	return count
}

type publicAPIAdmission struct {
	mu    sync.Mutex
	state map[string]*publicAPIAdmissionState
}

type publicAPIAdmissionState struct {
	active int
	window []time.Time
}

func newPublicAPIAdmission() *publicAPIAdmission {
	return &publicAPIAdmission{state: make(map[string]*publicAPIAdmissionState)}
}

func (a *publicAPIAdmission) acquire(key PublicAPIKey, now time.Time) (func(), bool) {
	if a == nil || key.ID == "" {
		return func() {}, true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	state := a.state[key.ID]
	if state == nil {
		state = &publicAPIAdmissionState{}
		a.state[key.ID] = state
	}
	cutoff := now.Add(-time.Minute)
	kept := state.window[:0]
	for _, timestamp := range state.window {
		if timestamp.After(cutoff) {
			kept = append(kept, timestamp)
		}
	}
	state.window = kept
	if key.RateLimitRpm != nil && *key.RateLimitRpm > 0 && len(state.window) >= *key.RateLimitRpm {
		return func() {}, false
	}
	if key.MaxConcurrent != nil && *key.MaxConcurrent > 0 && state.active >= *key.MaxConcurrent {
		return func() {}, false
	}
	state.window = append(state.window, now)
	state.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			if current := a.state[key.ID]; current != nil && current.active > 0 {
				current.active--
			}
			a.mu.Unlock()
		})
	}, true
}

func aclMatch(values []string, candidate string) bool {
	return aclMatchValues(values, []string{candidate})
}

func aclMatchValues(values, candidates []string) bool {
	for _, value := range values {
		for _, candidate := range candidates {
			if value == "*" || value == candidate {
				return true
			}
		}
	}
	return false
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	apierrors.Write(w, status, apierrors.CodeAuthMissing, message)
}
