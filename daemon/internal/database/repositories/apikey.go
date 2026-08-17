package repositories

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
)

// APIKeyRepository owns the api_keys and share_links tables.
//
// The Credential accessor returns the full secret; callers MUST NOT log
// the result. Touch/FlushTouches exist for the same coalesced-write
// pattern the legacy SQLite layer used on last_used_at.
type APIKeyRepository interface {
	List(ctx context.Context) ([]models.ApiKey, error)
	GetByID(ctx context.Context, id string) (models.ApiKey, error)
	GetBySecret(ctx context.Context, key string) (models.ApiKey, error)
	Credential(ctx context.Context, id string) (string, error)
	Create(ctx context.Context, input models.ApiKeyCreateInput) (models.ApiKey, error)
	Patch(ctx context.Context, id string, patch models.ApiKeyPatchInput) (models.ApiKey, error)
	Revoke(ctx context.Context, id string) (bool, error)
	Delete(ctx context.Context, id string) (bool, error)
	Touch(ctx context.Context, id string) error
	FlushTouches(ctx context.Context) error

	CreateShareLink(ctx context.Context, link models.ShareLink) (models.ShareLink, error)
	GetShareLinkByTokenHash(ctx context.Context, tokenHash string) (models.ShareLink, error)
	ListShareLinksByAPIKey(ctx context.Context, apiKeyID string) ([]models.ShareLink, error)
	PatchShareLinkActive(ctx context.Context, id string, active bool) (models.ShareLink, error)
	ConsumeSetupShareLink(ctx context.Context, id string, now string) (models.ShareLink, error)
	TouchShareLink(ctx context.Context, id string) error
	DeleteShareLink(ctx context.Context, id string) (bool, error)
}

// BunPublicAPIKeyResolver is the narrow durable adapter consumed by the
// public HTTP authentication boundary. It selects only redacted policy fields
// and never returns the stored credential.
type BunPublicAPIKeyResolver struct {
	db *bun.DB
}

func NewBunPublicAPIKeyResolver(db *bun.DB) *BunPublicAPIKeyResolver {
	return &BunPublicAPIKeyResolver{db: db}
}

type publicAPIKeyRow struct {
	ID                    string     `bun:"id"`
	Active                bool       `bun:"active"`
	RevokedAt             *time.Time `bun:"revoked_at"`
	RateLimitRpm          *int       `bun:"rate_limit_rpm"`
	DailyTokenLimit       *int       `bun:"daily_token_limit"`
	MonthlyTokenLimit     *int       `bun:"monthly_token_limit"`
	OneTimeTokenLimit     *int       `bun:"one_time_token_limit"`
	OneTimeTokensUsed     int        `bun:"one_time_tokens_used"`
	MaxConcurrentRequests *int       `bun:"max_concurrent_requests"`
	ProviderAllowlist     *string    `bun:"provider_allowlist"`
	ModelAllowlist        *string    `bun:"model_allowlist"`
	ModelDenylist         *string    `bun:"model_denylist"`
}

func (r *BunPublicAPIKeyResolver) ResolveAPIKey(ctx context.Context, key string) (models.ApiKey, error) {
	if r == nil || r.db == nil {
		return models.ApiKey{}, errors.New("database: API key authority is unavailable")
	}
	if key == "" {
		return models.ApiKey{}, errors.New("database: API key is empty")
	}
	var row publicAPIKeyRow
	err := r.db.NewRaw(`SELECT id, active, revoked_at, rate_limit_rpm, daily_token_limit, monthly_token_limit, one_time_token_limit, one_time_tokens_used, max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist FROM api_keys WHERE key = ?`, key).Scan(ctx, &row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.ApiKey{}, errors.New("database: API key not found")
	}
	if err != nil {
		return models.ApiKey{}, err
	}
	return models.ApiKey{ID: row.ID, Active: row.Active, RevokedAt: row.RevokedAt, RateLimitRpm: row.RateLimitRpm, DailyTokenLimit: row.DailyTokenLimit, MonthlyTokenLimit: row.MonthlyTokenLimit, OneTimeTokenLimit: row.OneTimeTokenLimit, OneTimeTokensUsed: row.OneTimeTokensUsed, MaxConcurrentRequests: row.MaxConcurrentRequests, ProviderAllowlist: ptrString(row.ProviderAllowlist), ModelAllowlist: ptrString(row.ModelAllowlist), ModelDenylist: ptrString(row.ModelDenylist)}, nil
}

