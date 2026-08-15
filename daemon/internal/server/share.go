package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
)

const shareTokenMaxLength = 512

func registerShare(mux *http.ServeMux, opts *ShareOptions) {
	if opts == nil || opts.APIKeys == nil {
		return
	}
	mux.HandleFunc("/share/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		setShareHeaders(w)
		rest := strings.TrimPrefix(r.URL.Path, "/share/")
		switch {
		case strings.HasPrefix(rest, "setup/"):
			handleShareSetup(w, r, opts, strings.TrimSuffix(strings.TrimPrefix(rest, "setup/"), "/data"))
		case strings.HasSuffix(rest, "/data"):
			handleShareMonitor(w, r, opts, strings.TrimSuffix(rest, "/data"))
		case strings.HasSuffix(rest, "/stream"):
			handleShareStream(w, r, opts, strings.TrimSuffix(rest, "/stream"))
		default:
			writeError(w, http.StatusNotFound, "link_not_found")
		}
	})
}

func setShareHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func shareTokenHash(token string) (string, bool) {
	if token == "" || len(token) > shareTokenMaxLength || strings.IndexFunc(token, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return "", false
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:]), true
}

func resolveShareLink(r *http.Request, opts *ShareOptions, token, kind string) (models.ShareLink, int, bool) {
	hash, ok := shareTokenHash(token)
	if !ok {
		return models.ShareLink{}, http.StatusNotFound, false
	}
	link, err := opts.APIKeys.GetShareLinkByTokenHash(r.Context(), hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.ShareLink{}, http.StatusNotFound, false
		}
		return models.ShareLink{}, http.StatusServiceUnavailable, false
	}
	if link.ID == "" || link.Kind != kind {
		return models.ShareLink{}, http.StatusNotFound, false
	}
	now := time.Now().UTC()
	if !link.Active || link.UsedAt != nil || link.ExpiresAt != nil && !link.ExpiresAt.After(now) {
		return models.ShareLink{}, http.StatusNotFound, false
	}
	return link, http.StatusOK, true
}

func handleShareMonitor(w http.ResponseWriter, r *http.Request, opts *ShareOptions, token string) {
	link, status, ok := resolveShareLink(r, opts, token, "monitor")
	if !ok {
		writeError(w, status, "link_not_found")
		return
	}
	key, err := opts.APIKeys.GetByID(r.Context(), link.APIKeyID)
	if err != nil || key.ID == "" || !key.Active || key.RevokedAt != nil {
		writeError(w, http.StatusNotFound, "link_not_found")
		return
	}
	_ = opts.APIKeys.TouchShareLink(r.Context(), link.ID)
	usage := models.ShareUsage{}
	if opts.Usage != nil {
		usage, err = opts.Usage.ShareUsage(r.Context(), key.ID, time.Now().UTC())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "share_unavailable")
			return
		}
	}
	inFlight := shareInFlight(opts)
	response := shareMonitorResponse{
		Name: key.Name, Active: key.Active, APIKey: shareAPIKeyResponse{ID: key.ID, Prefix: key.KeyPrefix, Active: key.Active},
		QuotaAvailable: quotaAvailable(key, usage), InFlight: maxInt(inFlight, 0),
		TotalTokens: usage.TotalTokens, TotalRequests: usage.TotalRequests,
		DailyUsed: usage.DailyTokens, DailyLimit: key.DailyTokenLimit, DailyRemaining: remaining(key.DailyTokenLimit, usage.DailyTokens),
		MonthlyUsed: usage.MonthlyTokens, MonthlyLimit: key.MonthlyTokenLimit, MonthlyRemaining: remaining(key.MonthlyTokenLimit, usage.MonthlyTokens),
		OneTimeLimit: key.OneTimeTokenLimit, OneTimeUsed: key.OneTimeTokensUsed, OneTimeRemaining: remaining(key.OneTimeTokenLimit, int64(key.OneTimeTokensUsed)),
		RateLimitRPM: key.RateLimitRpm, MaxConcurrentRequests: key.MaxConcurrentRequests,
		ProviderAllowlist: nullableString(key.ProviderAllowlist), ModelAllowlist: nullableString(key.ModelAllowlist), ModelDenylist: nullableString(key.ModelDenylist),
		Notes:     shareNotes{Title: key.QuoteBigText, Subtitle: key.QuoteSubText, Body: key.QuoteBody},
		CreatedAt: key.CreatedAt, LastUsedAt: key.LastUsedAt, BaseURL: requestBaseURL(r),
	}
	writeJSON(w, http.StatusOK, response)
}

