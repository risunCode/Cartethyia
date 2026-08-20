package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/router/batch"
)

type consoleBatchRouteService struct{}

func (consoleBatchRouteService) Submit(context.Context, batch.Group) (batch.Job, error) {
	return batch.Job{ID: "job-1", State: batch.StateQueued, ItemCount: 1}, nil
}
func (consoleBatchRouteService) Get(context.Context, string) (batch.Job, []batch.Item, error) {
	return batch.Job{ID: "job-1", State: batch.StateRunning, ItemCount: 1}, []batch.Item{{ID: "item-1", JobID: "job-1", Position: 0, State: batch.ItemQueued}}, nil
}
func (consoleBatchRouteService) List(context.Context, batch.State, int) ([]batch.Job, error) {
	return []batch.Job{{ID: "job-1", State: batch.StateQueued, ItemCount: 1}}, nil
}
func (consoleBatchRouteService) Cancel(context.Context, string) (batch.Job, error) {
	return batch.Job{ID: "job-1", State: batch.StateCancelled, ItemCount: 1}, nil
}
func (consoleBatchRouteService) Progress(context.Context, string) (batch.Progress, error) {
	return batch.Progress{Job: batch.Job{ID: "job-1"}, State: batch.StateRunning, Total: 1, Queued: 1}, nil
}

func TestConsoleBatchRoutesUseServiceLifecycle(t *testing.T) {
	mux := http.NewServeMux()
	RegisterBatches(mux, Services{Batch: consoleBatchRouteService{}})
	req := httptest.NewRequest(http.MethodPost, ConsoleBatchesPath, strings.NewReader(`{"key":{"providerId":"p","model":"m","surface":"openai-chat","capabilityVersion":1,"catalogGeneration":1},"items":[{"id":"item-1","requestId":"req-1"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("submit status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{ConsoleBatchesPath, ConsoleBatchesPath + "/job-1", ConsoleBatchesPath + "/job-1/cancel", ConsoleBatchesPath + "/job-1/progress"} {
		method := http.MethodGet
		if strings.HasSuffix(path, "/cancel") {
			method = http.MethodPost
		}
		rec = httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		if rec.Code == http.StatusNotFound {
			t.Fatalf("%s %s was not registered", method, path)
		}
	}
}
