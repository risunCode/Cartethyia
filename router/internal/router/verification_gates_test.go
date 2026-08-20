package router

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cartethyia/daemon/internal/telemetry/usage"
	"github.com/cartethyia/daemon/internal/providers"
	contracts "github.com/cartethyia/daemon/internal/protocol"
	"github.com/cartethyia/daemon/internal/router/catalog"
)

func FuzzProviderEventMapping(f *testing.F) {
	const secretSentinel = "credential-SENTINEL-provider-event"
	seeds := []struct {
		event   string
		id      string
		payload []byte
	}{
		{event: "response.created", id: "evt-1", payload: []byte(`{"type":"response.created","response":{"id":"resp_1"}}`)},
		{event: "response.output_text.delta", payload: []byte(`{"type":"response.output_text.delta","delta":"hello"}`)},
		{event: "response.completed", payload: []byte(`{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}}`)},
		{event: "message_start", payload: []byte(`{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1}}}`)},
		{event: "content_block_delta", payload: []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`)},
		{event: "message_stop", payload: []byte(`{"type":"message_stop"}`)},
		{payload: []byte(`{"id":"chatcmpl_1","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}`)},
		{event: "error", payload: []byte(`{"type":"error","error":{"message":"` + secretSentinel + `"}}`)},
	}
	for _, seed := range seeds {
		f.Add(seed.event, seed.id, seed.payload)
	}

	f.Fuzz(func(t *testing.T, event, id string, payload []byte) {
		if len(event) > 128 {
			event = event[:128]
		}
		if len(id) > maxStreamResponseIDBytes {
			id = id[:maxStreamResponseIDBytes]
		}
		if len(payload) > 32<<10 {
			payload = payload[:32<<10]
		}
		input := ProviderStreamPayload{Data: payload, Event: event, ID: id}
		first, firstErr := MapProviderPayload(input)
		second, secondErr := MapProviderPayload(input)
		if (firstErr == nil) != (secondErr == nil) {
			t.Fatalf("mapping stability mismatch: first=%v second=%v", firstErr, secondErr)
		}
		if firstErr != nil {
			firstCode, secondCode := StreamCodeOf(firstErr), StreamCodeOf(secondErr)
			if firstCode == "" || firstCode != secondCode {
				t.Fatalf("unstable mapping error codes: %q/%q", firstCode, secondCode)
			}
			if strings.Contains(firstErr.Error(), secretSentinel) {
				t.Fatalf("mapping error leaked secret sentinel: %q", firstErr)
			}
			return
		}
		if len(first) != len(second) || len(first) > len(payload)+1 {
			t.Fatalf("mapped event count first=%d second=%d payload=%d", len(first), len(second), len(payload))
		}
		for index := range first {
			if eventProjection(first[index]) != eventProjection(second[index]) {
				t.Fatalf("mapped event %d is nondeterministic: first=%+v second=%+v", index, first[index], second[index])
			}
			if size := streamEventSize(first[index]); size > 4*len(payload)+1024 {
				t.Fatalf("mapped event %d size=%d exceeds payload-shaped bound", index, size)
			}
		}

		capacity := len(first)
		if capacity == 0 {
			capacity = 1
		}
		ch := make(chan StreamEvent, capacity)
		for _, mapped := range first {
			ch <- mapped
		}
		stream := NewStream(ch, nil, 0, 0)
		for range first {
			event, err := stream.Next(context.Background())
			if err != nil {
				break
			}
			if event.IsTerminal() {
				break
			}
		}
		if terminalErr := stream.Err(); terminalErr != nil {
			if StreamCodeOf(terminalErr) == "" {
				t.Fatalf("terminal mapping error lacks stable code: %v", terminalErr)
			}
			if strings.Contains(terminalErr.Error(), secretSentinel) {
				t.Fatalf("terminal mapping error leaked secret sentinel: %q", terminalErr)
			}
		}
		_ = stream.Close()
	})
}

type mappedEventProjection struct {
	kind                  StreamEventKind
	text, id, name        string
	reason                string
	index                 int
	input, output         int
	total, cacheRead      int
	cacheWrite, reasoning int
	hasUsage, hasError    bool
}

func eventProjection(event StreamEvent) mappedEventProjection {
	projection := mappedEventProjection{kind: event.Kind, text: event.Text, id: event.CallID, name: event.CallName, reason: event.Reason, index: event.Index, hasError: event.Err != nil}
	if event.Usage != nil {
		projection.hasUsage = true
		projection.input = event.Usage.InputTokens
		projection.output = event.Usage.OutputTokens
		projection.total = event.Usage.TotalTokens
		projection.cacheRead = event.Usage.CacheReadTokens
		projection.cacheWrite = event.Usage.CacheWriteTokens
		projection.reasoning = event.Usage.ReasoningTokens
	}
	return projection
}

type atomicTokenReservation struct {
	reconciles atomic.Int64
	releases   atomic.Int64
}

func (r *atomicTokenReservation) Reconcile(context.Context, usage.Tokens) error {
	r.reconciles.Add(1)
	return nil
}

func (r *atomicTokenReservation) Release(context.Context, ReleaseReason) error {
	r.releases.Add(1)
	return nil
}

func TestAccountLeaseConcurrentReleaseExactlyOnce(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{{ID: "account", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		t.Fatal(err)
	}
	const goroutines = 128
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for range goroutines {
		go func() {
			defer wg.Done()
			<-start
			lease.Release()
		}()
	}
	close(start)
	wg.Wait()
	if got := pool.InFlight("account"); got != 0 {
		t.Fatalf("in-flight=%d after concurrent release, want zero", got)
	}
}

func TestStreamConcurrentCloseAbortFinalizesTokenAndLeaseOnce(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{{ID: "account", Provider: "openai", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		t.Fatal(err)
	}
	reservation := &atomicTokenReservation{}
	var finalizers atomic.Int64
	stream := NewStream(make(chan StreamEvent), nil, 0, 0)
	stream.AttachAccountLease(lease)
	stream.AttachTokenReservation(context.Background(), reservation)
	stream.AttachFinalizer(func(error, error) { finalizers.Add(1) })

	const goroutines = 128
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for index := range goroutines {
		index := index
		go func() {
			defer wg.Done()
			<-start
			switch index % 3 {
			case 0:
				_ = stream.Close()
			case 1:
				stream.Abort(context.Canceled)
			default:
				stream.Abort(errors.New("consumer stopped"))
			}
		}()
	}
	close(start)
	wg.Wait()
	if !stream.closed.Load() {
		t.Fatal("stream did not reach its closed state")
	}
	if got := finalizers.Load(); got != 1 {
		t.Fatalf("finalizer calls=%d, want one", got)
	}
	if got := reservation.reconciles.Load(); got != 1 {
		t.Fatalf("token reconciles=%d, want one", got)
	}
	if got := reservation.releases.Load(); got != 0 {
		t.Fatalf("token releases=%d, want zero after reconcile", got)
	}
	if got := pool.InFlight("account"); got != 0 {
		t.Fatalf("account in-flight=%d after finalization, want zero", got)
	}
}

func BenchmarkFailureClassification(b *testing.B) {
	input := ClassifyInput{StatusCode: 429, HeaderValues: []string{"Retry-After: 2"}, BodyPeek: `{"error":{"code":"rate_limit_exceeded"}}`}
	b.ReportAllocs()
	for b.Loop() {
		failure := Classify(input)
		if failure.Code == "" {
			b.Fatal("classification returned no code")
		}
	}
}

func BenchmarkRoutePlanExpansion(b *testing.B) {
	models := make(map[string]catalog.Model, catalog.MaxComboMembers)
	members := make([]string, catalog.MaxComboMembers)
	for index := range catalog.MaxComboMembers {
		qualified := "provider-" + strconv.Itoa(index) + ":model"
		models[qualified] = catalog.Model{ID: "model", QualifiedID: qualified, ProviderID: "provider-" + strconv.Itoa(index), UpstreamID: "upstream", Surfaces: []providers.Surface{providers.SurfaceOpenAIChat}}
		members[index] = qualified
	}
	snapshot := &catalog.Snapshot{Generation: 1, Models: models, Combinations: map[string]catalog.Combination{"combo": {ID: "combo", Members: members, Strategy: string(catalog.RouteStrategyFallback)}}}
	b.ReportAllocs()
	for b.Loop() {
		plan, err := snapshot.Plan("combo", contracts.SurfaceOpenAIChat)
		if err != nil || len(plan.Members) != catalog.MaxComboMembers {
			b.Fatalf("plan members=%d err=%v", len(plan.Members), err)
		}
	}
}

func BenchmarkAtomicAccountAcquisition(b *testing.B) {
	accounts := make([]Account, 32)
	for index := range accounts {
		accounts[index] = Account{ID: "account-" + strconv.Itoa(index), Provider: "openai", Enabled: true}
	}
	pool, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: accounts}, TTL: time.Hour})
	if err != nil {
		b.Fatal(err)
	}
	warm, _, err := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		b.Fatal(err)
	}
	warm.Release()
	var failed atomic.Bool
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			lease, _, acquireErr := pool.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
			if acquireErr != nil {
				failed.Store(true)
				return
			}
			lease.Release()
		}
	})
	if failed.Load() {
		b.Fatal("atomic acquisition failed")
	}
}

func BenchmarkProviderEventBridge(b *testing.B) {
	payload := ProviderStreamPayload{Data: []byte(`{"id":"chatcmpl_bench","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)}
	b.ReportAllocs()
	for b.Loop() {
		mapped, err := MapProviderPayload(payload)
		if err != nil || len(mapped) == 0 {
			b.Fatalf("mapped=%d err=%v", len(mapped), err)
		}
	}
}

func BenchmarkStreamFinalization(b *testing.B) {
	var finalized atomic.Int64
	reservation := &atomicTokenReservation{}
	b.ReportAllocs()
	for b.Loop() {
		stream := NewStream(make(chan StreamEvent), nil, 0, 0)
		stream.AttachTokenReservation(context.Background(), reservation)
		stream.AttachFinalizer(func(error, error) { finalized.Add(1) })
		_ = stream.Close()
	}
	if got := finalized.Load(); got != int64(b.N) {
		b.Fatalf("finalizers=%d, want %d", got, b.N)
	}
	if got := reservation.reconciles.Load(); got != int64(b.N) {
		b.Fatalf("reconciles=%d, want %d", got, b.N)
	}
}