func (r *BunPublicAPIKeyResolver) TouchAPIKey(ctx context.Context, id string) error {
	if r == nil || r.db == nil {
		return errors.New("database: API key authority is unavailable")
	}
	_, err := r.db.NewRaw(`UPDATE api_keys SET last_used_at = NOW() WHERE id = ? AND active = TRUE AND revoked_at IS NULL`, id).Exec(ctx)
	return err
}

const (
	maxAPIKeyID     = 256
	maxAPIKeySecret = 4096
	maxAPIKeyText   = 64 << 10
	maxAPIKeyRows   = 2048
	maxShareRows    = 4096
	maxTokenDelta   = 1_000_000_000
)

// BunAPIKeyRepository is the PostgreSQL implementation of APIKeyRepository.
// API-key secrets are selected only by Credential and never enter redacted
// projections returned by the other methods.
type BunAPIKeyRepository struct {
	db      *bun.DB
	mu      sync.Mutex
	pending map[string]struct{}
}

func NewBunAPIKeyRepository(db *bun.DB) *BunAPIKeyRepository {
	return &BunAPIKeyRepository{db: db, pending: make(map[string]struct{})}
}

type apiKeyRow struct {
	bun.BaseModel         `bun:"table:api_keys"`
	ID                    string     `bun:"id"`
	Name                  string     `bun:"name"`
	KeyPrefix             string     `bun:"key_prefix"`
	Active                bool       `bun:"active"`
	RateLimitRpm          *int       `bun:"rate_limit_rpm"`
	DailyTokenLimit       *int       `bun:"daily_token_limit"`
	MonthlyTokenLimit     *int       `bun:"monthly_token_limit"`
	OneTimeTokenLimit     *int       `bun:"one_time_token_limit"`
	OneTimeTokensUsed     int        `bun:"one_time_tokens_used"`
	QuoteBigText          *string    `bun:"quote_big_text"`
	QuoteSubText          *string    `bun:"quote_sub_text"`
	QuoteBody             *string    `bun:"quote_body"`
	MaxConcurrentRequests *int       `bun:"max_concurrent_requests"`
	ProviderAllowlist     *string    `bun:"provider_allowlist"`
	ModelAllowlist        *string    `bun:"model_allowlist"`
	ModelDenylist         *string    `bun:"model_denylist"`
	DisableRemoteMapping  bool       `bun:"disable_remote_mapping"`
	LastUsedAt            *time.Time `bun:"last_used_at"`
	CreatedAt             time.Time  `bun:"created_at"`
	RevokedAt             *time.Time `bun:"revoked_at"`
}

type shareLinkRow struct {
	bun.BaseModel `bun:"table:share_links"`
	ID            string     `bun:"id"`
	APIKeyID      string     `bun:"api_key_id"`
	TokenHash     string     `bun:"token_hash"`
	Kind          string     `bun:"kind"`
	Active        bool       `bun:"active"`
	CreatedAt     time.Time  `bun:"created_at"`
	ExpiresAt     *time.Time `bun:"expires_at"`
	UsedAt        *time.Time `bun:"used_at"`
	LastViewedAt  *time.Time `bun:"last_viewed_at"`
}

