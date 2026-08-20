package load

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/providers"
	"github.com/cartethyia/daemon/internal/router/batch"
)

// nativeScenarioExecutor is a deliberately small native-provider fixture. It
// returns results by durable item ID (and not by input position), which makes
// a positional result bug observable in the root scenario.
type nativeScenarioExecutor struct {
	mu      sync.Mutex
	calls   int
	results map[string]batch.Result
}

// scenarioRestartStore is the durable seam used by this black-box scenario.
// It intentionally stores only batch envelopes and progress, never request
// payloads or credentials. Rehydrating a fresh scheduler through this seam
// catches restart paths that silently drop running work.
type scenarioRestartStore struct {
	groups   map[string]batch.Group
	progress map[string]batch.Progress
}

func newScenarioRestartStore() *scenarioRestartStore {
	return &scenarioRestartStore{
		groups:   make(map[string]batch.Group),
		progress: make(map[string]batch.Progress),
	}
}

func (s *scenarioRestartStore) SaveGroup(group batch.Group) {
	s.groups[group.Job.ID] = group
}

func (s *scenarioRestartStore) LoadGroup(id string) (batch.Group, bool) {
	group, ok := s.groups[id]
	return group, ok
}

func (s *scenarioRestartStore) ListIDs() []string {
	ids := make([]string, 0, len(s.groups))
	for id := range s.groups {
		ids = append(ids, id)
	}
	return ids
}

func (s *scenarioRestartStore) SaveProgress(progress batch.Progress) {
	s.progress[progress.Job.ID] = progress
}

func (s *scenarioRestartStore) LoadProgress(id string) (batch.Progress, bool) {
	progress, ok := s.progress[id]
	return progress, ok
}

func (f *nativeScenarioExecutor) ExecuteBatch(_ context.Context, _ batch.Key, items []batch.Item) (map[string]batch.Result, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	out := make(map[string]batch.Result, len(items))
	for id, result := range f.results {
		out[id] = result
	}
	return out, nil
}

func scenarioBatchKey(model string) batch.Key {
	return batch.Key{
		ProviderID:        "native-fixture",
		CapabilityVersion: 7,
		Model:             model,
		Surface:           protocol.SurfaceOpenAIChat,
		Endpoint:          "/v1/batches",
		AccountScope:      "tenant-a",
		NetworkID:         "network-a",
		ResponseMode:      "json",
		ToolSchemaDigest:  "tools-a",
		PolicyDigest:      "policy-a",
		CatalogGeneration: 11,
		TranslationDigest: "translation-a",
	}
}

func scenarioGroup(id string, key batch.Key, now time.Time, items ...string) batch.Group {
	groupItems := make([]batch.Item, len(items))
	for i, itemID := range items {
		groupItems[i] = batch.Item{
			ID:       itemID,
			JobID:    id,
			Position: i,
			RequestID: fmt.Sprintf("request-%s-%d", id, i),
			State:    batch.ItemQueued,
		}
	}
	return batch.Group{
		Key: key,
		Job: batch.Job{
			ID:        id,
			State:     batch.StateQueued,
			CreatedAt: now,
			ExpiresAt: now.Add(time.Minute),
			ItemCount: len(groupItems),
		},
		Items: groupItems,
	}
}

