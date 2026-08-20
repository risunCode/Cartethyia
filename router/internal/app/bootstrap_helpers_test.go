package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	accounts "github.com/cartethyia/daemon/internal/accounts/auth"
	db "github.com/cartethyia/daemon/internal/storage"
	dbmodels "github.com/cartethyia/daemon/internal/storage/models"
	providerbuiltin "github.com/cartethyia/daemon/internal/providers/builtin"
	proxy "github.com/cartethyia/daemon/internal/router"
)

func TestRejectCredentialEmptyAndNonEmpty(t *testing.T) {
	_, err := rejectCredential(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "empty provider credential reference") {
		t.Fatalf("empty ref err=%v", err)
	}

	_, err = rejectCredential(context.Background(), "provider:openai")
	if err == nil || !strings.Contains(err.Error(), "no configured secret store") {
		t.Fatalf("non-empty ref err=%v", err)
	}
}

func TestShareInFlightSourceNilAndLimiter(t *testing.T) {
	if got := (shareInFlightSource{}).InFlight(); got != 0 {
		t.Fatalf("nil limiter InFlight=%d", got)
	}

	limiter, err := proxy.NewAdmissionLimiter(proxy.Layer{Name: "global", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	src := shareInFlightSource{limiter: limiter}
	if got := src.InFlight(); got != 0 {
		t.Fatalf("idle InFlight=%d", got)
	}

	lease, err := limiter.Acquire(context.Background(), map[string]string{"global": "g"})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if got := src.InFlight(); got != 1 {
		t.Fatalf("active InFlight=%d, want 1", got)
	}
}

func TestRegistrarFuncRegisterNil(t *testing.T) {
	called := false
	registrarFunc(func(*http.ServeMux) { called = true }).Register(nil)
	if called {
		t.Fatal("Register(nil) must not invoke the registrar")
	}

	mux := http.NewServeMux()
	registrarFunc(func(m *http.ServeMux) {
		if m != mux {
			t.Fatalf("unexpected mux")
		}
		called = true
	}).Register(mux)
	if !called {
		t.Fatal("Register(mux) should invoke the registrar")
	}
}

type stubAccountRefresher struct {
	token *accounts.TokenSet
	err   error
	calls int
}

func (s *stubAccountRefresher) Current(context.Context, string) (*accounts.TokenSet, error) {
	return nil, errors.New("unused")
}

func (s *stubAccountRefresher) ForceRefresh(context.Context, string) (*accounts.TokenSet, error) {
	s.calls++
	return s.token, s.err
}

func (s *stubAccountRefresher) Invalidate(string) {}

func TestAccountRefresherAdapterRefresh(t *testing.T) {
	ctx := context.Background()

	err := (accountRefresherAdapter{}).Refresh(ctx, "acct")
	if err == nil || !strings.Contains(err.Error(), "OAuth refresher is unavailable") {
		t.Fatalf("nil refresher err=%v", err)
	}

	stub := &stubAccountRefresher{token: &accounts.TokenSet{}, err: errors.New("refresh failed")}
	var invalidated []string
	adapter := accountRefresherAdapter{
		refresher: stub,
		invalidate: func(accountID string) {
			invalidated = append(invalidated, accountID)
		},
	}
	err = adapter.Refresh(ctx, "acct-1")
	if !errors.Is(err, stub.err) {
		t.Fatalf("Refresh err=%v", err)
	}
	if stub.calls != 1 {
		t.Fatalf("ForceRefresh calls=%d", stub.calls)
	}
	if len(invalidated) != 1 || invalidated[0] != "acct-1" {
		t.Fatalf("invalidate=%v", invalidated)
	}

	stub.token = nil
	stub.err = nil
	invalidated = nil
	if err := adapter.Refresh(ctx, "acct-2"); err != nil {
		t.Fatalf("success path: %v", err)
	}
	if len(invalidated) != 1 || invalidated[0] != "acct-2" {
		t.Fatalf("invalidate after success=%v", invalidated)
	}
}

func TestComposeAccountRefresher(t *testing.T) {
	existing := &stubAccountRefresher{}
	got, err := composeAccountRefresher(BootstrapDependencies{Refresher: existing})
	if err != nil {
		t.Fatal(err)
	}
	if got != existing {
		t.Fatal("expected early return of deps.Refresher")
	}

	got, err = composeAccountRefresher(BootstrapDependencies{})
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("missing stores should return nil refresher")
	}

	drivers, err := accounts.NewRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err = composeAccountRefresher(BootstrapDependencies{
		DriverRegistry: drivers,
		Accounts:       accounts.NewMemoryAccountConfigStore(),
		Secrets:        accounts.NewMemorySecretStore(),
		Records:        accounts.NewMemoryRecordStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected composed in-memory refresher")
	}
}

type fakeCatalogRepository struct {
	aliases  []dbmodels.ModelAlias
	combos   []dbmodels.Combo
	aliasErr error
	comboErr error
}

func (f fakeCatalogRepository) ListAliases(context.Context) ([]dbmodels.ModelAlias, error) {
	if f.aliasErr != nil {
		return nil, f.aliasErr
	}
	return append([]dbmodels.ModelAlias(nil), f.aliases...), nil
}

func (f fakeCatalogRepository) ListCombos(context.Context) ([]dbmodels.Combo, error) {
	if f.comboErr != nil {
		return nil, f.comboErr
	}
	return append([]dbmodels.Combo(nil), f.combos...), nil
}

func TestRepositoryCatalogSourceLoad(t *testing.T) {
	ctx := context.Background()
	source := &repositoryCatalogSource{repository: fakeCatalogRepository{
		aliases: []dbmodels.ModelAlias{{Alias: "fast", Model: "gpt-mini"}},
		combos:  []dbmodels.Combo{{ID: "combo-1", Models: []string{"a", "b"}, Strategy: "fallback"}},
	}}

	aliases, combos, gen, err := source.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if gen != 1 || len(aliases) != 1 || aliases[0].Alias != "fast" || aliases[0].Target != "gpt-mini" {
		t.Fatalf("aliases=%#v gen=%d", aliases, gen)
	}
	if len(combos) != 1 || combos[0].ID != "combo-1" || len(combos[0].Members) != 2 || combos[0].Strategy != "fallback" {
		t.Fatalf("combos=%#v", combos)
	}
	aliases[0].Alias = "mutated"
	combos[0].Members[0] = "mutated"
	if source.generation != 1 {
		t.Fatalf("generation=%d", source.generation)
	}

	_, _, _, err = (&repositoryCatalogSource{repository: fakeCatalogRepository{aliasErr: errors.New("alias boom")}}).Load(ctx)
	if err == nil || !strings.Contains(err.Error(), "alias boom") {
		t.Fatalf("alias err=%v", err)
	}
	_, _, _, err = (&repositoryCatalogSource{repository: fakeCatalogRepository{comboErr: errors.New("combo boom")}}).Load(ctx)
	if err == nil || !strings.Contains(err.Error(), "combo boom") {
		t.Fatalf("combo err=%v", err)
	}
}

type fakeAccountCoreStore struct {
	health       map[string]dbmodels.AccountHealth
	locks        map[string]dbmodels.AccountModelLock
	getErr       error
	upsertErr    error
	lockErr      error
	clearLockErr error
	clearedLock  string
	clearedAll   string
}

func (f *fakeAccountCoreStore) GetHealth(_ context.Context, accountID string) (dbmodels.AccountHealth, error) {
	if f.getErr != nil {
		return dbmodels.AccountHealth{}, f.getErr
	}
	health, ok := f.health[accountID]
	if !ok {
		return dbmodels.AccountHealth{}, errors.New("missing health")
	}
	return health, nil
}

func (f *fakeAccountCoreStore) UpsertHealth(_ context.Context, health dbmodels.AccountHealth) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	if f.health == nil {
		f.health = map[string]dbmodels.AccountHealth{}
	}
	f.health[health.AccountID] = health
	return nil
}

func (f *fakeAccountCoreStore) lockKey(accountID, modelID string) string {
	return accountID + "\x00" + modelID
}

func (f *fakeAccountCoreStore) GetModelLock(_ context.Context, accountID, modelID string) (dbmodels.AccountModelLock, error) {
	if f.lockErr != nil {
		return dbmodels.AccountModelLock{}, f.lockErr
	}
	lock, ok := f.locks[f.lockKey(accountID, modelID)]
	if !ok {
		return dbmodels.AccountModelLock{}, errors.New("missing lock")
	}
	return lock, nil
}

func (f *fakeAccountCoreStore) UpsertModelLock(_ context.Context, lock dbmodels.AccountModelLock) error {
	if f.lockErr != nil {
		return f.lockErr
	}
	if f.locks == nil {
		f.locks = map[string]dbmodels.AccountModelLock{}
	}
	f.locks[f.lockKey(lock.AccountID, lock.ModelID)] = lock
	return nil
}

func (f *fakeAccountCoreStore) ClearModelLock(_ context.Context, accountID, modelID string) error {
	if f.clearLockErr != nil {
		return f.clearLockErr
	}
	f.clearedLock = f.lockKey(accountID, modelID)
	delete(f.locks, f.clearedLock)
	return nil
}

func (f *fakeAccountCoreStore) ClearModelLocks(_ context.Context, accountID string) error {
	if f.clearLockErr != nil {
		return f.clearLockErr
	}
	f.clearedAll = accountID
	for key := range f.locks {
		if strings.HasPrefix(key, accountID+"\x00") {
			delete(f.locks, key)
		}
	}
	return nil
}

func TestDurableAccountStateStore(t *testing.T) {
	ctx := context.Background()
	retry := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	occurred := time.Date(2026, 8, 15, 11, 0, 0, 0, time.UTC)

	statuses := []struct {
		status string
		want   proxy.AccountState
	}{
		{"exhausted", proxy.StateExhausted},
		{"disabled", proxy.StateDisabled},
		{"cooling_down", proxy.StateCoolingDown},
		{"error", proxy.StateError},
		{"healthy", proxy.StateHealthy},
		{"unknown", proxy.StateHealthy},
	}
	for _, tc := range statuses {
		core := &fakeAccountCoreStore{health: map[string]dbmodels.AccountHealth{
			"acct": {
				AccountID:    "acct",
				Status:       tc.status,
				FailureCount: 3,
				RetryAt:      &retry,
				OccurredAt:   &occurred,
			},
		}}
		state, err := (durableAccountStateStore{store: core}).LoadAccount(ctx, "acct")
		if err != nil {
			t.Fatalf("%s: %v", tc.status, err)
		}
		if state.State != tc.want || state.FailureCount != 3 || !state.CooldownUntil.Equal(retry) || !state.LastFailure.Equal(occurred) {
			t.Fatalf("%s state=%#v", tc.status, state)
		}
	}

	core := &fakeAccountCoreStore{}
	store := durableAccountStateStore{store: core}
	if err := store.SaveAccount(ctx, "acct-save", proxy.AccountHealthState{
		State:         proxy.StateCoolingDown,
		CooldownUntil: retry,
		LastFailure:   occurred,
		FailureCount:  4,
	}); err != nil {
		t.Fatal(err)
	}
	saved := core.health["acct-save"]
	if saved.Status != string(proxy.StateCoolingDown) || saved.FailureCount != 4 || saved.RetryAt == nil || saved.OccurredAt == nil {
		t.Fatalf("saved health=%#v", saved)
	}
	if err := store.SaveAccount(ctx, "acct-empty", proxy.AccountHealthState{}); err != nil {
		t.Fatal(err)
	}
	if core.health["acct-empty"].Status != string(proxy.StateHealthy) {
		t.Fatalf("empty state status=%q", core.health["acct-empty"].Status)
	}

	if _, err := store.LoadAccount(ctx, "missing"); err == nil {
		t.Fatal("expected LoadAccount error")
	}

	lockRetry := time.Date(2026, 8, 16, 1, 0, 0, 0, time.UTC)
	if err := store.SaveModelLock(ctx, "acct", "model-a", proxy.ModelLockState{RetryAt: lockRetry, FailureCount: 2}); err != nil {
		t.Fatal(err)
	}
	lock, err := store.LoadModelLock(ctx, "acct", "model-a")
	if err != nil {
		t.Fatal(err)
	}
	if !lock.RetryAt.Equal(lockRetry) || lock.FailureCount != 2 {
		t.Fatalf("lock=%#v", lock)
	}
	if err := store.ClearModelLock(ctx, "acct", "model-a"); err != nil {
		t.Fatal(err)
	}
	if core.clearedLock != "acct\x00model-a" {
		t.Fatalf("clearedLock=%q", core.clearedLock)
	}
	_ = store.SaveModelLock(ctx, "acct", "model-b", proxy.ModelLockState{RetryAt: lockRetry, FailureCount: 1})
	if err := store.ClearModelLocks(ctx, "acct"); err != nil {
		t.Fatal(err)
	}
	if core.clearedAll != "acct" || len(core.locks) != 0 {
		t.Fatalf("clearedAll=%q locks=%d", core.clearedAll, len(core.locks))
	}
}

func TestDurableAccountStoreListAccounts(t *testing.T) {
	ctx := context.Background()
	_, err := (durableAccountStore{}).ListAccounts(ctx, "openai")
	if err == nil || !strings.Contains(err.Error(), "account configuration store is unavailable") {
		t.Fatalf("nil store err=%v", err)
	}

	cfgStore := accounts.NewMemoryAccountConfigStore()
	records := accounts.NewMemoryRecordStore()
	if err := cfgStore.Put(ctx, &accounts.AccountConfig{
		ID: "acct-1", ProviderID: "openai", Enabled: true, Kind: accounts.KindAPIKey,
	}); err != nil {
		t.Fatal(err)
	}
	if err := cfgStore.Put(ctx, &accounts.AccountConfig{
		ID: "acct-disabled", ProviderID: "openai", Enabled: false, Kind: accounts.KindAPIKey,
	}); err != nil {
		t.Fatal(err)
	}
	if err := cfgStore.Put(ctx, &accounts.AccountConfig{
		ID: "acct-other", ProviderID: "other", Enabled: true, Kind: accounts.KindAPIKey,
	}); err != nil {
		t.Fatal(err)
	}
	if err := records.Put(ctx, &accounts.OAuthTokenRecord{
		AccountID:                "acct-1",
		Email:                    "user@example.test",
		ProviderAccountID:        "prov-1",
		OrgID:                    "org-1",
		OrgName:                  "Org",
		ReauthenticationRequired: true,
	}); err != nil {
		t.Fatal(err)
	}

	out, err := (durableAccountStore{store: cfgStore, records: records}).ListAccounts(ctx, "openai")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("accounts=%d, want 1", len(out))
	}
	if out[0].ID != "acct-1" || out[0].Email != "user@example.test" || out[0].ProviderAccountID != "prov-1" ||
		out[0].OrgID != "org-1" || out[0].OrgName != "Org" || !out[0].ReauthRequired {
		t.Fatalf("projected account=%#v", out[0])
	}
}

