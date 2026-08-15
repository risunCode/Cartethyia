package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

type shareTestRepository struct {
	mu       sync.Mutex
	links    map[string]models.ShareLink
	keys     map[string]models.ApiKey
	secrets  map[string]string
	consumed int
}

func (s *shareTestRepository) GetByID(_ context.Context, id string) (models.ApiKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, ok := s.keys[id]
	if !ok {
		return models.ApiKey{}, sql.ErrNoRows
	}
	return key, nil
}
func (s *shareTestRepository) Credential(_ context.Context, id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.secrets[id]
	if !ok {
		return "", sql.ErrNoRows
	}
	return value, nil
}
func (s *shareTestRepository) GetShareLinkByTokenHash(_ context.Context, tokenHash string) (models.ShareLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for hash, link := range s.links {
		if hash == tokenHash {
			return link, nil
		}
	}
	return models.ShareLink{}, sql.ErrNoRows
}
func (s *shareTestRepository) ConsumeSetupShareLink(_ context.Context, id, _ string) (models.ShareLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for hash, link := range s.links {
		if link.ID == id && link.Kind == "setup" && link.Active && link.UsedAt == nil {
			now := time.Now().UTC()
			link.Active = false
			link.UsedAt = &now
			s.links[hash] = link
			s.consumed++
			return link, nil
		}
	}
	return models.ShareLink{}, sql.ErrNoRows
}
func (s *shareTestRepository) TouchShareLink(context.Context, string) error { return nil }

type shareTestUsage struct{ value models.ShareUsage }

func (s shareTestUsage) ShareUsage(context.Context, string, time.Time) (models.ShareUsage, error) {
	return s.value, nil
}

type shareTestInFlight int

func (s shareTestInFlight) InFlight() int { return int(s) }

type shareStreamResponseWriter struct {
	mu       sync.Mutex
	recorder *httptest.ResponseRecorder
	wrote    chan struct{}
	once     sync.Once
}

func (w *shareStreamResponseWriter) Header() http.Header {
	return w.recorder.Header()
}

func (w *shareStreamResponseWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.recorder.WriteHeader(status)
}

func (w *shareStreamResponseWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.once.Do(func() { close(w.wrote) })
	return w.recorder.Write(p)
}

func (w *shareStreamResponseWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.recorder.Flush()
}

func newShareTestHandler(repo *shareTestRepository, usage ShareUsageSource, inFlight ShareInFlightSource) http.Handler {
	mux := http.NewServeMux()
	registerShare(mux, &ShareOptions{APIKeys: repo, Usage: usage, InFlight: inFlight})
	return mux
}

