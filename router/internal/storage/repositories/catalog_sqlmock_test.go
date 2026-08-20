package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/storage/models"
)

func catalogAliasCols() []string {
	return []string{"alias", "model", "created_at"}
}

func catalogComboCols() []string {
	return []string{"id", "name", "models_json", "strategy", "sticky_limit", "created_at", "updated_at"}
}

func catalogProviderModelCols() []string {
	return []string{"provider", "model_id", "enabled", "source", "created_at", "updated_at"}
}

func TestCatalogSQLMockCRUD(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	t.Run("aliases", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunCatalogRepository(db)
		expectAnyQueryRows(mock, catalogAliasCols(), []any{"fast", "gpt-4o-mini", now})
		got, err := repo.ListAliases(ctx)
		if err != nil || len(got) != 1 || got[0].Alias != "fast" {
			t.Fatalf("ListAliases = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		if err := repo.PutAlias(ctx, models.ModelAlias{Alias: "fast", Model: "gpt-4o-mini"}); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := repo.DeleteAlias(ctx, "fast"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("combos", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunCatalogRepository(db)
		expectAnyQueryRows(mock, catalogComboCols(), []any{"c1", "combo", []byte(`["m1"]`), "round_robin", 2, now, now})
		got, err := repo.ListCombos(ctx)
		if err != nil || len(got) != 1 || got[0].ID != "c1" {
			t.Fatalf("ListCombos = %#v err=%v", got, err)
		}
		expectAnyExec(mock, nil)
		if err := repo.PutCombo(ctx, models.Combo{ID: "c1", Name: "combo", Models: []string{"m1"}, Strategy: "round_robin", StickyLimit: 2}); err != nil {
			t.Fatal(err)
		}
		expectAnyExec(mock, nil)
		if err := repo.DeleteCombo(ctx, "c1"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("provider models", func(t *testing.T) {
		db, mock := newFakeBun(t)
		repo := NewBunCatalogRepository(db)
		expectAnyQueryRows(mock, catalogProviderModelCols(), []any{"openai", "gpt-4o-mini", true, "builtin", now, now})
		got, err := repo.ListProviderModels(ctx, "openai")
		if err != nil || len(got) != 1 || got[0].ModelID != "gpt-4o-mini" {
			t.Fatalf("ListProviderModels = %#v err=%v", got, err)
		}
	})

	t.Run("db error", func(t *testing.T) {
		db, mock := newFakeBun(t)
		expectAnyQueryErr(mock, errors.New("db down"))
		if _, err := NewBunCatalogRepository(db).ListAliases(ctx); err == nil {
			t.Fatal("expected list error")
		}
	})
}
