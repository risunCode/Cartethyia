package router

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	contracts "github.com/cartethyia/daemon/internal/protocol"
	transforms "github.com/cartethyia/daemon/internal/protocol/codec"
)

func TestTask22ReadinessAndPreparationConcurrentUpdates(t *testing.T) {
	pool, err := NewAccountPool(PoolConfig{Store: readinessStore{accounts: []Account{{ID: "fixture-a", Provider: "fixture", Model: "fixture-model", Enabled: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for iteration := 0; iteration < 128; iteration++ {
				pool.MarkReadiness(ReadinessRecord{AccountID: "fixture-a", ProviderID: "fixture", ModelID: "fixture-model", Surface: contracts.SurfaceOpenAIChat, Tier: ReadinessTier(worker % 4), Code: "fixture.local", CheckedAt: time.Unix(int64(iteration), 0)})
				_ = pool.ReadinessSnapshot()
			}
		}(worker)
	}
	wg.Wait()
	if got := len(pool.ReadinessSnapshot()); got > 1 {
		t.Fatalf("readiness series grew without bound: %d", got)
	}
}

func TestTask22PreparedAttemptCloseExactlyOnceConcurrently(t *testing.T) {
	var closes atomic.Int32
	attempt, err := NewPreparedAttemptWithDecision(Account{ID: "fixture-account", Provider: "fixture"}, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model"}, contracts.CompatibilityDecision{}, func() error { closes.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() { defer wg.Done(); _ = attempt.Close() }()
	}
	wg.Wait()
	if got := closes.Load(); got != 1 {
		t.Fatalf("close callback count=%d, want 1", got)
	}
	if err := attempt.Close(); err != nil {
		t.Fatal(err)
	}
	if got := closes.Load(); got != 1 {
		t.Fatalf("close callback count after repeat=%d, want 1", got)
	}
	if err := (*PreparedAttempt)(nil).Close(); err != nil {
		t.Fatalf("nil Close returned %v", err)
	}
}

func TestTask22StreamFinalizationConcurrentCloseAbort(t *testing.T) {
	var cancellations atomic.Int32
	stream := NewStream(make(chan StreamEvent, 1), func() { cancellations.Add(1) }, 0, 0)
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = stream.Close()
			stream.Abort(context.Canceled)
		}()
	}
	wg.Wait()
	if got := cancellations.Load(); got > 1 {
		t.Fatalf("stream cancellation callback invoked %d times", got)
	}
	if _, err := stream.Next(context.Background()); err == nil {
		t.Fatal("closed stream unexpectedly returned a nil error")
	}
}

type task22LoadPreparer struct {
	calls         atomic.Int64
	localFailures int64
}

func (p *task22LoadPreparer) Prepare(_ context.Context, account Account, request contracts.Request) (*PreparedAttempt, error) {
	call := p.calls.Add(1)
	if call <= p.localFailures {
		return nil, errors.New("fixture local preparation failure")
	}
	return NewPreparedAttemptWithDecision(account, request, contracts.CompatibilityDecision{}, nil)
}

func TestTask22TenKAccountsThirtyOneLocalFailures(t *testing.T) {
	if os.Getenv("CARTETHYIA_RUN_TASK22_LOAD") != "1" {
		t.Skip("set CARTETHYIA_RUN_TASK22_LOAD=1 to run bounded task22 load")
	}
	const accountCount = 10000
	const localFailures = 31
	accounts := make([]Account, accountCount)
	for index := range accounts {
		accounts[index] = Account{ID: "task22-account-" + strconv.Itoa(index), Provider: "fixture", Model: "fixture-model", Enabled: true}
	}
	pool, err := NewAccountPool(PoolConfig{Store: readinessStore{accounts: accounts}})
	if err != nil {
		t.Fatal(err)
	}
	preparer := &task22LoadPreparer{localFailures: localFailures}
	router, err := NewRouter(RouterConfig{Pool: pool, MaxAttempts: 1, Preparer: preparer})
	if err != nil {
		t.Fatal(err)
	}
	transport := &lifecycleTransport{response: &contracts.Response{StatusCode: 200, Body: []byte(`{"ok":true}`)}}
	compaction, compactionErr := transforms.DecodeCompactionRequest(context.Background(), contracts.ProtocolOpenAIResponse, []byte(`{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"history"}]},{"type":"compaction_trigger"}]}`), transforms.CompactionV2, true)
	if compactionErr != nil || compaction == nil || compaction.Operation.Kind != transforms.OperationCompactV2 {
		t.Fatalf("compaction=%#v err=%v", compaction, compactionErr)
	}
	plan := fixtureRoutePlan("fixture", "fixture-model", contracts.SurfaceOpenAIChat)
	plan.Generation = 7
	plan.PolicyGeneration = 3
	response, failure, routeErr := router.Route(context.Background(), transport, contracts.Request{Protocol: contracts.SurfaceOpenAIChat, Model: "fixture-model"}, plan)
	if routeErr != nil || failure != nil || response == nil {
		t.Fatalf("response=%#v failure=%#v err=%v", response, failure, routeErr)
	}
	if got := preparer.calls.Load(); got != localFailures+1 {
		t.Fatalf("preparation calls=%d, want %d", got, localFailures+1)
	}
	if got := transport.calls; got != 1 {
		t.Fatalf("upstream calls=%d, want one prepared call", got)
	}
	for _, account := range accounts[:localFailures+1] {
		if got := pool.InFlight(account.ID); got != 0 {
			t.Fatalf("account %s leaked %d leases", account.ID, got)
		}
	}
}