func TestRegistryCatalogList(t *testing.T) {
	_, err := (registryCatalog{}).List()
	if err == nil || !strings.Contains(err.Error(), "provider catalog has no registry") {
		t.Fatalf("nil registry err=%v", err)
	}

	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	out, err := (registryCatalog{registry: registry}).List()
	if err != nil {
		t.Fatal(err)
	}
	foundAntigravity := false
	for _, account := range out {
		if account.Provider == "antigravity" {
			foundAntigravity = true
			if !account.CredentialRef.IsZero() {
				t.Fatalf("antigravity catalog entry should keep empty credential ref, got %q", account.CredentialRef.String())
			}
			if account.Model == "" || !account.Enabled {
				t.Fatalf("antigravity entry=%#v", account)
			}
		}
	}
	if !foundAntigravity {
		t.Fatal("expected antigravity models in DefaultRegistry catalog")
	}
}

func TestProviderFixtureAccountStoreAntigravity(t *testing.T) {
	registry, err := providerbuiltin.DefaultRegistry()
	if err != nil {
		t.Fatal(err)
	}
	_, err = (providerFixtureAccountStore{registry: registry}).ListAccounts(context.Background(), "antigravity")
	if err == nil || !strings.Contains(err.Error(), "incomplete credential ownership") {
		t.Fatalf("antigravity fixture err=%v", err)
	}

	_, err = (providerFixtureAccountStore{}).ListAccounts(context.Background(), "openai")
	if err == nil || !strings.Contains(err.Error(), "no registry") {
		t.Fatalf("nil registry err=%v", err)
	}
}

