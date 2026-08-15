package observability

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestTask22MetricsConcurrentRecordAndRenderStayBounded(t *testing.T) {
	registry := NewRegistry()
	ctx := context.Background()
	var wg sync.WaitGroup
	for worker := range 16 {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for iteration := range 64 {
				_ = registry.RecordEvent(ctx, RequestEvent{Stage: StageCacheLookup, Surface: SurfaceHTTP, Provider: "fixture-provider", Model: "fixture-model", CacheKind: CacheKindResolutionMemory, CacheHit: iteration%2 == worker%2})
				if iteration%8 == 0 {
					recorder := httptest.NewRecorder()
					registry.ServeHTTP(recorder)
					if recorder.Code != 200 {
						t.Errorf("metrics status=%d", recorder.Code)
					}
				}
			}
		}(worker)
	}
	wg.Wait()
	recorder := httptest.NewRecorder()
	registry.ServeHTTP(recorder)
	body := recorder.Body.String()
	if len(body) > 256*1024 {
		t.Fatalf("metrics output exceeded bound: %d", len(body))
	}
	for _, forbidden := range []string{"request_id", "trace_id", "fixture-secret", "Bearer", "prompt-content", "digest="} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("metrics leaked forbidden sentinel %q", forbidden)
		}
	}
}