func TestPublicShareMonitorValidAndInvalidToken(t *testing.T) {
	repo := &shareTestRepository{links: map[string]models.ShareLink{}, keys: map[string]models.ApiKey{}, secrets: map[string]string{}}
	repo.keys["key_1"] = models.ApiKey{ID: "key_1", Name: "Shared key", KeyPrefix: "sk-test", Active: true, CreatedAt: time.Now().UTC()}
	token := "monitor-token"
	hash, _ := shareTokenHash(token)
	repo.links[hash] = models.ShareLink{ID: "share_1", APIKeyID: "key_1", TokenHash: hash, Kind: "monitor", Active: true}
	handler := newShareTestHandler(repo, shareTestUsage{value: models.ShareUsage{TotalRequests: 4, TotalTokens: 20, DailyTokens: 8, MonthlyTokens: 20}}, shareTestInFlight(3))

	request := httptest.NewRequest(http.MethodGet, "/share/"+token+"/data", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid monitor status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["inFlight"] != float64(3) || payload["totalRequests"] != float64(4) {
		t.Fatalf("monitor payload = %#v", payload)
	}
	if _, ok := payload["byIp"]; ok {
		t.Fatal("monitor payload exposed byIp")
	}

	bad := httptest.NewRecorder()
	handler.ServeHTTP(bad, httptest.NewRequest(http.MethodGet, "/share/not-issued/data", nil))
	if bad.Code != http.StatusNotFound || !strings.Contains(bad.Body.String(), `"error":"link_not_found"`) {
		t.Fatalf("invalid monitor response = %d %s", bad.Code, bad.Body.String())
	}
}

func TestPublicShareSetupOneShotAndStatuses(t *testing.T) {
	repo := &shareTestRepository{links: map[string]models.ShareLink{}, keys: map[string]models.ApiKey{}, secrets: map[string]string{}}
	repo.keys["key_1"] = models.ApiKey{ID: "key_1", Name: "Setup key", Active: true}
	repo.secrets["key_1"] = "sk-secret"
	token := "setup-token"
	hash, _ := shareTokenHash(token)
	expires := time.Now().UTC().Add(time.Hour)
	repo.links[hash] = models.ShareLink{ID: "setup_1", APIKeyID: "key_1", TokenHash: hash, Kind: "setup", Active: true, ExpiresAt: &expires}
	handler := newShareTestHandler(repo, nil, nil)

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/share/setup/"+token+"/data", nil))
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"key":"sk-secret"`) {
		t.Fatalf("first setup response = %d %s", first.Code, first.Body.String())
	}
	if repo.consumed != 1 {
		t.Fatalf("setup consumed = %d", repo.consumed)
	}
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/share/setup/"+token+"/data", nil))
	if second.Code != http.StatusGone || !strings.Contains(second.Body.String(), `"error":"link_expired_or_used"`) {
		t.Fatalf("second setup response = %d %s", second.Code, second.Body.String())
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/share/setup/unknown/data", nil))
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), `"error":"link_not_found"`) {
		t.Fatalf("missing setup response = %d %s", missing.Code, missing.Body.String())
	}

	expiredRepo := &shareTestRepository{links: map[string]models.ShareLink{}, keys: map[string]models.ApiKey{}, secrets: map[string]string{}}
	expiredToken := "expired-token"
	expiredHash, _ := shareTokenHash(expiredToken)
	old := time.Now().UTC().Add(-time.Minute)
	expiredRepo.links[expiredHash] = models.ShareLink{ID: "setup_old", APIKeyID: "key_1", TokenHash: expiredHash, Kind: "setup", Active: true, ExpiresAt: &old}
	expiredHandler := newShareTestHandler(expiredRepo, nil, nil)
	expired := httptest.NewRecorder()
	expiredHandler.ServeHTTP(expired, httptest.NewRequest(http.MethodGet, "/share/setup/"+expiredToken+"/data", nil))
	if expired.Code != http.StatusGone || !strings.Contains(expired.Body.String(), `"error":"link_expired_or_used"`) {
		t.Fatalf("expired setup response = %d %s", expired.Code, expired.Body.String())
	}

	unavailableRepo := &shareTestRepository{links: map[string]models.ShareLink{}, keys: map[string]models.ApiKey{}, secrets: map[string]string{}}
	unavailableToken := "unavailable-token"
	unavailableHash, _ := shareTokenHash(unavailableToken)
	unavailableRepo.links[unavailableHash] = models.ShareLink{ID: "setup_unavailable", APIKeyID: "key_missing", TokenHash: unavailableHash, Kind: "setup", Active: true, ExpiresAt: &expires}
	unavailableHandler := newShareTestHandler(unavailableRepo, nil, nil)
	unavailable := httptest.NewRecorder()
	unavailableHandler.ServeHTTP(unavailable, httptest.NewRequest(http.MethodGet, "/share/setup/"+unavailableToken+"/data", nil))
	if unavailable.Code != http.StatusGone || !strings.Contains(unavailable.Body.String(), `"error":"key_unavailable"`) {
		t.Fatalf("unavailable-key setup response = %d %s", unavailable.Code, unavailable.Body.String())
	}
}

func TestPublicShareStreamPayloadPrivacyAndCancellation(t *testing.T) {
	repo := &shareTestRepository{links: map[string]models.ShareLink{}, keys: map[string]models.ApiKey{}, secrets: map[string]string{}}
	repo.keys["key_1"] = models.ApiKey{ID: "key_1", Name: "Stream key", Active: true}
	token := "stream-token"
	hash, _ := shareTokenHash(token)
	repo.links[hash] = models.ShareLink{ID: "stream_1", APIKeyID: "key_1", TokenHash: hash, Kind: "monitor", Active: true}
	handler := newShareTestHandler(repo, nil, shareTestInFlight(7))
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/share/"+token+"/stream", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	streamResponse := &shareStreamResponseWriter{recorder: response, wrote: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(streamResponse, request)
		close(done)
	}()
	select {
	case <-streamResponse.wrote:
	case <-time.After(time.Second):
		t.Fatal("stream did not emit initial payload")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream did not stop after request cancellation")
	}
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, "event: count") || !strings.Contains(body, `{"inFlight":7}`) {
		t.Fatalf("stream response = %d %s", response.Code, body)
	}
	if strings.Contains(body, "byIp") || strings.Contains(body, "byProvider") {
		t.Fatalf("stream leaked private dimensions: %s", body)
	}
}
