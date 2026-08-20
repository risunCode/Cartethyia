package router

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type poolFixture struct{ accounts []Account }

func (f poolFixture) ListAccounts(context.Context, string) ([]Account, error) {
	return append([]Account(nil), f.accounts...), nil
}

func TestPoolSelectionDeterministicAndHealthAware(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p, err := NewAccountPool(PoolConfig{
		Store: poolFixture{accounts: []Account{{ID: "b", Provider: "openai", Enabled: true}, {ID: "a", Provider: "openai", Enabled: true}}},
		TTL:   time.Hour,
		Now:   func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil || first.Account.ID != "a" {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	first.Release()
	p.MarkTransient(first.Account.ID)
	second, _, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil || second.Account.ID != "b" {
		t.Fatalf("second=%#v err=%v", second, err)
	}
	second.Release()
	p.MarkAuthentication(second.Account.ID)
	if _, availability, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"}); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("cooled accounts selected: availability=%+v err=%v", availability, err)
	}
}

func TestPoolAcquireCandidateRotatesEqualLoadTies(t *testing.T) {
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{
		{ID: "c", Provider: "openai", Enabled: true},
		{ID: "a", Provider: "openai", Enabled: true},
		{ID: "b", Provider: "openai", Enabled: true},
	}}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for range 300 {
		lease, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
		if acquireErr != nil {
			t.Fatal(acquireErr)
		}
		counts[lease.Account.ID]++
		lease.Release()
		lease.Release()
	}
	for _, id := range []string{"a", "b", "c"} {
		if counts[id] != 100 {
			t.Fatalf("tie distribution=%v, %s selected %d times, want 100", counts, id, counts[id])
		}
		if got := p.InFlight(id); got != 0 {
			t.Fatalf("%s in-flight=%d after idempotent releases, want zero", id, got)
		}
	}
}

func TestPoolAcquireCandidateHighContentionNeverLeaksOrConcentrates(t *testing.T) {
	accounts := make([]Account, 8)
	counts := make(map[string]*atomic.Int64, len(accounts))
	for i := range accounts {
		id := "account-" + strconv.Itoa(i)
		accounts[i] = Account{ID: id, Provider: "openai", Enabled: true}
		counts[id] = &atomic.Int64{}
	}
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: accounts}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	const workers = 64
	const rounds = 25
	errs := make(chan error, workers*rounds)
	for range rounds {
		start := make(chan struct{})
		release := make(chan struct{})
		var ready, acquired, done sync.WaitGroup
		ready.Add(workers)
		acquired.Add(workers)
		done.Add(workers)
		for range workers {
			go func() {
				defer done.Done()
				ready.Done()
				<-start
				lease, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
				if acquireErr != nil {
					errs <- acquireErr
					acquired.Done()
					return
				}
				counts[lease.Account.ID].Add(1)
				acquired.Done()
				<-release
				lease.Release()
				lease.Release()
			}()
		}
		ready.Wait()
		close(start)
		acquired.Wait()
		close(release)
		done.Wait()
	}
	close(errs)
	for acquireErr := range errs {
		t.Fatal(acquireErr)
	}

	wantSelections := int64(workers * rounds / len(accounts))
	for _, account := range accounts {
		if selected := counts[account.ID].Load(); selected != wantSelections {
			t.Fatalf("%s selected %d times while leases overlapped, want %d", account.ID, selected, wantSelections)
		}
		if got := p.InFlight(account.ID); got != 0 {
			t.Fatalf("%s in-flight=%d after contention, want zero", account.ID, got)
		}
	}
}

