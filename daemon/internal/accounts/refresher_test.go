package accounts

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testAuthDriver struct {
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
	result  *TokenSet
	err     error
}

func (d *testAuthDriver) Kind() CredentialKind { return KindOAuth }
func (d *testAuthDriver) Start(context.Context, OAuthStartInput) (*OAuthStartResult, error) {
	return nil, errors.New("unused")
}
func (d *testAuthDriver) Poll(context.Context, string) (*OAuthPollResult, error) {
	return nil, errors.New("unused")
}
func (d *testAuthDriver) Exchange(context.Context, OAuthExchangeInput) (*TokenSet, error) {
	return nil, errors.New("unused")
}
func (d *testAuthDriver) Refresh(ctx context.Context, _ RefreshTokenInput) (*TokenSet, error) {
	d.calls.Add(1)
	if d.started != nil {
		select {
		case d.started <- struct{}{}:
		default:
		}
	}
	if d.release != nil {
		select {
		case <-d.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if d.err != nil {
		return nil, d.err
	}
	return d.result.Clone(), nil
}
func (d *testAuthDriver) Revoke(context.Context, RevokeTokenInput) error { return nil }

func TestRefresherCoalescesConcurrentForceRefresh(t *testing.T) {
	driver := &testAuthDriver{started: make(chan struct{}, 1), release: make(chan struct{}), result: &TokenSet{Access: NewSecret([]byte("fresh-access")), Refresh: NewSecret([]byte("fresh-refresh")), ExpiresAt: time.Now().Add(time.Hour)}}
	secrets := NewMemorySecretStore()
	if err := secrets.PutRefresh(context.Background(), "acct", NewSecret([]byte("old-refresh"))); err != nil {
		t.Fatal(err)
	}
	accounts := NewMemoryAccountConfigStore()
	if err := accounts.Put(context.Background(), &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accounts})
	if err != nil {
		t.Fatal(err)
	}
	const callers = 8
	results := make([]*TokenSet, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	wg.Add(callers)
	for i := range callers {
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = refresher.ForceRefresh(context.Background(), "acct")
		}(i)
	}
	<-driver.started
	time.Sleep(50 * time.Millisecond)
	close(driver.release)
	wg.Wait()
	if got := driver.calls.Load(); got != 1 {
		t.Fatalf("refresh calls = %d, want 1", got)
	}
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("caller %d error: %v", i, errs[i])
		}
		if results[i] == nil || string(results[i].Access.Reveal()) != "fresh-access" {
			t.Fatalf("caller %d did not receive fresh token", i)
		}
		results[i].Close()
	}
	if got := refresher.PendingLen(); got != 0 {
		t.Fatalf("pending leases = %d, want 0", got)
	}
}

func TestRefresherCallerCancellationDoesNotStrandLease(t *testing.T) {
	driver := &testAuthDriver{started: make(chan struct{}, 1), release: make(chan struct{}), result: &TokenSet{Access: NewSecret([]byte("fresh-access")), ExpiresAt: time.Now().Add(time.Hour)}}
	secrets := NewMemorySecretStore()
	_ = secrets.PutRefresh(context.Background(), "acct", NewSecret([]byte("old-refresh")))
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(context.Background(), &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth})
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accounts})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, callErr := refresher.ForceRefresh(ctx, "acct"); done <- callErr }()
	<-driver.started
	cancel()
	select {
	case callErr := <-done:
		if !errors.Is(callErr, context.Canceled) {
			t.Fatalf("error = %v, want cancellation", callErr)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled caller remained blocked")
	}
	close(driver.release)
	deadline := time.Now().Add(time.Second)
	for refresher.PendingLen() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := refresher.PendingLen(); got != 0 {
		t.Fatalf("pending leases = %d, want 0", got)
	}
}

func TestRefresherRefreshFailureIsTypedAndRedacted(t *testing.T) {
	driver := &testAuthDriver{err: errors.New("refresh-token=super-secret")}
	secrets := NewMemorySecretStore()
	_ = secrets.PutRefresh(context.Background(), "acct", NewSecret([]byte("old-refresh")))
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(context.Background(), &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth})
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accounts, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refresher.ForceRefresh(context.Background(), "acct")
	if err == nil {
		t.Fatal("ForceRefresh returned nil error")
	}
	if Classify(err) != ErrKindRefreshFatal {
		t.Fatalf("error kind = %q, want %q", Classify(err), ErrKindRefreshFatal)
	}
	if got := err.Error(); got == "" || strings.Contains(got, "super-secret") {
		t.Fatalf("error leaked secret: %q", got)
	}
}