func handleShareSetup(w http.ResponseWriter, r *http.Request, opts *ShareOptions, token string) {
	link, _, ok := resolveShareLink(r, opts, token, "setup")
	if !ok {
		hash, valid := shareTokenHash(token)
		if !valid {
			writeError(w, http.StatusNotFound, "link_not_found")
			return
		}
		candidate, err := opts.APIKeys.GetShareLinkByTokenHash(r.Context(), hash)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusServiceUnavailable, "share_unavailable")
			return
		}
		if errors.Is(err, sql.ErrNoRows) || candidate.ID == "" || candidate.Kind != "setup" {
			writeError(w, http.StatusNotFound, "link_not_found")
			return
		}
		writeError(w, http.StatusGone, "link_expired_or_used")
		return
	}
	key, err := opts.APIKeys.GetByID(r.Context(), link.APIKeyID)
	if err != nil || key.ID == "" || !key.Active || key.RevokedAt != nil {
		writeError(w, http.StatusGone, "key_unavailable")
		return
	}
	credential, err := opts.APIKeys.Credential(r.Context(), key.ID)
	if err != nil || strings.TrimSpace(credential) == "" {
		writeError(w, http.StatusGone, "key_unavailable")
		return
	}
	consumed, err := opts.APIKeys.ConsumeSetupShareLink(r.Context(), link.ID, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil || consumed.ID == "" {
		writeError(w, http.StatusGone, "link_expired_or_used")
		return
	}
	writeJSON(w, http.StatusOK, shareSetupResponse{Name: key.Name, Key: credential, BaseURL: requestBaseURL(r), ExpiresAt: link.ExpiresAt})
}

func handleShareStream(w http.ResponseWriter, r *http.Request, opts *ShareOptions, token string) {
	link, status, ok := resolveShareLink(r, opts, token, "monitor")
	if !ok {
		writeError(w, status, "link_not_found")
		return
	}
	key, err := opts.APIKeys.GetByID(r.Context(), link.APIKeyID)
	if err != nil || key.ID == "" || !key.Active || key.RevokedAt != nil {
		writeError(w, http.StatusNotFound, "link_not_found")
		return
	}
	_ = opts.APIKeys.TouchShareLink(r.Context(), link.ID)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "stream_unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	writeShareCount(w, flusher, shareInFlight(opts))
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			writeShareCount(w, flusher, shareInFlight(opts))
		}
	}
}

func writeShareCount(w http.ResponseWriter, flusher http.Flusher, inFlight int) {
	payload, _ := json.Marshal(map[string]int{"inFlight": maxInt(inFlight, 0)})
	_, _ = fmt.Fprintf(w, "event: count\ndata: %s\n\n", payload)
	flusher.Flush()
}

func shareInFlight(opts *ShareOptions) int {
	if opts == nil || opts.InFlight == nil {
		return 0
	}
	return opts.InFlight.InFlight()
}

func maxInt(value, floor int) int {
	if value < floor {
		return floor
	}
	return value
}

type shareAPIKeyResponse struct {
	ID     string `json:"id"`
	Prefix string `json:"prefix"`
	Active bool   `json:"active"`
}

type shareNotes struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	Body     string `json:"body"`
}

type shareMonitorResponse struct {
	Name                  string              `json:"name"`
	Active                bool                `json:"active"`
	APIKey                shareAPIKeyResponse `json:"apiKey"`
	QuotaAvailable        bool                `json:"quotaAvailable"`
	InFlight              int                 `json:"inFlight"`
	TotalTokens           int64               `json:"totalTokens"`
	TotalRequests         int64               `json:"totalRequests"`
	DailyUsed             int64               `json:"dailyUsed"`
	DailyLimit            *int                `json:"dailyLimit"`
	DailyRemaining        *int64              `json:"dailyRemaining"`
	MonthlyUsed           int64               `json:"monthlyUsed"`
	MonthlyLimit          *int                `json:"monthlyLimit"`
	MonthlyRemaining      *int64              `json:"monthlyRemaining"`
	OneTimeLimit          *int                `json:"oneTimeLimit"`
	OneTimeUsed           int                 `json:"oneTimeUsed"`
	OneTimeRemaining      *int64              `json:"oneTimeRemaining"`
	RateLimitRPM          *int                `json:"rateLimitRpm"`
	MaxConcurrentRequests *int                `json:"maxConcurrentRequests"`
	ProviderAllowlist     *string             `json:"providerAllowlist"`
	ModelAllowlist        *string             `json:"modelAllowlist"`
	ModelDenylist         *string             `json:"modelDenylist"`
	Notes                 shareNotes          `json:"notes"`
	CreatedAt             time.Time           `json:"createdAt"`
	LastUsedAt            *time.Time          `json:"lastUsedAt"`
	BaseURL               string              `json:"baseUrl"`
}

type shareSetupResponse struct {
	Name      string     `json:"name"`
	Key       string     `json:"key"`
	BaseURL   string     `json:"baseUrl"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

func nullableString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func remaining(limit *int, used int64) *int64 {
	if limit == nil {
		return nil
	}
	left := int64(*limit) - used
	if left < 0 {
		left = 0
	}
	return &left
}

func quotaAvailable(key models.ApiKey, usage models.ShareUsage) bool {
	if !key.Active || key.RevokedAt != nil {
		return false
	}
	if key.DailyTokenLimit != nil && usage.DailyTokens >= int64(*key.DailyTokenLimit) {
		return false
	}
	if key.MonthlyTokenLimit != nil && usage.MonthlyTokens >= int64(*key.MonthlyTokenLimit) {
		return false
	}
	return key.OneTimeTokenLimit == nil || key.OneTimeTokensUsed < *key.OneTimeTokenLimit
}
