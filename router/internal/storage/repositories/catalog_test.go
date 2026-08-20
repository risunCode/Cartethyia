package repositories

import (
	"context"
	"github.com/cartethyia/daemon/internal/storage/models"
	"testing"
)

func TestCatalogRepositoryRequiresDatabase(t *testing.T) {
	var r *BunCatalogRepository
	if _, err := r.ListAliases(context.Background()); err == nil {
		t.Fatal("nil repository accepted")
	}
	if err := r.PutAlias(context.Background(), models.ModelAlias{Alias: "x", Model: "y"}); err == nil {
		t.Fatal("nil write accepted")
	}
}
