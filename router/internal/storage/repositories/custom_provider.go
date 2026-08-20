package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
	"github.com/uptrace/bun"
)

// CustomProviderRepository owns durable user-defined provider endpoints. It is
// intentionally separate from the built-in provider registry: rows are data
// that can be loaded and materialized at runtime, not handwritten providers.
type CustomProviderRepository interface {
	ListCustomProviders(context.Context) ([]models.CustomProvider, error)
	GetCustomProvider(context.Context, string) (models.CustomProvider, error)
	GetCustomProviderBySlug(context.Context, string) (models.CustomProvider, error)
	UpsertCustomProvider(context.Context, models.CustomProvider) (models.CustomProvider, error)
	DeleteCustomProvider(context.Context, string) (bool, error)
}

// BunCustomProviderRepository persists custom provider definitions in
// custom_providers. CredentialRef remains opaque; this repository never reads
// or writes credential material.
type BunCustomProviderRepository struct {
	db *bun.DB
}

// NewBunCustomProviderRepository creates a database-backed custom provider
// repository.
func NewBunCustomProviderRepository(db *bun.DB) *BunCustomProviderRepository {
	return &BunCustomProviderRepository{db: db}
}

type customProviderRow struct {
	ID             string    `bun:"id"`
	Slug           string    `bun:"slug"`
	Name           string    `bun:"name"`
	Type           string    `bun:"type"`
	Protocol       string    `bun:"protocol"`
	Surface        string    `bun:"surface"`
	BaseURL        string    `bun:"base_url"`
	CredentialRef  string    `bun:"credential_ref"`
	CredentialRefs []byte    `bun:"credential_refs_json,type:jsonb"`
	TimeoutSeconds int       `bun:"timeout_seconds"`
	ModelsJSON     []byte    `bun:"models_json,type:jsonb"`
	HeadersJSON    []byte    `bun:"headers_json,type:jsonb"`
	CreatedAt      time.Time `bun:"created_at"`
	UpdatedAt      time.Time `bun:"updated_at"`
}

func (r customProviderRow) model() models.CustomProvider {
	refs := []string{}
	if len(r.CredentialRefs) > 0 && string(r.CredentialRefs) != "null" {
		_ = json.Unmarshal(r.CredentialRefs, &refs)
	}
	if len(refs) == 0 && r.CredentialRef != "" {
		refs = []string{r.CredentialRef}
	}
	return models.CustomProvider{
		ID: r.ID, Slug: r.Slug, Name: r.Name, Type: r.Type, Protocol: r.Protocol, Surface: r.Surface, BaseURL: r.BaseURL,
		CredentialRef: r.CredentialRef, CredentialRefs: refs, TimeoutSeconds: r.TimeoutSeconds,
		Models: append([]byte(nil), r.ModelsJSON...), CustomHeaders: append([]byte(nil), r.HeadersJSON...),
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func customProviderValues(provider models.CustomProvider) (models.CustomProvider, error) {
	provider.ID = strings.TrimSpace(provider.ID)
	provider.Slug = strings.TrimSpace(provider.Slug)
	provider.Name = strings.TrimSpace(provider.Name)
	provider.Type = strings.TrimSpace(provider.Type)
	provider.Protocol = strings.TrimSpace(provider.Protocol)
	provider.Surface = strings.TrimSpace(provider.Surface)
	provider.BaseURL = strings.TrimRight(strings.TrimSpace(provider.BaseURL), "/")
	provider.CredentialRef = strings.TrimSpace(provider.CredentialRef)
	if provider.ID == "" || provider.Slug == "" || provider.Name == "" || provider.BaseURL == "" {
		return models.CustomProvider{}, errors.New("custom provider id, slug, name, and base_url are required")
	}
	if provider.Protocol == "" {
		if provider.Type == "anthropic-compatible" || provider.Type == "anthropic" {
			provider.Protocol = "anthropic"
		} else {
			provider.Protocol = "openai"
		}
	}
	if provider.Surface == "" {
		if provider.Protocol == "anthropic" {
			provider.Surface = "anthropic-messages"
		} else {
			provider.Surface = "openai-chat"
		}
	}
	if provider.Type != "openai-compatible" && provider.Type != "anthropic-compatible" && provider.Type != "openai" && provider.Type != "anthropic" {
		return models.CustomProvider{}, fmt.Errorf("unsupported custom provider type %q", provider.Type)
	}
	if (provider.Protocol == "openai" && provider.Surface != "openai-chat" && provider.Surface != "openai-responses") || (provider.Protocol == "anthropic" && provider.Surface != "anthropic-messages") {
		return models.CustomProvider{}, fmt.Errorf("unsupported custom provider protocol/surface %q/%q", provider.Protocol, provider.Surface)
	}
	if provider.CredentialRef == "" {
		if len(provider.CredentialRefs) > 0 {
			provider.CredentialRef = strings.TrimSpace(provider.CredentialRefs[0])
		}
	}
	if provider.CredentialRef == "" {
		return models.CustomProvider{}, errors.New("custom provider credential_ref is required")
	}
	refs := make([]string, 0, len(provider.CredentialRefs)+1)
	for _, ref := range append([]string{provider.CredentialRef}, provider.CredentialRefs...) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		seen := false
		for _, existing := range refs {
			if existing == ref {
				seen = true
				break
			}
		}
		if !seen {
			refs = append(refs, ref)
		}
	}
	provider.CredentialRefs = refs
	if provider.TimeoutSeconds <= 0 {
		provider.TimeoutSeconds = 30
	}
	if len(provider.Models) == 0 {
		provider.Models = []byte("[]")
	}
	if len(provider.CustomHeaders) == 0 {
		provider.CustomHeaders = []byte("{}")
	}
	if provider.CreatedAt.IsZero() {
		provider.CreatedAt = time.Now().UTC()
	}
	provider.UpdatedAt = time.Now().UTC()
	return provider, nil
}

// ListCustomProviders returns providers in stable slug order.
func (r *BunCustomProviderRepository) ListCustomProviders(ctx context.Context) ([]models.CustomProvider, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []customProviderRow{}
	if err := r.db.NewSelect().TableExpr("custom_providers").Order("slug ASC").Scan(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]models.CustomProvider, len(rows))
	for i, row := range rows {
		out[i] = row.model()
	}
	return out, nil
}