func (r *BunAPIKeyRepository) open() error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	return nil
}
func apiKeyModel(v apiKeyRow) models.ApiKey {
	return models.ApiKey{ID: v.ID, Name: v.Name, KeyPrefix: v.KeyPrefix, Active: v.Active, RateLimitRpm: v.RateLimitRpm, DailyTokenLimit: v.DailyTokenLimit, MonthlyTokenLimit: v.MonthlyTokenLimit, OneTimeTokenLimit: v.OneTimeTokenLimit, OneTimeTokensUsed: v.OneTimeTokensUsed, QuoteBigText: ptrString(v.QuoteBigText), QuoteSubText: ptrString(v.QuoteSubText), QuoteBody: ptrString(v.QuoteBody), MaxConcurrentRequests: v.MaxConcurrentRequests, ProviderAllowlist: ptrString(v.ProviderAllowlist), ModelAllowlist: ptrString(v.ModelAllowlist), ModelDenylist: ptrString(v.ModelDenylist), DisableRemoteMapping: v.DisableRemoteMapping, LastUsedAt: v.LastUsedAt, CreatedAt: v.CreatedAt, RevokedAt: v.RevokedAt}
}
func ptrString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func shareModel(v shareLinkRow) models.ShareLink {
	return models.ShareLink{ID: v.ID, APIKeyID: v.APIKeyID, TokenHash: v.TokenHash, Kind: v.Kind, Active: v.Active, CreatedAt: v.CreatedAt, ExpiresAt: v.ExpiresAt, UsedAt: v.UsedAt, LastViewedAt: v.LastViewedAt}
}
func keyID(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > maxAPIKeyID {
		return "", errors.New("api key: id is required and bounded")
	}
	return v, nil
}
func secret(v string) error {
	if v == "" || len(v) > maxAPIKeySecret {
		return errors.New("api key: credential is required and bounded")
	}
	return nil
}
func limits(v ...*int) error {
	for _, n := range v {
		if n != nil && (*n < 0 || *n > maxTokenDelta) {
			return errors.New("api key: numeric limit is bounded")
		}
	}
	return nil
}

func (r *BunAPIKeyRepository) List(ctx context.Context) ([]models.ApiKey, error) {
	if err := r.open(); err != nil {
		return nil, err
	}
	rows := []apiKeyRow{}
	if err := r.db.NewSelect().Model(&rows).OrderExpr("created_at DESC, id DESC").Limit(maxAPIKeyRows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ApiKey, len(rows))
	for i := range rows {
		out[i] = apiKeyModel(rows[i])
	}
	return out, nil
}
func (r *BunAPIKeyRepository) GetByID(ctx context.Context, id string) (models.ApiKey, error) {
	if err := r.open(); err != nil {
		return models.ApiKey{}, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return models.ApiKey{}, e
	}
	var row apiKeyRow
	if e = r.db.NewSelect().Model(&row).Where("id = ?", id).Scan(ctx); e != nil {
		return models.ApiKey{}, e
	}
	return apiKeyModel(row), nil
}
func (r *BunAPIKeyRepository) GetBySecret(ctx context.Context, key string) (models.ApiKey, error) {
	if err := r.open(); err != nil {
		return models.ApiKey{}, err
	}
	if err := secret(key); err != nil {
		return models.ApiKey{}, err
	}
	var row apiKeyRow
	err := r.db.NewRaw(`SELECT id,name,key_prefix,active,rate_limit_rpm,daily_token_limit,monthly_token_limit,one_time_token_limit,one_time_tokens_used,quote_big_text,quote_sub_text,quote_body,max_concurrent_requests,provider_allowlist,model_allowlist,model_denylist,disable_remote_mapping,last_used_at,created_at,revoked_at FROM api_keys WHERE key = ?`, key).Scan(ctx, &row)
	if err != nil {
		return models.ApiKey{}, err
	}
	return apiKeyModel(row), nil
}
func (r *BunAPIKeyRepository) Credential(ctx context.Context, id string) (string, error) {
	if err := r.open(); err != nil {
		return "", err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return "", e
	}
	var row struct {
		Key string `bun:"key"`
	}
	if e = r.db.NewSelect().Model(&row).Column("key").Where("id = ?", id).Scan(ctx); e != nil {
		return "", e
	}
	return row.Key, nil
}