func TestProjectDurableAccount(t *testing.T) {
	account, err := projectDurableAccount(nil, nil)
	if err != nil || account != nil {
		t.Fatalf("nil cfg: account=%v err=%v", account, err)
	}
	account, err = projectDurableAccount(&accounts.AccountConfig{ID: "x", ProviderID: "p", Enabled: false, Kind: accounts.KindAPIKey}, nil)
	if err != nil || account != nil {
		t.Fatalf("disabled: account=%v err=%v", account, err)
	}

	account, err = projectDurableAccount(&accounts.AccountConfig{
		ID: "acct-zero", ProviderID: "openai", Enabled: true, Kind: accounts.KindAPIKey,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if account == nil || account.CredentialRef.String() != "acct-zero" || account.Email != "" {
		t.Fatalf("zero-ref account=%#v", account)
	}

	ref, err := accounts.NewReference("acct-rec")
	if err != nil {
		t.Fatal(err)
	}
	account, err = projectDurableAccount(&accounts.AccountConfig{
		ID: "acct-rec", ProviderID: "openai", Enabled: true, Kind: accounts.KindOAuth, CredentialRef: ref,
	}, &accounts.OAuthTokenRecord{
		AccountID: "acct-rec", Email: "rec@example.test", ProviderAccountID: "pa", OrgID: "o", OrgName: "n", ReauthenticationRequired: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if account == nil || account.Email != "rec@example.test" || account.ProviderAccountID != "pa" ||
		account.OrgID != "o" || account.OrgName != "n" || !account.ReauthRequired {
		t.Fatalf("with-record account=%#v", account)
	}
}

func TestAppendExclusionBounds(t *testing.T) {
	appendExclusion(nil, "account", "a", "disabled")

	result := &RouteExplanation{}
	appendExclusion(result, "account", "a1", "disabled")
	if len(result.Exclusions) != 1 || result.Exclusions[0].Kind != "account" || result.Exclusions[0].Reason != "disabled" {
		t.Fatalf("exclusions=%#v", result.Exclusions)
	}
	for i := 0; i < maxDiagnosticExclusions+5; i++ {
		appendExclusion(result, "account", fmt.Sprintf("id-%d", i), "reason")
	}
	if len(result.Exclusions) != maxDiagnosticExclusions {
		t.Fatalf("len=%d want %d", len(result.Exclusions), maxDiagnosticExclusions)
	}
}

func TestValidateDiagnosticProxiesNilPaths(t *testing.T) {
	n, err := validateDiagnosticProxies(context.Background(), &diagnosticSnapshot{})
	if err != nil || n != 0 {
		t.Fatalf("nil database: n=%d err=%v", n, err)
	}
	n, err = validateDiagnosticProxies(context.Background(), &diagnosticSnapshot{database: &db.RuntimeStore{}})
	if err != nil || n != 0 {
		t.Fatalf("nil proxies: n=%d err=%v", n, err)
	}
}