func TestPoolAvailabilityFiltersCandidatesAndReturnsEarliestRetry(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	p, err := NewAccountPool(PoolConfig{
		Store: poolFixture{accounts: []Account{
			{ID: "disabled", Provider: "openai", Enabled: false},
			{ID: "exhausted", Provider: "openai", Enabled: true},
			{ID: "cooling", Provider: "openai", Enabled: true},
			{ID: "locked", Provider: "openai", Enabled: true},
			{ID: "attempted", Provider: "openai", Enabled: true},
			{ID: "reauth", Provider: "openai", Enabled: true, ReauthRequired: true},
			{ID: "other-model", Provider: "openai", Model: "other", Enabled: true},
		}},
		TTL: time.Hour,
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Refresh(context.Background(), "openai"); err != nil {
		t.Fatal(err)
	}
	p.MarkExhausted("exhausted")
	p.MarkTransient("cooling")
	p.MarkTransientForModel("locked", "model")

	_, availability, err := p.AcquireCandidate(context.Background(), SelectionInput{
		ProviderID:         "openai",
		ModelID:            "model",
		ExcludedAccountIDs: map[string]struct{}{"attempted": {}},
	})
	if !errors.Is(err, ErrNoAccount) {
		t.Fatalf("err=%v, want ErrNoAccount", err)
	}
	if want := now.Add(transientCooldown); !availability.RetryAt.Equal(want) {
		t.Fatalf("RetryAt=%v, want earliest %v", availability.RetryAt, want)
	}
	if availability.ExcludedCount != 7 || len(availability.Exclusions) != 7 {
		t.Fatalf("availability exclusions=%+v count=%d, want seven", availability.Exclusions, availability.ExcludedCount)
	}
	reasons := make(map[string]ExclusionReason, len(availability.Exclusions))
	for _, exclusion := range availability.Exclusions {
		reasons[exclusion.AccountID] = exclusion.Reason
	}
	wantReasons := map[string]ExclusionReason{
		"disabled": ExclusionDisabled, "exhausted": ExclusionExhausted,
		"cooling": ExclusionCooling, "locked": ExclusionModelLocked,
		"attempted": ExclusionAlreadyAttempted, "reauth": ExclusionUnavailable,
		"other-model": ExclusionUnavailable,
	}
	for id, want := range wantReasons {
		if reasons[id] != want {
			t.Fatalf("reason[%s]=%q, want %q (all=%v)", id, reasons[id], want, reasons)
		}
	}
}

func TestPoolAvailabilityBoundsExclusionEvidence(t *testing.T) {
	accounts := make([]Account, MaxCandidateExclusions+9)
	for i := range accounts {
		accounts[i] = Account{ID: "disabled-" + strconv.Itoa(i), Provider: "openai"}
	}
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: accounts}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	_, availability, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if !errors.Is(err, ErrNoAccount) {
		t.Fatalf("err=%v, want ErrNoAccount", err)
	}
	if availability.ExcludedCount != len(accounts) || len(availability.Exclusions) != MaxCandidateExclusions {
		t.Fatalf("excluded count=%d evidence=%d, want %d/%d", availability.ExcludedCount, len(availability.Exclusions), len(accounts), MaxCandidateExclusions)
	}
}

type independentProviderStore struct {
	aStarted sync.Once
	started  chan struct{}
	release  chan struct{}
	mu       sync.Mutex
	calls    map[string]int
}

func (s *independentProviderStore) ListAccounts(ctx context.Context, providerID string) ([]Account, error) {
	s.mu.Lock()
	s.calls[providerID]++
	s.mu.Unlock()
	if providerID == "provider-a" {
		s.aStarted.Do(func() { close(s.started) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return []Account{{ID: providerID + "-account", Provider: providerID, Enabled: true}}, nil
}

func TestPoolRefreshSingleFlightKeepsProvidersIndependentAndHonorsCancellation(t *testing.T) {
	store := &independentProviderStore{started: make(chan struct{}), release: make(chan struct{}), calls: make(map[string]int)}
	p, err := NewAccountPool(PoolConfig{Store: store, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	aResult := make(chan error, 1)
	go func() {
		lease, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "provider-a", ModelID: "model"})
		if lease != nil {
			lease.Release()
		}
		aResult <- acquireErr
	}()
	<-store.started

	bResult := make(chan error, 1)
	go func() {
		lease, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "provider-b", ModelID: "model"})
		if lease != nil {
			lease.Release()
		}
		bResult <- acquireErr
	}()
	select {
	case acquireErr := <-bResult:
		if acquireErr != nil {
			t.Fatal(acquireErr)
		}
	case <-time.After(time.Second):
		t.Fatal("provider-b refresh serialized behind provider-a")
	}

	ctx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() {
		_, _, acquireErr := p.AcquireCandidate(ctx, SelectionInput{ProviderID: "provider-a", ModelID: "model"})
		canceled <- acquireErr
	}()
	cancel()
	select {
	case acquireErr := <-canceled:
		if !errors.Is(acquireErr, context.Canceled) {
			t.Fatalf("waiting refresh error=%v, want context.Canceled", acquireErr)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled refresh waiter did not return")
	}

	close(store.release)
	if acquireErr := <-aResult; acquireErr != nil {
		t.Fatal(acquireErr)
	}
	store.mu.Lock()
	aCalls, bCalls := store.calls["provider-a"], store.calls["provider-b"]
	store.mu.Unlock()
	if aCalls != 1 || bCalls != 1 {
		t.Fatalf("refresh calls: provider-a=%d provider-b=%d, want one per provider", aCalls, bCalls)
	}
}

var errSnapshotRefresh = errors.New("fixture account refresh failed")

type staleSnapshotStore struct {
	mu       sync.Mutex
	calls    int
	accounts []Account
}

func (s *staleSnapshotStore) ListAccounts(context.Context, string) ([]Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls > 1 {
		return nil, errSnapshotRefresh
	}
	return append([]Account(nil), s.accounts...), nil
}

func TestPoolRefreshRetainsOnlyBoundedStaleSnapshot(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := &staleSnapshotStore{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}
	p, err := NewAccountPool(PoolConfig{
		Store:    store,
		TTL:      10 * time.Second,
		StaleTTL: 20 * time.Second,
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()

	now = now.Add(11 * time.Second)
	staleLease, availability, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		t.Fatalf("bounded stale snapshot rejected: %v", err)
	}
	staleLease.Release()
	if !availability.SnapshotDegraded {
		t.Fatal("stale selection did not expose degraded snapshot state")
	}
	diagnostic, ok := p.ProviderSnapshot("openai")
	if !ok || !diagnostic.Degraded || len(diagnostic.Accounts) != 1 {
		t.Fatalf("diagnostic snapshot=%+v ok=%v", diagnostic, ok)
	}

	now = now.Add(20 * time.Second)
	if _, _, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"}); !errors.Is(err, errSnapshotRefresh) {
		t.Fatalf("expired stale snapshot error=%v, want refresh failure", err)
	}
}

type blockingStatePersistence struct {
	accountStarted chan struct{}
	accountRelease chan struct{}
	modelStarted   chan struct{}
	modelRelease   chan struct{}
	accountOnce    sync.Once
	modelOnce      sync.Once
}

func (s *blockingStatePersistence) LoadAccount(ctx context.Context, _ string) (AccountHealthState, error) {
	if s.accountStarted != nil {
		s.accountOnce.Do(func() { close(s.accountStarted) })
		select {
		case <-s.accountRelease:
		case <-ctx.Done():
			return AccountHealthState{}, ctx.Err()
		}
	}
	return AccountHealthState{State: StateHealthy}, nil
}

func (*blockingStatePersistence) SaveAccount(context.Context, string, AccountHealthState) error {
	return nil
}

func (s *blockingStatePersistence) LoadModelLock(ctx context.Context, _, _ string) (ModelLockState, error) {
	if s.modelStarted != nil {
		s.modelOnce.Do(func() { close(s.modelStarted) })
		select {
		case <-s.modelRelease:
		case <-ctx.Done():
			return ModelLockState{}, ctx.Err()
		}
	}
	return ModelLockState{}, nil
}

func (*blockingStatePersistence) SaveModelLock(context.Context, string, string, ModelLockState) error {
	return nil
}

func (*blockingStatePersistence) ClearModelLock(context.Context, string, string) error { return nil }

func TestPoolStaleAccountHydrationCannotOverwriteNewerCooldown(t *testing.T) {
	persistence := &blockingStatePersistence{accountStarted: make(chan struct{}), accountRelease: make(chan struct{})}
	p, err := NewAccountPool(PoolConfig{
		Store:            poolFixture{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}},
		TTL:              time.Hour,
		StatePersistence: persistence,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
		result <- acquireErr
	}()
	<-persistence.accountStarted
	p.MarkTransient("a")
	close(persistence.accountRelease)
	if acquireErr := <-result; !errors.Is(acquireErr, ErrNoAccount) {
		t.Fatalf("acquire error=%v, want cooldown exclusion", acquireErr)
	}
	state, snapshot := p.Snapshot("a")
	if state != StateCoolingDown || snapshot == nil || snapshot.CooldownUntil.IsZero() {
		t.Fatalf("stale hydration overwrote cooldown: state=%q snapshot=%+v", state, snapshot)
	}
}

func TestPoolStaleModelHydrationCannotDeleteNewerLock(t *testing.T) {
	persistence := &blockingStatePersistence{modelStarted: make(chan struct{}), modelRelease: make(chan struct{})}
	p, err := NewAccountPool(PoolConfig{
		Store:            poolFixture{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}},
		TTL:              time.Hour,
		StatePersistence: persistence,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, _, acquireErr := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
		result <- acquireErr
	}()
	<-persistence.modelStarted
	p.MarkTransientForModel("a", "model")
	close(persistence.modelRelease)
	if acquireErr := <-result; !errors.Is(acquireErr, ErrNoAccount) {
		t.Fatalf("acquire error=%v, want model-lock exclusion", acquireErr)
	}
	diagnostic, ok := p.ProviderSnapshot("openai")
	if !ok || len(diagnostic.Accounts) != 1 || len(diagnostic.Accounts[0].ModelLocks) != 1 || diagnostic.Accounts[0].ModelLocks[0].RetryAt.IsZero() {
		t.Fatalf("stale hydration deleted model lock: snapshot=%+v ok=%v", diagnostic, ok)
	}
}

func TestPoolProviderSnapshotIsReadOnlyAndNonMutating(t *testing.T) {
	p, err := NewAccountPool(PoolConfig{Store: poolFixture{accounts: []Account{{ID: "a", Provider: "openai", Enabled: true}}}, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	lease, _, err := p.AcquireCandidate(context.Background(), SelectionInput{ProviderID: "openai", ModelID: "model"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, ok := p.ProviderSnapshot("openai")
	if !ok || len(snapshot.Accounts) != 1 || snapshot.Accounts[0].Runtime.InFlight != 1 {
		t.Fatalf("snapshot=%+v ok=%v", snapshot, ok)
	}
	snapshot.Accounts[0].ID = "mutated"
	snapshot.Accounts = nil
	again, ok := p.ProviderSnapshot("openai")
	if !ok || len(again.Accounts) != 1 || again.Accounts[0].ID != "a" || again.Accounts[0].Runtime.InFlight != 1 {
		t.Fatalf("diagnostic caller mutated pool snapshot: %+v", again)
	}
	lease.Release()
	lease.Release()
	if got := p.InFlight("a"); got != 0 {
		t.Fatalf("in-flight=%d after idempotent release, want zero", got)
	}
}