func TestRefresherRetainsOmittedRefreshAndMetadata(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth})
	secrets := NewMemorySecretStore()
	_ = secrets.PutAccess(ctx, "acct", NewSecretFromString("old-access"))
	_ = secrets.PutRefresh(ctx, "acct", NewSecretFromString("old-refresh"))
	records := NewMemoryRecordStore()
	_ = records.Put(ctx, &OAuthTokenRecord{AccountID: "acct", ProviderID: "provider", Kind: KindOAuth, OrgID: "org-1", OrgName: "Workspace", Version: 0})
	driver := &testAuthDriver{result: &TokenSet{Access: NewSecretFromString("new-access"), ExpiresAt: time.Now().Add(time.Hour)}}
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: records, Accounts: accounts, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := refresher.ForceRefresh(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	refresh, err := secrets.GetRefresh(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	if got := refresh.RevealString(); got != "old-refresh" {
		t.Fatalf("refresh token = %q, want retained prior token", got)
	}
	refresh.Close()
	record, err := records.Get(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	if record.OrgID != "org-1" || record.OrgName != "Workspace" {
		t.Fatalf("identity metadata lost during refresh: %#v", record)
	}
}

func TestRefresherMissingRefreshRequiresReauthentication(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth})
	secrets := NewMemorySecretStore()
	_ = secrets.PutAccess(ctx, "acct", NewSecretFromString("expired-access"))
	records := NewMemoryRecordStore()
	_ = records.Put(ctx, &OAuthTokenRecord{AccountID: "acct", ProviderID: "provider", Kind: KindOAuth, ExpiresAt: time.Now().Add(-time.Minute), Version: 0})
	driver := &testAuthDriver{result: &TokenSet{Access: NewSecretFromString("unexpected")}}
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: records, Accounts: accounts})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refresher.Current(ctx, "acct")
	if !errors.Is(err, ErrReauthenticationRequired) {
		t.Fatalf("error = %v, want reauthentication", err)
	}
	if got := driver.calls.Load(); got != 0 {
		t.Fatalf("refresh calls = %d, want no refresh without token", got)
	}
	marked, getErr := records.Get(ctx, "acct")
	if getErr != nil {
		t.Fatal(getErr)
	}
	if !marked.ReauthenticationRequired {
		t.Fatal("expired credential was not marked for reauthentication")
	}
}

func TestAccessOnlyNeverRefreshesAndRequiresReauthenticationOnExpiry(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "kimchi", Kind: KindAccessOnly})
	secrets := NewMemorySecretStore()
	_ = secrets.PutAccess(ctx, "acct", NewSecretFromString("access-only"))
	records := NewMemoryRecordStore()
	_ = records.Put(ctx, &OAuthTokenRecord{AccountID: "acct", ProviderID: "kimchi", Kind: KindAccessOnly, ExpiresAt: time.Now().Add(-time.Minute), Version: 0})
	driver := &testAuthDriver{result: &TokenSet{Access: NewSecretFromString("must-not-use")}}
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: records, Accounts: accounts})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refresher.Current(ctx, "acct")
	if !errors.Is(err, ErrReauthenticationRequired) {
		t.Fatalf("error = %v, want reauthentication", err)
	}
	if got := driver.calls.Load(); got != 0 {
		t.Fatalf("refresh calls = %d, want access-only no refresh", got)
	}
}