func (r *BunAPIKeyRepository) Create(ctx context.Context, v models.ApiKeyCreateInput) (models.ApiKey, error) {
	if err := r.open(); err != nil {
		return models.ApiKey{}, err
	}
	id, e := keyID(v.ID)
	if e != nil {
		return models.ApiKey{}, e
	}
	if strings.TrimSpace(v.Name) == "" || len(v.Name) > maxAPIKeyID {
		return models.ApiKey{}, errors.New("api key: name is required and bounded")
	}
	if e = secret(v.Key); e != nil {
		return models.ApiKey{}, e
	}
	if e = limits(v.RateLimitRpm, v.DailyTokenLimit, v.MonthlyTokenLimit, v.OneTimeTokenLimit, v.MaxConcurrentRequests); e != nil {
		return models.ApiKey{}, e
	}
	prefix := v.KeyPrefix
	if prefix == "" {
		prefix = v.Key
		if len(prefix) > 12 {
			prefix = prefix[:12]
		}
	}
	if len(prefix) > maxAPIKeyID || len(v.ProviderAllowlist) > maxAPIKeyText || len(v.ModelAllowlist) > maxAPIKeyText || len(v.ModelDenylist) > maxAPIKeyText {
		return models.ApiKey{}, errors.New("api key: text is bounded")
	}
	_, e = r.db.NewRaw(`INSERT INTO api_keys(id,name,key,key_prefix,active,rate_limit_rpm,daily_token_limit,monthly_token_limit,one_time_token_limit,max_concurrent_requests,provider_allowlist,model_allowlist,model_denylist,disable_remote_mapping,created_at) VALUES(?,?,?,?,TRUE,?,?,?,?,?,?,?,?,?,?)`, id, v.Name, v.Key, prefix, v.RateLimitRpm, v.DailyTokenLimit, v.MonthlyTokenLimit, v.OneTimeTokenLimit, v.MaxConcurrentRequests, nilText(v.ProviderAllowlist), nilText(v.ModelAllowlist), nilText(v.ModelDenylist), v.DisableRemoteMapping, time.Now().UTC()).Exec(ctx)
	if e != nil {
		return models.ApiKey{}, e
	}
	return r.GetByID(ctx, id)
}
func nilText(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func (r *BunAPIKeyRepository) Patch(ctx context.Context, id string, p models.ApiKeyPatchInput) (models.ApiKey, error) {
	if err := r.open(); err != nil {
		return models.ApiKey{}, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return models.ApiKey{}, e
	}
	if p.Name != nil && (strings.TrimSpace(*p.Name) == "" || len(*p.Name) > maxAPIKeyID) {
		return models.ApiKey{}, errors.New("api key: name is required and bounded")
	}
	if p.Key != nil {
		if e = secret(*p.Key); e != nil {
			return models.ApiKey{}, e
		}
	}
	if p.QuoteBigText != nil && len(*p.QuoteBigText) > maxAPIKeyText || p.QuoteSubText != nil && len(*p.QuoteSubText) > maxAPIKeyText || p.QuoteBody != nil && len(*p.QuoteBody) > maxAPIKeyText || p.ProviderAllowlist != nil && len(*p.ProviderAllowlist) > maxAPIKeyText || p.ModelAllowlist != nil && len(*p.ModelAllowlist) > maxAPIKeyText || p.ModelDenylist != nil && len(*p.ModelDenylist) > maxAPIKeyText {
		return models.ApiKey{}, errors.New("api key: text is bounded")
	}
	if e = limits(p.RateLimitRpm, p.DailyTokenLimit, p.MonthlyTokenLimit, p.OneTimeTokenLimit, p.MaxConcurrentRequests); e != nil {
		return models.ApiKey{}, e
	}
	fields := []string{}
	args := []any{}
	add := func(f string, v any) { fields = append(fields, f+" = ?"); args = append(args, v) }
	if p.Name != nil {
		add("name", *p.Name)
	}
	if p.Key != nil {
		prefix := *p.Key
		if len(prefix) > 12 {
			prefix = prefix[:12]
		}
		fields = append(fields, "key = ?", "key_prefix = ?", "active = TRUE", "revoked_at = NULL")
		args = append(args, *p.Key, prefix)
	}
	if p.RateLimitRpm != nil {
		add("rate_limit_rpm", *p.RateLimitRpm)
	}
	if p.DailyTokenLimit != nil {
		add("daily_token_limit", *p.DailyTokenLimit)
	}
	if p.MonthlyTokenLimit != nil {
		add("monthly_token_limit", *p.MonthlyTokenLimit)
	}
	if p.OneTimeTokenLimit != nil {
		add("one_time_token_limit", *p.OneTimeTokenLimit)
	}
	if p.QuoteBigText != nil {
		add("quote_big_text", *p.QuoteBigText)
	}
	if p.QuoteSubText != nil {
		add("quote_sub_text", *p.QuoteSubText)
	}
	if p.QuoteBody != nil {
		add("quote_body", *p.QuoteBody)
	}
	if p.MaxConcurrentRequests != nil {
		add("max_concurrent_requests", *p.MaxConcurrentRequests)
	}
	if p.ProviderAllowlist != nil {
		add("provider_allowlist", nilText(*p.ProviderAllowlist))
	}
	if p.ModelAllowlist != nil {
		add("model_allowlist", nilText(*p.ModelAllowlist))
	}
	if p.ModelDenylist != nil {
		add("model_denylist", nilText(*p.ModelDenylist))
	}
	if p.DisableRemoteMapping != nil {
		add("disable_remote_mapping", *p.DisableRemoteMapping)
	}
	if p.Active != nil {
		add("active", *p.Active)
	}
	if len(fields) > 0 {
		args = append(args, id)
		if _, e = r.db.NewRaw("UPDATE api_keys SET "+strings.Join(fields, ", ")+" WHERE id = ?", args...).Exec(ctx); e != nil {
			return models.ApiKey{}, e
		}
	}
	return r.GetByID(ctx, id)
}
func (r *BunAPIKeyRepository) Revoke(ctx context.Context, id string) (bool, error) {
	if err := r.open(); err != nil {
		return false, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return false, e
	}
	res, e := r.db.NewRaw(`UPDATE api_keys SET active=FALSE,revoked_at=NOW() WHERE id=? AND revoked_at IS NULL`, id).Exec(ctx)
	if e != nil {
		return false, e
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
func (r *BunAPIKeyRepository) Delete(ctx context.Context, id string) (bool, error) {
	if err := r.open(); err != nil {
		return false, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return false, e
	}
	res, e := r.db.NewRaw(`DELETE FROM api_keys WHERE id=?`, id).Exec(ctx)
	if e != nil {
		return false, e
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
	}
	return n > 0, nil
}
func (r *BunAPIKeyRepository) Touch(ctx context.Context, id string) error {
	if err := r.open(); err != nil {
		return err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return e
	}
	r.mu.Lock()
	if r.pending == nil {
		r.pending = make(map[string]struct{})
	}
	r.pending[id] = struct{}{}
	flush := len(r.pending) >= 200
	r.mu.Unlock()
	if flush {
		return r.FlushTouches(ctx)
	}
	return nil
}
func (r *BunAPIKeyRepository) FlushTouches(ctx context.Context) error {
	if err := r.open(); err != nil {
		return err
	}
	r.mu.Lock()
	ids := make([]string, 0, len(r.pending))
	for id := range r.pending {
		ids = append(ids, id)
	}
	r.pending = make(map[string]struct{})
	r.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	_, e := r.db.NewRaw(`UPDATE api_keys SET last_used_at=NOW() WHERE id IN (?)`, bun.In(ids)).Exec(ctx)
	if e != nil {
		r.mu.Lock()
		for _, id := range ids {
			r.pending[id] = struct{}{}
		}
		r.mu.Unlock()
	}
	return e
}

func (r *BunAPIKeyRepository) CreateShareLink(ctx context.Context, v models.ShareLink) (models.ShareLink, error) {
	if err := r.open(); err != nil {
		return models.ShareLink{}, err
	}
	if _, e := keyID(v.ID); e != nil {
		return models.ShareLink{}, e
	}
	if _, e := keyID(v.APIKeyID); e != nil {
		return models.ShareLink{}, e
	}
	if strings.TrimSpace(v.TokenHash) == "" || len(v.TokenHash) > maxAPIKeyID {
		return models.ShareLink{}, errors.New("share link: token hash is required and bounded")
	}
	if strings.TrimSpace(v.Kind) == "" || len(v.Kind) > 64 {
		return models.ShareLink{}, errors.New("share link: kind is required and bounded")
	}
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now().UTC()
	}
	_, e := r.db.NewRaw(`INSERT INTO share_links(id,api_key_id,token_hash,kind,active,created_at,expires_at,used_at,last_viewed_at) VALUES(?,?,?,?,?,?,?,?,?)`, v.ID, v.APIKeyID, v.TokenHash, v.Kind, v.Active, v.CreatedAt, v.ExpiresAt, v.UsedAt, v.LastViewedAt).Exec(ctx)
	if e != nil {
		return models.ShareLink{}, e
	}
	return r.getShare(ctx, v.ID)
}
func (r *BunAPIKeyRepository) getShare(ctx context.Context, id string) (models.ShareLink, error) {
	var v shareLinkRow
	e := r.db.NewSelect().Model(&v).Where("id=?", id).Scan(ctx)
	return shareModel(v), e
}
func (r *BunAPIKeyRepository) GetShareLinkByTokenHash(ctx context.Context, h string) (models.ShareLink, error) {
	if err := r.open(); err != nil {
		return models.ShareLink{}, err
	}
	h = strings.TrimSpace(h)
	if h == "" || len(h) > maxAPIKeyID {
		return models.ShareLink{}, errors.New("share link: token hash is required and bounded")
	}
	var v shareLinkRow
	e := r.db.NewSelect().Model(&v).Where("token_hash=?", h).Scan(ctx)
	return shareModel(v), e
}
func (r *BunAPIKeyRepository) ListShareLinksByAPIKey(ctx context.Context, id string) ([]models.ShareLink, error) {
	if err := r.open(); err != nil {
		return nil, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return nil, e
	}
	rows := []shareLinkRow{}
	if e = r.db.NewSelect().Model(&rows).Where("api_key_id=?", id).OrderExpr("created_at DESC, id DESC").Limit(maxShareRows).Scan(ctx); e != nil {
		return nil, e
	}
	out := make([]models.ShareLink, len(rows))
	for i := range rows {
		out[i] = shareModel(rows[i])
	}
	return out, nil
}
func (r *BunAPIKeyRepository) PatchShareLinkActive(ctx context.Context, id string, active bool) (models.ShareLink, error) {
	if err := r.open(); err != nil {
		return models.ShareLink{}, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return models.ShareLink{}, e
	}
	if _, e = r.db.NewRaw(`UPDATE share_links SET active=? WHERE id=?`, active, id).Exec(ctx); e != nil {
		return models.ShareLink{}, e
	}
	return r.getShare(ctx, id)
}
func (r *BunAPIKeyRepository) ConsumeSetupShareLink(ctx context.Context, id, now string) (models.ShareLink, error) {
	if err := r.open(); err != nil {
		return models.ShareLink{}, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return models.ShareLink{}, e
	}
	now = strings.TrimSpace(now)
	if now == "" || len(now) > maxAPIKeyID {
		return models.ShareLink{}, errors.New("share link: timestamp is required and bounded")
	}
	var v shareLinkRow
	e = r.db.NewRaw(`UPDATE share_links SET active=FALSE,used_at=? WHERE id=? AND kind='setup' AND active=TRUE AND used_at IS NULL AND (expires_at IS NULL OR expires_at>?) RETURNING id,api_key_id,token_hash,kind,active,created_at,expires_at,used_at,last_viewed_at`, now, id, now).Scan(ctx, &v)
	return shareModel(v), e
}
func (r *BunAPIKeyRepository) TouchShareLink(ctx context.Context, id string) error {
	if err := r.open(); err != nil {
		return err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return e
	}
	_, e = r.db.NewRaw(`UPDATE share_links SET last_viewed_at=NOW() WHERE id=?`, id).Exec(ctx)
	return e
}
func (r *BunAPIKeyRepository) DeleteShareLink(ctx context.Context, id string) (bool, error) {
	if err := r.open(); err != nil {
		return false, err
	}
	var e error
	id, e = keyID(id)
	if e != nil {
		return false, e
	}
	res, e := r.db.NewRaw(`DELETE FROM share_links WHERE id=?`, id).Exec(ctx)
	if e != nil {
		return false, e
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

var _ APIKeyRepository = (*BunAPIKeyRepository)(nil)
