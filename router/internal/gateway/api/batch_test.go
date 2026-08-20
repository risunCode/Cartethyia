package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cartethyia/daemon/internal/router/batch"
)

type batchRouteService struct {
	submitted bool
}

func (s *batchRouteService) Submit(context.Context, batch.Group) (batch.Job, error) {
	s.submitted = true
	return batch.Job{ID: "job-1", State: batch.StateQueued, ItemCount: 1}, nil
}
func (*batchRouteService) Get(context.Context, string) (batch.Job, []batch.Item, error) {
	return batch.Job{ID: "job-1", State: batch.StateRunning, ItemCount: 1}, []batch.Item{{ID: "item-1", JobID: "job-1", Position: 0, State: batch.ItemQueued}}, nil
}
func (*batchRouteService) List(context.Context, batch.State, int) ([]batch.Job, error) {
	return []batch.Job{{ID: "job-1", State: batch.StateQueued, ItemCount: 1}}, nil
}
func (*batchRouteService) Cancel(context.Context, string) (batch.Job, error) {
	return batch.Job{ID: "job-1", State: batch.StateCancelled, ItemCount: 1}, nil
}
func (*batchRouteService) Progress(context.Context, string) (batch.Progress, error) {
	return batch.Progress{Job: batch.Job{ID: "job-1"}, State: batch.StateRunning, Total: 1, Queued: 1}, nil
}

func TestBatchRoutesUseServiceLifecycle(t *testing.T) {
	service := &batchRouteService{}
	mux := http.NewServeMux()
	RegisterV1(mux, Deps{Batch: service})
	req := httptest.NewRequest(http.MethodPost, BatchesPath, strings.NewReader(`{"key":{"providerId":"p","model":"m","surface":"openai-chat","capabilityVersion":1,"catalogGeneration":1},"items":[{"id":"item-1","requestId":"req-1"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted || !service.submitted {
		t.Fatalf("submit status=%d submitted=%v body=%s", rec.Code, service.submitted, rec.Body.String())
	}
	for _, path := range []string{BatchesPath, BatchesPath + "/job-1", BatchesPath + "/job-1/cancel", BatchesPath + "/job-1/progress"} {
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