func TestRefresherCASLossDoesNotOverwritePeerState(t *testing.T) {
	ctx := context.Background()
	accounts := NewMemoryAccountConfigStore()
	_ = accounts.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "provider", Kind: KindOAuth})
	secrets := NewMemorySecretStore()
	_ = secrets.PutAccess(ctx, "acct", NewSecretFromString("peer-access"))
	_ = secrets.PutRefresh(ctx, "acct", NewSecretFromString("peer-refresh"))
	records := NewMemoryRecordStore()
	_ = records.Put(ctx, &OAuthTokenRecord{AccountID: "acct", ProviderID: "provider", Kind: KindOAuth, Version: 0})
	driver := &testAuthDriver{started: make(chan struct{}, 1), release: make(chan struct{}), result: &TokenSet{Access: NewSecretFromString("stale-access"), Refresh: NewSecretFromString("stale-refresh")}}
	refresher, err := NewInMemoryRefresher(RefresherOptions{Driver: driver, Secrets: secrets, Records: records, Accounts: accounts, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan *TokenSet, 1)
	errCh := make(chan error, 1)
	go func() {
		token, refreshErr := refresher.ForceRefresh(ctx, "acct")
		resultCh <- token
		errCh <- refreshErr
	}()
	<-driver.started
	_ = records.Put(ctx, &OAuthTokenRecord{AccountID: "acct", ProviderID: "provider", Kind: KindOAuth, AccessFingerprint: "peer-generation", Version: 1})
	close(driver.release)
	token := <-resultCh
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	if got := token.Access.RevealString(); got != "peer-access" {
		t.Fatalf("CAS-losing refresh returned %q, want peer state", got)
	}
	access, err := secrets.GetAccess(ctx, "acct")
	if err != nil {
		t.Fatal(err)
	}
	defer access.Close()
	if got := access.RevealString(); got != "peer-access" {
		t.Fatalf("stale refresh overwrote access secret: %q", got)
	}
}

func TestRefresherSelectsDriverByProvider(t *testing.T) {
	ctx := context.Background()
	accountStore := NewMemoryAccountConfigStore()
	for _, cfg := range []*AccountConfig{
		{ID: "acct-a", ProviderID: "provider-a", Kind: KindOAuth},
		{ID: "acct-b", ProviderID: "provider-b", Kind: KindOAuth},
	} {
		if err := accountStore.Put(ctx, cfg); err != nil {
			t.Fatal(err)
		}
	}
	secrets := NewMemorySecretStore()
	for _, id := range []string{"acct-a", "acct-b"} {
		if err := secrets.PutRefresh(ctx, id, NewSecretFromString("refresh-"+id)); err != nil {
			t.Fatal(err)
		}
	}
	first := &testAuthDriver{result: &TokenSet{Access: NewSecretFromString("access-a"), ExpiresAt: time.Now().Add(time.Hour)}}
	second := &testAuthDriver{result: &TokenSet{Access: NewSecretFromString("access-b"), ExpiresAt: time.Now().Add(time.Hour)}}
	refresher, err := NewInMemoryRefresher(RefresherOptions{
		DriverResolver: func(providerID string) (AuthDriver, bool) {
			switch providerID {
			case "provider-a":
				return first, true
			case "provider-b":
				return second, true
			default:
				return nil, false
			}
		},
		Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accountStore, MaxAttempts: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	gotA, err := refresher.ForceRefresh(ctx, "acct-a")
	if err != nil {
		t.Fatal(err)
	}
	defer gotA.Close()
	gotB, err := refresher.ForceRefresh(ctx, "acct-b")
	if err != nil {
		t.Fatal(err)
	}
	defer gotB.Close()
	if got := gotA.Access.RevealString(); got != "access-a" {
		t.Fatalf("provider-a access = %q", got)
	}
	if got := gotB.Access.RevealString(); got != "access-b" {
		t.Fatalf("provider-b access = %q", got)
	}
	if first.calls.Load() != 1 || second.calls.Load() != 1 {
		t.Fatalf("driver calls = %d/%d, want 1/1", first.calls.Load(), second.calls.Load())
	}
}

func TestRefresherMissingProviderDriverFailsClosed(t *testing.T) {
	ctx := context.Background()
	accountStore := NewMemoryAccountConfigStore()
	if err := accountStore.Put(ctx, &AccountConfig{ID: "acct", ProviderID: "unregistered", Kind: KindOAuth}); err != nil {
		t.Fatal(err)
	}
	secrets := NewMemorySecretStore()
	if err := secrets.PutRefresh(ctx, "acct", NewSecretFromString("refresh")); err != nil {
		t.Fatal(err)
	}
	refresher, err := NewInMemoryRefresher(RefresherOptions{DriverResolver: func(string) (AuthDriver, bool) { return nil, false }, Secrets: secrets, Records: NewMemoryRecordStore(), Accounts: accountStore, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refresher.ForceRefresh(ctx, "acct")
	if Classify(err) != ErrKindRefreshFatal {
		t.Fatalf("missing provider driver error = %q, want %q", Classify(err), ErrKindRefreshFatal)
	}
}