func TestNativeModelBatchScenarios(t *testing.T) {
	now := time.Date(2026, time.August, 20, 12, 0, 0, 0, time.UTC)

	t.Run("submit progress and compatible grouping", func(t *testing.T) {
		scheduler := batch.NewScheduler(batch.SchedulerConfig{
			MaxJobs:     8,
			MaxItems:    16,
			MaxGroups:   4,
			MaxRunning:  1,
			Now:         func() time.Time { return now },
			Capability:  func(batch.Key) bool { return true },
		})
		compatible := scenarioBatchKey("model-a")
		incompatible := scenarioBatchKey("model-b")
		first := scenarioGroup("job-a", compatible, now, "item-a-0", "item-a-1")
		second := scenarioGroup("job-b", compatible, now, "item-b-0")
		other := scenarioGroup("job-c", incompatible, now, "item-c-0")

		for _, group := range []batch.Group{first, second, other} {
			if err := scheduler.Submit(context.Background(), group); err != nil {
				t.Fatalf("submit %s: %v", group.Job.ID, err)
			}
		}
		initial, err := scheduler.Progress("job-a")
		if err != nil {
			t.Fatalf("progress after submit: %v", err)
		}
		if initial.State != batch.StateQueued || initial.Total != 2 || initial.Queued != 2 || initial.Running != 0 || initial.Completed != 0 || initial.Failed != 0 {
			t.Fatalf("queued progress lost item counts: %+v", initial)
		}

		// Same-key jobs are admitted in the same compatibility bucket, while
		// the model change remains visible at the dequeue boundary.
		got, err := scheduler.Next(context.Background())
		if err != nil {
			t.Fatalf("dequeue first compatible group: %v", err)
		}
		if got.Key != compatible || got.Job.ID != "job-a" {
			t.Fatalf("first group crossed compatibility boundary: %+v", got)
		}
		if err := scheduler.Complete("job-a", []batch.Result{
			{ItemID: "item-a-0", State: batch.ItemCompleted},
			{ItemID: "item-a-1", State: batch.ItemFailed, Error: "provider rejected item"},
		}); err != nil {
			t.Fatalf("complete partial group: %v", err)
		}
		partial, err := scheduler.Progress("job-a")
		if err != nil {
			t.Fatalf("partial progress: %v", err)
		}
		if partial.State != batch.StateFailed || partial.Completed != 1 || partial.Failed != 1 || len(partial.Results) != 2 {
			t.Fatalf("partial terminal state/progress incorrect: %+v", partial)
		}

		got, err = scheduler.Next(context.Background())
		if err != nil {
			t.Fatalf("dequeue second compatible group: %v", err)
		}
		if got.Key != compatible || got.Job.ID != "job-b" {
			t.Fatalf("compatible group was misrouted: %+v", got)
		}
		if err := scheduler.Cancel("job-b"); err != nil {
			t.Fatalf("cancel queued/running group: %v", err)
		}
		cancelled, err := scheduler.Progress("job-b")
		if err != nil {
			t.Fatalf("cancelled progress: %v", err)
		}
		if cancelled.State != batch.StateCancelled || cancelled.Cancelled != 1 {
			t.Fatalf("cancellation was not terminal: %+v", cancelled)
		}

		got, err = scheduler.Next(context.Background())
		if err != nil {
			t.Fatalf("dequeue incompatible group: %v", err)
		}
		if got.Key != incompatible || got.Job.ID != "job-c" {
			t.Fatalf("incompatible group was mixed with compatible work: %+v", got)
		}
		if err := scheduler.Cancel("job-c"); err != nil {
			t.Fatalf("cancel final group: %v", err)
		}
	})

	t.Run("every compatibility key dimension splits admission groups", func(t *testing.T) {
		base := scenarioBatchKey("model-a")
		mutations := map[string]func(*batch.Key){
			"provider":    func(key *batch.Key) { key.ProviderID = "other-provider" },
			"capability":  func(key *batch.Key) { key.CapabilityVersion++ },
			"model":       func(key *batch.Key) { key.Model = "model-b" },
			"surface":     func(key *batch.Key) { key.Surface = protocol.SurfaceOpenAIResponses },
			"endpoint":    func(key *batch.Key) { key.Endpoint = "/v1/responses" },
			"account":     func(key *batch.Key) { key.AccountScope = "tenant-b" },
			"network":     func(key *batch.Key) { key.NetworkID = "network-b" },
			"response":    func(key *batch.Key) { key.ResponseMode = "stream" },
			"tool-schema": func(key *batch.Key) { key.ToolSchemaDigest = "tools-b" },
			"policy":      func(key *batch.Key) { key.PolicyDigest = "policy-b" },
			"catalog":     func(key *batch.Key) { key.CatalogGeneration++ },
			"translation": func(key *batch.Key) { key.TranslationDigest = "translation-b" },
		}
		for name, mutate := range mutations {
			t.Run(name, func(t *testing.T) {
				scheduler := batch.NewScheduler(batch.SchedulerConfig{
					MaxJobs:    4,
					MaxItems:   4,
					MaxGroups:  1,
					Now:        func() time.Time { return now },
					Capability: func(batch.Key) bool { return true },
				})
				first := scenarioGroup("base-"+name, base, now, "base-item-"+name)
				changed := base
				mutate(&changed)
				second := scenarioGroup("changed-"+name, changed, now, "changed-item-"+name)
				if err := scheduler.Submit(context.Background(), first); err != nil {
					t.Fatalf("submit base: %v", err)
				}
				if err := scheduler.Submit(context.Background(), second); !errors.Is(err, batch.ErrCapacity) {
					t.Fatalf("incompatible key admitted into one-group queue: %v", err)
				}
			})
		}
	})

	t.Run("expiry and cancellation preserve terminal state", func(t *testing.T) {
		scheduler := batch.NewScheduler(batch.SchedulerConfig{
			Now:        func() time.Time { return now },
			Capability: func(batch.Key) bool { return true },
		})
		expiring := scenarioGroup("job-expire", scenarioBatchKey("model-a"), now, "item-expire")
		expiring.Job.ExpiresAt = now.Add(time.Second)
		if err := scheduler.Submit(context.Background(), expiring); err != nil {
			t.Fatal(err)
		}
		if ids := scheduler.Expire(now.Add(2 * time.Second)); len(ids) != 1 || ids[0] != "job-expire" {
			t.Fatalf("expiry IDs = %v", ids)
		}
		expired, err := scheduler.Progress("job-expire")
		if err != nil {
			t.Fatal(err)
		}
		if expired.State != batch.StateExpired || expired.Expired != 1 {
			t.Fatalf("expiry progress = %+v", expired)
		}
		if err := scheduler.Complete("job-expire", nil); !errors.Is(err, batch.ErrExpired) {
			t.Fatalf("expired job accepted completion: %v", err)
		}

		running := scenarioGroup("job-cancel", scenarioBatchKey("model-a"), now, "item-cancel")
		if err := scheduler.Submit(context.Background(), running); err != nil {
			t.Fatal(err)
		}
		if _, err := scheduler.Next(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := scheduler.Cancel("job-cancel"); err != nil {
			t.Fatal(err)
		}
		if err := scheduler.Complete("job-cancel", nil); !errors.Is(err, batch.ErrCancelled) {
			t.Fatalf("cancelled job accepted completion: %v", err)
		}
	})

	t.Run("restart recovery retains list get and progress", func(t *testing.T) {
		store := newScenarioRestartStore()
		first := batch.NewScheduler(batch.SchedulerConfig{
			Now:        func() time.Time { return now },
			Capability: func(batch.Key) bool { return true },
		})
		group := scenarioGroup("job-restart", scenarioBatchKey("model-a"), now, "item-restart-0", "item-restart-1")
		if err := first.Submit(context.Background(), group); err != nil {
			t.Fatal(err)
		}
		running, err := first.Next(context.Background())
		if err != nil {
			t.Fatalf("claim before restart: %v", err)
		}
		store.SaveGroup(running)
		before, err := first.Progress(group.Job.ID)
		if err != nil {
			t.Fatal(err)
		}
		store.SaveProgress(before)
		first.Close()

		ids := store.ListIDs()
		if len(ids) != 1 || ids[0] != group.Job.ID {
			t.Fatalf("restart list lost job: %v", ids)
		}
		recovered, ok := store.LoadGroup(group.Job.ID)
		if !ok || recovered.Job.ID != group.Job.ID || len(recovered.Items) != 2 {
			t.Fatalf("restart get lost durable group: %+v", recovered)
		}
		savedProgress, ok := store.LoadProgress(group.Job.ID)
		if !ok || savedProgress.State != batch.StateRunning || savedProgress.Running != 2 {
			t.Fatalf("restart lost running progress: %+v", savedProgress)
		}

		second := batch.NewScheduler(batch.SchedulerConfig{
			Now:        func() time.Time { return now },
			Capability: func(batch.Key) bool { return true },
		})
		if err := second.Submit(context.Background(), recovered); err != nil {
			t.Fatalf("rehydrate after restart: %v", err)
		}
		rehydrated, err := second.Next(context.Background())
		if err != nil || rehydrated.Job.ID != group.Job.ID {
			t.Fatalf("recovered job was not schedulable: group=%+v err=%v", rehydrated, err)
		}
		if err := second.Complete(group.Job.ID, []batch.Result{
			{ItemID: "item-restart-0", State: batch.ItemCompleted},
			{ItemID: "item-restart-1", State: batch.ItemCompleted},
		}); err != nil {
			t.Fatal(err)
		}
		after, err := second.Progress(group.Job.ID)
		if err != nil {
			t.Fatal(err)
		}
		store.SaveProgress(after)
		if after.State != batch.StateCompleted || after.Completed != 2 || after.Running != 0 {
			t.Fatalf("restart terminal progress incorrect: %+v", after)
		}
	})

	t.Run("native execution maps partial results by item ID", func(t *testing.T) {
		native := &nativeScenarioExecutor{results: map[string]batch.Result{
			"item-native-1": {State: batch.ItemCompleted, Response: "second"},
			// item-native-0 is intentionally omitted: it must fail, not
			// inherit item-native-1's response by position.
		}}
		executor := batch.NewExecutor(nil, nil)
		executor.Caps = &providers.ProviderCaps{Batch: true}
		executor.Native = native
		group := scenarioGroup("job-native", scenarioBatchKey("model-a"), now, "item-native-0", "item-native-1")
		results, err := executor.Execute(context.Background(), group)
		if err != nil {
			t.Fatalf("native execution: %v", err)
		}
		if len(results) != 2 || results[0].ItemID != "item-native-0" || results[1].ItemID != "item-native-1" {
			t.Fatalf("native results were not stable by item position: %+v", results)
		}
		if results[0].State != batch.ItemFailed || results[0].Error == "" {
			t.Fatalf("omitted native result was not classified as failure: %+v", results[0])
		}
		if results[1].State != batch.ItemCompleted || results[1].Response != "second" {
			t.Fatalf("native result crossed item IDs: %+v", results[1])
		}
		native.mu.Lock()
		calls := native.calls
		native.mu.Unlock()
		if calls != 1 {
			t.Fatalf("native provider called %d times, want one batch call", calls)
		}
	})

	t.Run("fallback execution is bounded and preserves independent failures", func(t *testing.T) {
		var mu sync.Mutex
		seen := make([]string, 0, 3)
		executor := batch.NewExecutor(nil, func(_ context.Context, item batch.Item) (batch.Result, error) {
			mu.Lock()
			seen = append(seen, item.ID)
			mu.Unlock()
			if item.ID == "item-fallback-fail" {
				return batch.Result{}, errors.New("one item failed")
			}
			return batch.Result{State: batch.ItemCompleted, Response: item.ID}, nil
		})
		executor.MaxParallel = 2
		group := scenarioGroup("job-fallback", scenarioBatchKey("model-a"), now, "item-fallback-ok", "item-fallback-fail", "item-fallback-ok-2")
		results, err := executor.Execute(context.Background(), group)
		if err != nil {
			t.Fatalf("fallback execution: %v", err)
		}
		if len(results) != 3 || results[0].ItemID != "item-fallback-ok" || results[1].ItemID != "item-fallback-fail" {
			t.Fatalf("fallback result ordering changed: %+v", results)
		}
		if results[1].State != batch.ItemFailed || results[1].Error != "one item failed" {
			t.Fatalf("fallback partial failure lost: %+v", results[1])
		}
		if len(seen) != 3 {
			t.Fatalf("fallback did not attempt every item: %v", seen)
		}
	})
}
