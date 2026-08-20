package repositories

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/batch"
)

func TestBunBatchRepositoryClosed(t *testing.T) {
	var repo *BunBatchRepository
	if _, err := repo.GetJob(context.Background(), "job"); !errors.Is(err, ErrRepositoryClosed) {
		t.Fatalf("GetJob(nil) error = %v", err)
	}
}

func TestNewBunBatchRepository(t *testing.T) {
	db, _ := newFakeBun(t)
	repo := NewBunBatchRepository(db)
	if repo == nil || repo.db != db {
		t.Fatalf("batch repository = %#v", repo)
	}
	if NewBunBatchRepository(nil).db != nil {
		t.Fatal("nil database should remain an empty handle")
	}
}

func TestBatchJobRowModelPreservesGroupingAndFailure(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	reason := "provider unavailable"
	got, err := (batchJobRow{
		ID: "job-1", ProviderID: "openai", CapabilityVersion: 2, Model: "gpt",
		Surface: string(protocol.SurfaceOpenAIResponses), Endpoint: "/v1/responses",
		CatalogGeneration: 9, State: string(batch.StateFailed), FailureReason: &reason,
		ItemCount: 2, Progress: 50, CreatedAt: now, ExpiresAt: now.Add(time.Hour), UpdatedAt: now,
	}).model()
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "job-1" || got.Key.Model != "gpt" || got.Key.Surface != protocol.SurfaceOpenAIResponses ||
		got.State != batch.StateFailed || got.Failure == nil || got.Failure.Reason != reason || got.Progress != 50 {
		t.Fatalf("row projection = %#v", got)
	}
}

func TestBatchItemRowModelDecodesPartialResult(t *testing.T) {
	got, err := (batchItemRow{
		ID: "item-1", JobID: "job-1", Position: 0, RequestID: "request-1",
		State: string(batch.ItemCompleted), Progress: 100,
		ResultJSON: []byte(`{"itemid":"item-1","state":"completed","error":"","response":{"ok":true}}`),
	}).model()
	if err != nil {
		t.Fatal(err)
	}
	if got.Result == nil || got.Result.ItemID != "item-1" || got.Result.State != batch.ItemCompleted {
		t.Fatalf("item result = %#v", got.Result)
	}
}