// GetCustomProvider returns one provider by durable ID.
func (r *BunCustomProviderRepository) GetCustomProvider(ctx context.Context, id string) (models.CustomProvider, error) {
	if r == nil || r.db == nil {
		return models.CustomProvider{}, ErrRepositoryClosed
	}
	var row customProviderRow
	if err := r.db.NewSelect().TableExpr("custom_providers").Where("id = ?", strings.TrimSpace(id)).Scan(ctx, &row); err != nil {
		return models.CustomProvider{}, err
	}
	return row.model(), nil
}

// GetCustomProviderBySlug returns one provider by client-facing slug.
func (r *BunCustomProviderRepository) GetCustomProviderBySlug(ctx context.Context, slug string) (models.CustomProvider, error) {
	if r == nil || r.db == nil {
		return models.CustomProvider{}, ErrRepositoryClosed
	}
	var row customProviderRow
	if err := r.db.NewSelect().TableExpr("custom_providers").Where("slug = ?", strings.TrimSpace(slug)).Scan(ctx, &row); err != nil {
		return models.CustomProvider{}, err
	}
	return row.model(), nil
}

// UpsertCustomProvider validates and atomically replaces one provider row.
func (r *BunCustomProviderRepository) UpsertCustomProvider(ctx context.Context, provider models.CustomProvider) (models.CustomProvider, error) {
	if r == nil || r.db == nil {
		return models.CustomProvider{}, ErrRepositoryClosed
	}
	provider, err := customProviderValues(provider)
	if err != nil {
		return models.CustomProvider{}, err
	}
	credentialRefsJSON, err := json.Marshal(provider.CredentialRefs)
	if err != nil {
		return models.CustomProvider{}, err
	}
	_, err = r.db.NewRaw(`
INSERT INTO custom_providers
(id, slug, name, type, protocol, surface, base_url, credential_ref, credential_refs_json, timeout_seconds, models_json, headers_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
slug = EXCLUDED.slug,
name = EXCLUDED.name,
type = EXCLUDED.type,
protocol = EXCLUDED.protocol,
surface = EXCLUDED.surface,
base_url = EXCLUDED.base_url,
credential_ref = EXCLUDED.credential_ref,
credential_refs_json = EXCLUDED.credential_refs_json,
timeout_seconds = EXCLUDED.timeout_seconds,
models_json = EXCLUDED.models_json,
headers_json = EXCLUDED.headers_json,
updated_at = EXCLUDED.updated_at`,
		provider.ID, provider.Slug, provider.Name, provider.Type, provider.Protocol, provider.Surface, provider.BaseURL, provider.CredentialRef,
		credentialRefsJSON, provider.TimeoutSeconds, provider.Models, provider.CustomHeaders, provider.CreatedAt, provider.UpdatedAt,
	).Exec(ctx)
	if err != nil {
		return models.CustomProvider{}, err
	}
	return provider, nil
}

// DeleteCustomProvider removes one provider and reports whether it existed.
func (r *BunCustomProviderRepository) DeleteCustomProvider(ctx context.Context, id string) (bool, error) {
	if r == nil || r.db == nil {
		return false, ErrRepositoryClosed
	}
	result, err := r.db.NewRaw(`DELETE FROM custom_providers WHERE id = ?`, strings.TrimSpace(id)).Exec(ctx)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}
