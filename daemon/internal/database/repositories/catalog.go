package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/cartethyia/daemon/internal/database/models"
	"github.com/uptrace/bun"
	"time"
)

var ErrRepositoryClosed = errors.New("database repository: closed")

type CatalogRepository interface {
	ListAliases(context.Context) ([]models.ModelAlias, error)
	ListCombos(context.Context) ([]models.Combo, error)
	ListProviderModels(context.Context, string) ([]models.ProviderModel, error)
	PutAlias(context.Context, models.ModelAlias) error
	PutCombo(context.Context, models.Combo) error
	DeleteAlias(context.Context, string) error
	DeleteCombo(context.Context, string) error
}
type BunCatalogRepository struct{ db *bun.DB }

func NewBunCatalogRepository(db *bun.DB) *BunCatalogRepository { return &BunCatalogRepository{db: db} }

type aliasRow struct {
	bun.BaseModel `bun:"table:model_aliases"`
	Alias         string    `bun:"alias"`
	Model         string    `bun:"model"`
	CreatedAt     time.Time `bun:"created_at"`
}

type comboRow struct {
	bun.BaseModel `bun:"table:combos"`
	ID            string    `bun:"id"`
	Name          string    `bun:"name"`
	ModelsJSON    []byte    `bun:"models_json,type:jsonb"`
	Strategy      string    `bun:"strategy"`
	StickyLimit   int       `bun:"sticky_limit"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

type providerModelRow struct {
	bun.BaseModel `bun:"table:provider_models"`
	Provider      string    `bun:"provider"`
	ModelID       string    `bun:"model_id"`
	Enabled       bool      `bun:"enabled"`
	Source        string    `bun:"source"`
	CreatedAt     time.Time `bun:"created_at"`
	UpdatedAt     time.Time `bun:"updated_at"`
}

func (r *BunCatalogRepository) ListAliases(ctx context.Context) ([]models.ModelAlias, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []aliasRow{}
	if err := r.db.NewSelect().Model(&rows).Order("alias ASC").Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ModelAlias, len(rows))
	for i, v := range rows {
		out[i] = models.ModelAlias{Alias: v.Alias, Model: v.Model, CreatedAt: v.CreatedAt}
	}
	return out, nil
}
func (r *BunCatalogRepository) ListCombos(ctx context.Context) ([]models.Combo, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []comboRow{}
	if err := r.db.NewSelect().Model(&rows).Order("id ASC").Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.Combo, len(rows))
	for i, v := range rows {
		var modelsList []string
		if err := json.Unmarshal(v.ModelsJSON, &modelsList); err != nil {
			return nil, err
		}
		out[i] = models.Combo{ID: v.ID, Name: v.Name, Models: modelsList, Strategy: v.Strategy, StickyLimit: v.StickyLimit, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	}
	return out, nil
}
func (r *BunCatalogRepository) ListProviderModels(ctx context.Context, provider string) ([]models.ProviderModel, error) {
	if r == nil || r.db == nil {
		return nil, ErrRepositoryClosed
	}
	rows := []providerModelRow{}
	q := r.db.NewSelect().Model(&rows).Order("model_id ASC")
	if provider != "" {
		q.Where("provider = ?", provider)
	}
	if err := q.Scan(ctx); err != nil {
		return nil, err
	}
	out := make([]models.ProviderModel, len(rows))
	for i, v := range rows {
		out[i] = models.ProviderModel{Provider: v.Provider, ModelID: v.ModelID, Enabled: v.Enabled, Source: v.Source, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
	}
	return out, nil
}
func (r *BunCatalogRepository) PutAlias(ctx context.Context, v models.ModelAlias) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now().UTC()
	}
	_, err := r.db.NewRaw(`INSERT INTO model_aliases(alias,model,created_at) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET model=EXCLUDED.model`, v.Alias, v.Model, v.CreatedAt).Exec(ctx)
	return err
}
func (r *BunCatalogRepository) PutCombo(ctx context.Context, v models.Combo) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	if v.CreatedAt.IsZero() {
		v.CreatedAt = time.Now().UTC()
	}
	if v.UpdatedAt.IsZero() {
		v.UpdatedAt = v.CreatedAt
	}
	raw, err := json.Marshal(v.Models)
	if err != nil {
		return err
	}
	_, err = r.db.NewRaw(`INSERT INTO combos(id,name,models_json,strategy,sticky_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,models_json=EXCLUDED.models_json,strategy=EXCLUDED.strategy,sticky_limit=EXCLUDED.sticky_limit,updated_at=EXCLUDED.updated_at`, v.ID, v.Name, raw, v.Strategy, v.StickyLimit, v.CreatedAt, v.UpdatedAt).Exec(ctx)
	return err
}
func (r *BunCatalogRepository) DeleteAlias(ctx context.Context, id string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	_, err := r.db.NewRaw(`DELETE FROM model_aliases WHERE alias = ?`, id).Exec(ctx)
	return err
}
func (r *BunCatalogRepository) DeleteCombo(ctx context.Context, id string) error {
	if r == nil || r.db == nil {
		return ErrRepositoryClosed
	}
	_, err := r.db.NewRaw(`DELETE FROM combos WHERE id = ?`, id).Exec(ctx)
	return err
}
